import { useEffect, useMemo, useRef, useState } from "react";

import { createClient } from "@supabase/supabase-js";

/**
 * Kids Calendar (Month Grid) - dependency-free.
 * Enhancements:
 * 1) Rename/Delete tags (and propagate changes everywhere).
 * 2) Events support Start Date + End Date.
 * 3) Kid tag filter ("ตัวกรอง") that matches ALL selected tags.
 * 4) Event detail shows ⚠️ if there are new kids with matchScore > 1 not yet suggested/assigned.
 */

// ---- Supabase (minimal persistence) ----
// Stores only app data (tagCatalog, kids, events) into table: public.app_state (id = "default").
// This is intentionally minimal to avoid touching existing UI/business logic.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase =
  SUPABASE_URL && SUPABASE_ANON_KEY
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

// ------------------ tiny utils ------------------
const pad2 = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const hm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

// Revive Date objects inside events loaded from JSON (Supabase jsonb stores Dates as ISO strings)
function reviveEvents(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((ev) => {
    if (!ev || typeof ev !== "object") return ev;
    const start = ev.start instanceof Date ? ev.start : ev.start ? new Date(ev.start) : ev.start;
    const end = ev.end instanceof Date ? ev.end : ev.end ? new Date(ev.end) : ev.end;
    return { ...ev, start, end };
  });
}


function combineDateTime(dateStr, timeStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}
function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function addMonths(d, n) {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}
function startOfWeekMonday(d) {
  const day = d.getDay(); // 0=Sun
  const diff = (day + 6) % 7; // Mon=>0 ... Sun=>6
  const out = new Date(d);
  out.setDate(d.getDate() - diff);
  out.setHours(0, 0, 0, 0);
  return out;
}
function atStartOfDay(d) {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}
function addDays(d, n) {
  const out = new Date(d);
  out.setDate(d.getDate() + n);
  return out;
}
function clampStr(s) {
  return (s ?? "").toString().trim();
}
function intersectionCount(a = [], bSet) {
  let c = 0;
  for (const t of a) if (bSet.has(t)) c++;
  return c;
}

// ------------------ UI bits ------------------
function Modal({ title, onClose, children, width = 840, zIndex = 999 }) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.35)",
        display: "grid",
        placeItems: "center",
        zIndex: zIndex,
        padding: 16,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: `min(95vw, ${width}px)`,
          background: "#fff",
          borderRadius: 16,
          border: "1px solid #eee",
          boxShadow: "0 10px 30px rgba(0,0,0,0.18)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: 14,
            borderBottom: "1px solid #eee",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <div style={{ fontWeight: 900, flex: 1 }}>{title}</div>
          <button
            onClick={onClose}
            style={{
              border: "1px solid #eee",
              background: "#fff",
              padding: "8px 10px",
              borderRadius: 12,
              cursor: "pointer",
            }}
          >
            ปิด
          </button>
        </div>
        <div style={{ padding: 14, maxHeight: "80vh", overflowY: "auto" }}>{children}</div>
      </div>
    </div>
  );
}

function TagPill({ text }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 999,
        border: "1px solid #e5e5e5",
        background: "#f5f5f5",
        fontSize: 12,
        lineHeight: "18px",
      }}
    >
      {text}
    </span>
  );
}

function StatusChip({ label, status, onClick }) {
  const bg = status === 0 ? "#fff3bf" : status === 1 ? "#d0ebff" : "#d3f9d8";
  const bd = status === 0 ? "#ffe066" : status === 1 ? "#74c0fc" : "#69db7c";
  return (
    <button
      onClick={onClick}
      title="กดเพื่อวนสถานะ: เหลือง→ฟ้า→เขียว"
      style={{
        border: `1px solid ${bd}`,
        background: bg,
        padding: "6px 10px",
        borderRadius: 999,
        cursor: "pointer",
        fontSize: 13,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}

function IconButton({ children, title, onClick, danger = false }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        border: "1px solid #eee",
        background: danger ? "#fff5f5" : "#fff",
        padding: "6px 8px",
        borderRadius: 10,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

/**
 * Tag picker with:
 * - selection (multi)
 * - create category/tag (optional)
 * - rename/delete tag (optional via callbacks)
 */
function TagPickerModal({
  open,
  title,
  tagCatalog,
  setTagCatalog,
  selectedTags,
  setSelectedTags,
  onCancel,
  onSave,
  saveLabel = "บันทึก",
  allowEditLibrary = true,
  onRenameTag,
  onDeleteTag,
}) {
  const categories = Object.keys(tagCatalog);
  const [activeCategory, setActiveCategory] = useState(categories[0] ?? "ทั่วไป");
  const [newCategory, setNewCategory] = useState("");
  const [newTag, setNewTag] = useState("");

  if (!open) return null;

  const canSelect = Array.isArray(selectedTags) && typeof setSelectedTags === "function";
  const toggleTag = (t) => {
    if (!canSelect) return;
    setSelectedTags((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  };

  const addCategory = () => {
    if (!allowEditLibrary) return;
    const c = clampStr(newCategory);
    if (!c) return;
    setTagCatalog((prev) => (prev[c] ? prev : { ...prev, [c]: [] }));
    setActiveCategory(c);
    setNewCategory("");
  };

  const addTagToCategory = () => {
    if (!allowEditLibrary) return;
    const c = activeCategory;
    const t = clampStr(newTag);
    if (!c || !t) return;
    setTagCatalog((prev) => {
      const list = prev[c] ?? [];
      if (list.includes(t)) return prev;
      return { ...prev, [c]: [...list, t] };
    });
    if (canSelect) setSelectedTags((prev) => (prev.includes(t) ? prev : [...prev, t]));
    setNewTag("");
  };

  const askRenameTag = (tag) => {
    if (!allowEditLibrary || !onRenameTag) return;
    const next = prompt(`แก้ไขชื่อ Tag: "${tag}"`, tag);
    if (next === null) return;
    const t = clampStr(next);
    if (!t || t === tag) return;
    onRenameTag(activeCategory, tag, t);
  };

  const askDeleteTag = (tag) => {
    if (!allowEditLibrary || !onDeleteTag) return;
    if (!confirm(`ลบ Tag "${tag}" ในหมวด “${activeCategory}”?`)) return;
    onDeleteTag(activeCategory, tag);
  };

  return (
    <Modal title={title} onClose={onCancel} width={940} zIndex={2000}>
      <div style={{ display: "flex", gap: 14, alignItems: "stretch" }}>
        <div style={{ width: 260, borderRight: "1px solid #eee", paddingRight: 14 }}>
          <div style={{ fontWeight: 900, marginBottom: 10 }}>หมวด</div>

          <div style={{ display: "grid", gap: 8 }}>
            {categories.map((c) => (
              <button
                key={c}
                onClick={() => setActiveCategory(c)}
                style={{
                  textAlign: "left",
                  padding: 10,
                  borderRadius: 12,
                  border: activeCategory === c ? "2px solid #1a73e8" : "1px solid #eee",
                  background: "#fff",
                  cursor: "pointer",
                }}
              >
                {c}
              </button>
            ))}
          </div>

          <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #eee" }}>
            <div style={{ fontWeight: 800, marginBottom: 8 }}>+ เพิ่มหมวด</div>
            <input
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              placeholder="ชื่อหมวด..."
              disabled={!allowEditLibrary}
              style={{
                width: "100%",
                padding: 10,
                borderRadius: 12,
                border: "1px solid #ddd",
                opacity: allowEditLibrary ? 1 : 0.6,
              }}
              onKeyDown={(e) => e.key === "Enter" && addCategory()}
            />
            <button
              onClick={addCategory}
              disabled={!allowEditLibrary}
              style={{
                marginTop: 8,
                padding: "8px 10px",
                borderRadius: 12,
                border: "1px solid #ddd",
                background: "#fff",
                cursor: allowEditLibrary ? "pointer" : "not-allowed",
                opacity: allowEditLibrary ? 1 : 0.6,
              }}
            >
              เพิ่มหมวด
            </button>
          </div>
        </div>

        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ fontWeight: 900, flex: 1 }}>{activeCategory}</div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>
              {canSelect ? "คลิกเพื่อเลือก/ยกเลิก (เลือกได้หลายแท็ก)" : "จัดการแท็ก"}
            </div>
          </div>

          {/* Tag list */}
          <div style={{ marginTop: 10, display: "grid", gap: 8, maxHeight: "70vh", overflowY: "auto" }}>
            {(tagCatalog[activeCategory] ?? []).length === 0 ? (
              <div style={{ opacity: 0.7 }}>หมวดนี้ยังไม่มี tag</div>
            ) : (
              (tagCatalog[activeCategory] ?? []).map((t) => {
                const active = canSelect ? selectedTags.includes(t) : false;
                return (
                  <div
                    key={t}
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "center",
                      padding: 10,
                      borderRadius: 12,
                      border: active ? "2px solid #1a73e8" : "1px solid #eee",
                      background: active ? "#e7f5ff" : "#fff",
                    }}
                  >
                    <button
                      onClick={() => toggleTag(t)}
                      style={{
                        border: "none",
                        background: "transparent",
                        cursor: canSelect ? "pointer" : "default",
                        textAlign: "left",
                        padding: 0,
                        flex: 1,
                        fontSize: 13,
                        fontWeight: 800,
                      }}
                      title={canSelect ? "คลิกเพื่อเลือก/ยกเลิก" : ""}
                    >
                      {t}
                    </button>

                    {allowEditLibrary ? (
                      <div style={{ display: "flex", gap: 6 }}>
                        <IconButton title="แก้ชื่อ tag" onClick={() => askRenameTag(t)}>
                          ✏️
                        </IconButton>
                        <IconButton title="ลบ tag" onClick={() => askDeleteTag(t)} danger>
                          🗑️
                        </IconButton>
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>

          {/* Add tag */}
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid #eee" }}>
            <div style={{ fontWeight: 800, marginBottom: 8 }}>
              + เพิ่ม tag ในหมวด “{activeCategory}”
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                placeholder="ชื่อ tag..."
                disabled={!allowEditLibrary}
                style={{
                  flex: 1,
                  padding: 10,
                  borderRadius: 12,
                  border: "1px solid #ddd",
                  opacity: allowEditLibrary ? 1 : 0.6,
                }}
                onKeyDown={(e) => e.key === "Enter" && addTagToCategory()}
              />
              <button
                onClick={addTagToCategory}
                disabled={!allowEditLibrary}
                style={{
                  padding: "10px 12px",
                  borderRadius: 12,
                  border: "1px solid #ddd",
                  background: "#fff",
                  cursor: allowEditLibrary ? "pointer" : "not-allowed",
                  opacity: allowEditLibrary ? 1 : 0.6,
                }}
              >
                เพิ่ม tag
              </button>
            </div>
          </div>

          {/* Selected */}
          {canSelect ? (
            <div style={{ marginTop: 14, maxHeight: "70vh", overflowY: "auto" }}>
              <div style={{ fontWeight: 800, marginBottom: 8 }}>แท็กที่เลือก</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {selectedTags.length === 0 ? (
                  <div style={{ opacity: 0.7 }}>(ยังไม่ได้เลือก)</div>
                ) : (
                  selectedTags.map((t) => <TagPill key={t} text={t} />)
                )}
              </div>

              <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button
                  onClick={() => setSelectedTags([])}
                  style={{
                    padding: "8px 10px",
                    borderRadius: 12,
                    border: "1px solid #ddd",
                    background: "#fff",
                    cursor: "pointer",
                  }}
                >
                  ล้างทั้งหมด
                </button>
                <button
                  onClick={onSave}
                  style={{
                    padding: "8px 10px",
                    borderRadius: 12,
                    border: "1px solid #1a73e8",
                    background: "#1a73e8",
                    color: "#fff",
                    cursor: "pointer",
                  }}
                >
                  {saveLabel}
                </button>
              </div>
            </div>
          ) : (
            <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end" }}>
              <button
                onClick={onSave}
                style={{
                  padding: "8px 10px",
                  borderRadius: 12,
                  border: "1px solid #ddd",
                  background: "#fff",
                  cursor: "pointer",
                }}
              >
                ปิด
              </button>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ------------------ Calendar (month grid) ------------------
function MonthCalendar({ cursor, setCursor, events, onPickDay, onOpenEvent, attentionById, onOpenListView }) {
  const monthStart = startOfMonth(cursor);
  const gridStart = startOfWeekMonday(monthStart);

  const days = useMemo(() => {
    const arr = [];
    for (let i = 0; i < 42; i++) arr.push(addDays(gridStart, i));
    return arr;
  }, [gridStart]);

  const eventsByDay = useMemo(() => {
    const m = new Map();
    for (const ev of events) {
      const s = atStartOfDay(ev.start);
      const e = atStartOfDay(ev.end);
      // include all days touched by the event
      for (let d = new Date(s); d <= e; d = addDays(d, 1)) {
        const key = ymd(d);
        if (!m.has(key)) m.set(key, []);
        m.get(key).push(ev);
      }
    }
    for (const [k, list] of m.entries()) {
      list.sort((a, b) => a.start - b.start);
      m.set(k, list);
    }
    return m;
  }, [events]);

  const monthLabel = useMemo(() => {
    const y = cursor.getFullYear();
    const m = cursor.getMonth() + 1;
    return `${y}-${pad2(m)}`;
  }, [cursor]);

  const goPrev = () => setCursor((c) => addMonths(c, -1));
  const goNext = () => setCursor((c) => addMonths(c, 1));
  const goToday = () => setCursor(startOfMonth(new Date()));
  const dow = ["จ", "อ", "พ", "พฤ", "ศ", "ส", "อา"];

  return (
    <div
      style={{
        border: "1px solid #eee",
        borderRadius: 16,
        background: "#fff",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: 12,
          borderBottom: "1px solid #eee",
          display: "flex",
          gap: 8,
          alignItems: "center",
        }}
      >
        <div style={{ fontWeight: 900, fontSize: 16, flex: 1 }}>Calendar {monthLabel}</div>
        <button onClick={goPrev} style={{ padding: "8px 10px", borderRadius: 12, border: "1px solid #ddd", background: "#fff", cursor: "pointer" }}>
          ◀
        </button>
        <button onClick={goToday} style={{ padding: "8px 10px", borderRadius: 12, border: "1px solid #ddd", background: "#fff", cursor: "pointer" }}>
          วันนี้
        </button>
        <button onClick={goNext} style={{ padding: "8px 10px", borderRadius: 12, border: "1px solid #ddd", background: "#fff", cursor: "pointer" }}>
          ▶
        </button>
        <button onClick={() => onOpenListView?.()} style={{ padding: "8px 10px", borderRadius: 12, border: "1px solid #ddd", background: "#fff", cursor: "pointer" }}>
          List View
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", borderBottom: "1px solid #eee" }}>
        {dow.map((d) => (
          <div key={d} style={{ padding: "8px 10px", fontWeight: 800, fontSize: 12, opacity: 0.8 }}>
            {d}
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)" }}>
        {days.map((d) => {
          const inMonth = d.getMonth() === cursor.getMonth();
          const key = ymd(d);
          const list = eventsByDay.get(key) ?? [];
          const isToday = sameDay(d, new Date());

          return (
            <div
              key={key}
              style={{
                minHeight: 110,
                borderRight: "1px solid #f0f0f0",
                borderBottom: "1px solid #f0f0f0",
                padding: 8,
                background: inMonth ? "#fff" : "#fafafa",
              }}
              onDoubleClick={() => onPickDay(d)}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div
                  onClick={() => onPickDay(d)}
                  style={{
                    fontWeight: 900,
                    width: 28,
                    height: 28,
                    display: "grid",
                    placeItems: "center",
                    borderRadius: 999,
                    border: isToday ? "2px solid #1a73e8" : "1px solid transparent",
                    cursor: "pointer",
                  }}
                  title="คลิกเพื่อเตรียมสร้างกิจกรรมในวันนี้"
                >
                  {d.getDate()}
                </div>
                {!inMonth ? <div style={{ fontSize: 11, opacity: 0.5 }}>({d.getMonth() + 1})</div> : null}
              </div>

              <div style={{ marginTop: 6, display: "grid", gap: 6 }}>
                {list.slice(0, 4).map((ev) => {
                  const unassigned = (ev.participants?.length ?? 0) === 0;
                  const needsAttention = ((attentionById?.[ev.id] ?? 0) > 0);
                  const isStart = sameDay(d, ev.start);
                  const timeLabel = isStart ? hm(ev.start) : "↔";
                  return (
                    <button
                      key={`${ev.id}-${key}`}
                      onClick={() => onOpenEvent(ev.id)}
                      style={{
                        textAlign: "left",
                        border: "1px solid #eee",
                        background: needsAttention ? "#fff4e6" : "#e7f5ff",
                        padding: "6px 8px",
                        borderRadius: 12,
                        cursor: "pointer",
                        fontSize: 12,
                        lineHeight: "16px",
                      }}
                      title="คลิกเพื่อดูรายละเอียดกิจกรรม"
                    >
                      <div style={{ fontWeight: 900 }}>
                        {needsAttention ? "⚠️ " : ""}
                        {timeLabel} {ev.title}
                      </div>
                    </button>
                  );
                })}
                {list.length > 4 ? <div style={{ fontSize: 11, opacity: 0.65 }}>+ {list.length - 4} more</div> : null}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ padding: 10, fontSize: 12, opacity: 0.7, borderTop: "1px solid #eee" }}>
        Tips: คลิกเลขวันเพื่อเติมวันที่ในฟอร์ม • ดับเบิลคลิกช่องวันเพื่อสร้างกิจกรรมเร็ว ๆ • คลิกกิจกรรมเพื่อดูรายละเอียด
      </div>
    </div>
  );
}

// ------------------ App ------------------
export default function App() {
  // Tag Library
  const [tagCatalog, setTagCatalog] = useState({
    มหาวิทยาลัย: ["วิศวะ", "บริหาร", "สถาปัตย์", "แพทย์"],
    จังหวัด: ["กรุงเทพ", "เชียงใหม่", "ขอนแก่น"],
    รูปแบบ: ["online", "onsite"],
    งบประมาณ: ["เงินน้อย", "เงินมาก"],
  });

  // Kids
  const [kids, setKids] = useState([]);
  const [visible, setVisible] = useState({}); // kidId -> boolean
  const [kidSearch, setKidSearch] = useState("");

  // NEW: tag filter (match all)
  const [kidFilterTags, setKidFilterTags] = useState([]);
  const [openKidFilter, setOpenKidFilter] = useState(false);

  const [newKidName, setNewKidName] = useState("");
  const [newKidTags, setNewKidTags] = useState([]);
  const [openNewKidTagPicker, setOpenNewKidTagPicker] = useState(false);

  const [openEditKidTagPicker, setOpenEditKidTagPicker] = useState(false);
  const [editKidId, setEditKidId] = useState(null);
  const [editKidTags, setEditKidTags] = useState([]);

  const kidById = useMemo(() => {
    const m = new Map();
    for (const k of kids) m.set(k.id, k);
    return m;
  }, [kids]);

  // Events
  // { id, title, start: Date, end: Date, tags: string[], participants: [{kidId,status}] }
  const [events, setEvents] = useState([]);

  // List View (modal)
  const [openListView, setOpenListView] = useState(false);
  const [listFilterTags, setListFilterTags] = useState([]);
  const [openListFilterTagPicker, setOpenListFilterTagPicker] = useState(false);
  const [listSearch, setListSearch] = useState("");
  const [listFromDate, setListFromDate] = useState("");
  const [listToDate, setListToDate] = useState("");
  const [listNowEpoch, setListNowEpoch] = useState(Date.now());

  // ---- Supabase persistence (load once, then auto-save on data changes) ----
  const hydratedRef = useRef(false);
  const saveTimerRef = useRef(null);
  const [appVersion, setAppVersion] = useState(null);
  const appVersionRef = useRef(null);

  // Load saved state from Supabase on first mount (if configured)
  useEffect(() => {
    let cancelled = false;

    const hydrate = async () => {
      if (!supabase) {
        hydratedRef.current = true;
        return;
      }

      const { data, error } = await supabase
        .from("app_state")
        .select("data,version")
        .eq("id", "default")
        .maybeSingle();

      if (!cancelled) {
        if (!error) {
          const remoteVersion = typeof data?.version === "number" ? data.version : 0;
          appVersionRef.current = remoteVersion;
          setAppVersion(remoteVersion);

          if (data?.data) {
            const payload = data.data;
            if (payload.tagCatalog) setTagCatalog(payload.tagCatalog);
            if (Array.isArray(payload.kids)) setKids(payload.kids);
            if (Array.isArray(payload.events)) setEvents(reviveEvents(payload.events));
          } else {
            // No row yet — create default state once so future updates can use optimistic locking.
            await supabase.from("app_state").insert([
              { id: "default", data: { tagCatalog: {}, kids: [], events: [] }, version: 0, updated_at: new Date().toISOString() },
            ]);
            appVersionRef.current = 0;
            setAppVersion(0);
          }
        }
        hydratedRef.current = true;
      }
    };

    hydrate();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-save whenever core app data changes
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (!supabase) return;

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);

    saveTimerRef.current = setTimeout(async () => {
      try {
        const payload = { tagCatalog, kids, events };
        const currentVersion = typeof appVersionRef.current === "number" ? appVersionRef.current : 0;
        const nextVersion = currentVersion + 1;

        // Optimistic locking: only update if the version hasn't changed since last load/save.
        const { data: updatedRow, error: updateErr } = await supabase
          .from("app_state")
          .update({ data: payload, version: nextVersion, updated_at: new Date().toISOString() })
          .eq("id", "default")
          .eq("version", currentVersion)
          .select("version,data")
          .maybeSingle();

        if (updateErr) throw updateErr;

        if (!updatedRow) {
          // Someone else saved first. Reload latest state and avoid overwriting silently.
          const { data: latest, error: latestErr } = await supabase
            .from("app_state")
            .select("data,version")
            .eq("id", "default")
            .maybeSingle();

          if (!latestErr && latest?.data) {
            const p = latest.data;
            if (p.tagCatalog) setTagCatalog(p.tagCatalog);
            if (Array.isArray(p.kids)) setKids(p.kids);
            if (Array.isArray(p.events)) setEvents(reviveEvents(p.events));
            const v = typeof latest?.version === "number" ? latest.version : 0;
            appVersionRef.current = v;
            setAppVersion(v);
          }

          alert("มีการแก้ไขจากคนอื่นก่อนหน้า ระบบโหลดข้อมูลล่าสุดแล้ว (การแก้ไขของคุณรอบนี้ยังไม่ได้บันทึก).");
          return;
        }

        appVersionRef.current = updatedRow.version;
        setAppVersion(updatedRow.version);
      } catch (e) {
        // keep UI responsive even if save fails
        console.error("Supabase save failed:", e);
      }
    }, 300);

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [tagCatalog, kids, events]);

  // Calendar cursor
  const [calCursor, setCalCursor] = useState(startOfMonth(new Date()));

  // Event create form (UPDATED: start/end date)
  const today = ymd(new Date());
  const [evTitle, setEvTitle] = useState("");
  const [evStartDate, setEvStartDate] = useState(today);
  const [evEndDate, setEvEndDate] = useState(today);
  const [evStartTime, setEvStartTime] = useState("09:00");
  const [evEndTime, setEvEndTime] = useState("10:00");
  const [evTags, setEvTags] = useState([]);
  const [openEvTagPicker, setOpenEvTagPicker] = useState(false);
  const [evSignupUrl, setEvSignupUrl] = useState("");

  // Modals
  const [openTagLibrary, setOpenTagLibrary] = useState(false);

  const [activeEventIdForDetail, setActiveEventIdForDetail] = useState(null);

  const [activeEventIdForSuggest, setActiveEventIdForSuggest] = useState(null);
  const [suggestSearch, setSuggestSearch] = useState("");
  const [suggestSelection, setSuggestSelection] = useState({}); // kidId -> bool

  const [openEditEventTagPicker, setOpenEditEventTagPicker] = useState(false);
  const [editEventId, setEditEventId] = useState(null);
  const [editEventTags, setEditEventTags] = useState([]);

  const [openEditEventInfo, setOpenEditEventInfo] = useState(false);
  const [editInfoEventId, setEditInfoEventId] = useState(null);
  const [editTitle, setEditTitle] = useState("");
  const [editStartDate, setEditStartDate] = useState("");
  const [editEndDate, setEditEndDate] = useState("");
  const [editStartTime, setEditStartTime] = useState("");
  const [editEndTime, setEditEndTime] = useState("");
  const [editSignupUrl, setEditSignupUrl] = useState("");

  // ---------- Tag rename/delete propagation ----------
  const renameTagEverywhere = (oldTag, newTag) => {
    const o = clampStr(oldTag);
    const n = clampStr(newTag);
    if (!o || !n || o === n) return;

    setTagCatalog((prev) => {
      const next = {};
      for (const [cat, list] of Object.entries(prev)) {
        next[cat] = (list ?? []).map((t) => (t === o ? n : t));
        // dedupe
        next[cat] = Array.from(new Set(next[cat]));
      }
      return next;
    });

    const replaceIn = (arr) => (arr ?? []).map((t) => (t === o ? n : t));

    setKids((prev) => prev.map((k) => ({ ...k, tags: Array.from(new Set(replaceIn(k.tags))) })));
    setEvents((prev) => prev.map((e) => ({ ...e, tags: Array.from(new Set(replaceIn(e.tags))) })));

    setKidFilterTags((prev) => Array.from(new Set(replaceIn(prev))));
    setNewKidTags((prev) => Array.from(new Set(replaceIn(prev))));
    setEditKidTags((prev) => Array.from(new Set(replaceIn(prev))));
    setEvTags((prev) => Array.from(new Set(replaceIn(prev))));
    setEditEventTags((prev) => Array.from(new Set(replaceIn(prev))));
  };

  const deleteTagEverywhere = (tag) => {
    const t = clampStr(tag);
    if (!t) return;

    setTagCatalog((prev) => {
      const next = {};
      for (const [cat, list] of Object.entries(prev)) {
        next[cat] = (list ?? []).filter((x) => x !== t);
      }
      return next;
    });

    const removeFrom = (arr) => (arr ?? []).filter((x) => x !== t);

    setKids((prev) => prev.map((k) => ({ ...k, tags: removeFrom(k.tags) })));
    setEvents((prev) => prev.map((e) => ({ ...e, tags: removeFrom(e.tags) })));

    setKidFilterTags((prev) => removeFrom(prev));
    setNewKidTags((prev) => removeFrom(prev));
    setEditKidTags((prev) => removeFrom(prev));
    setEvTags((prev) => removeFrom(prev));
    setEditEventTags((prev) => removeFrom(prev));
  };

  // Scoped rename/delete: only affects tagCatalog within a single category (does NOT propagate to kids/events).
  const renameTagInCategory = (category, oldTag, newTag) => {
    const cat = clampStr(category);
    const o = clampStr(oldTag);
    const n = clampStr(newTag);
    if (!cat || !o || !n || o === n) return;
    setTagCatalog((prev) => {
      const list = prev[cat] ?? [];
      const nextList = Array.from(new Set(list.map((t) => (t === o ? n : t))));
      return { ...prev, [cat]: nextList };
    });
  };

  const deleteTagInCategory = (category, tag) => {
    const cat = clampStr(category);
    const t = clampStr(tag);
    if (!cat || !t) return;
    setTagCatalog((prev) => {
      const list = prev[cat] ?? [];
      const nextList = list.filter((x) => x !== t);
      return { ...prev, [cat]: nextList };
    });
  };

  // ---------- kids actions ----------
  const addKid = () => {
    const name = clampStr(newKidName);
    if (!name) return;
    const id = crypto.randomUUID();
    const kid = { id, name, tags: newKidTags, createdAt: Date.now() };
    setKids((prev) => [...prev, kid]);
    setVisible((prev) => ({ ...prev, [id]: true }));
    setNewKidName("");
    setNewKidTags([]);
  };

  const renameKid = (kidId) => {
    const kid = kidById.get(kidId);
    if (!kid) return;
    const next = prompt("แก้ชื่อเด็ก:", kid.name);
    if (next === null) return;
    const t = clampStr(next);
    if (!t) return;
    setKids((prev) => prev.map((k) => (k.id === kidId ? { ...k, name: t } : k)));
  };

  const deleteKid = (kidId) => {
    const kid = kidById.get(kidId);
    if (!kid) return;
    if (!confirm(`ลบเด็ก "${kid.name}"? (จะเอาเด็กคนนี้ออกจากกิจกรรมทั้งหมดด้วย)`)) return;

    setKids((prev) => prev.filter((k) => k.id !== kidId));
    setVisible((prev) => {
      const n = { ...prev };
      delete n[kidId];
      return n;
    });
    setEvents((prev) =>
      prev.map((ev) => ({
        ...ev,
        participants: (ev.participants ?? []).filter((p) => p.kidId !== kidId),
      }))
    );
  };

  const toggleVisible = (kidId) => setVisible((prev) => ({ ...prev, [kidId]: !prev[kidId] }));
  const showAll = () => {
    const n = {};
    kids.forEach((k) => (n[k.id] = true));
    setVisible(n);
  };
  const hideAll = () => {
    const n = {};
    kids.forEach((k) => (n[k.id] = false));
    setVisible(n);
  };

  const openEditTagsForKid = (kidId) => {
    const kid = kidById.get(kidId);
    if (!kid) return;
    setEditKidId(kidId);
    setEditKidTags(kid.tags ?? []);
    setOpenEditKidTagPicker(true);
  };
  const saveEditKidTags = () => {
    if (!editKidId) return;
    setKids((prev) => prev.map((k) => (k.id === editKidId ? { ...k, tags: editKidTags } : k)));
    setOpenEditKidTagPicker(false);
    setEditKidId(null);
    setEditKidTags([]);
  };

  const filteredKids = useMemo(() => {
    const q = kidSearch.trim().toLowerCase();
    const filterSet = new Set(kidFilterTags);

    return kids.filter((k) => {
      // tag filter: must contain all selected tags
      for (const t of filterSet) if (!(k.tags ?? []).includes(t)) return false;

      // text search
      if (!q) return true;
      const nameHit = (k.name ?? "").toLowerCase().includes(q);
      const tagHit = (k.tags ?? []).some((t) => t.toLowerCase().includes(q));
      return nameHit || tagHit;
    });
  }, [kids, kidSearch, kidFilterTags]);

  // ---------- events visibility filtering ----------
  const visibleKidIds = useMemo(() => {
    const s = new Set();
    for (const k of kids) if (visible[k.id]) s.add(k.id);
    return s;
  }, [kids, visible]);

  const eventIsVisible = (ev) => {
    const ps = ev.participants ?? [];
    if (ps.length === 0) return true;
    return ps.some((p) => visibleKidIds.has(p.kidId));
  };

  const visibleEvents = useMemo(() => events.filter(eventIsVisible), [events, visibleKidIds]);

  // ---------- create event ----------
  const pickDay = (d) => {
    const ds = ymd(d);
    setEvStartDate(ds);
    setEvEndDate(ds);
    setCalCursor(startOfMonth(d));
  };

  const createEvent = () => {
    const t = clampStr(evTitle);
    if (!t) return alert("กรุณาใส่ชื่อกิจกรรม");

    const start = combineDateTime(evStartDate, evStartTime);
    const end = combineDateTime(evEndDate, evEndTime);
    if (start >= end) return alert("วัน/เวลาเริ่มต้องก่อนวัน/เวลาจบ");

    const rawLink = clampStr(evSignupUrl);
    const signupUrl = rawLink ? (rawLink.startsWith("http://") || rawLink.startsWith("https://") ? rawLink : `https://${rawLink}`) : "";

    const ev = {
      id: crypto.randomUUID(),
      title: t,
      start,
      end,
      tags: evTags,
      signupUrl,
      participants: [],
    };

    setEvents((prev) => [...prev, ev]);
    setEvTitle("");
    setEvSignupUrl("");
    setEvTags([]);

    openSuggestForEvent(ev.id);
  };

  const openEventDetail = (eventId) => setActiveEventIdForDetail(eventId);

  const activeEventForDetail = useMemo(
    () => events.find((e) => e.id === activeEventIdForDetail) ?? null,
    [events, activeEventIdForDetail]
  );

  const deleteEvent = (eventId) => {
    if (!confirm("ลบกิจกรรมนี้?")) return;
    setEvents((prev) => prev.filter((e) => e.id !== eventId));
    if (activeEventIdForDetail === eventId) setActiveEventIdForDetail(null);
  };

  // ---------- edit event tags ----------
  const openEditTagsForEvent = (eventId) => {
    const ev = events.find((e) => e.id === eventId);
    if (!ev) return;
    setEditEventId(eventId);
    setEditEventTags(ev.tags ?? []);
    setOpenEditEventTagPicker(true);
  };
  const saveEditEventTags = () => {
    if (!editEventId) return;
    setEvents((prev) => prev.map((e) => (e.id === editEventId ? { ...e, tags: editEventTags } : e)));
    setOpenEditEventTagPicker(false);
    setEditEventId(null);
    setEditEventTags([]);
  };

  // ---------- edit event info ----------
  const openEditInfoForEvent = (eventId) => {
    const ev = events.find((e) => e.id === eventId);
    if (!ev) return;
    setEditInfoEventId(eventId);
    setEditTitle(ev.title ?? "");
    setEditStartDate(ymd(ev.start));
    setEditEndDate(ymd(ev.end));
    setEditStartTime(hm(ev.start));
    setEditEndTime(hm(ev.end));
    setEditSignupUrl(ev.signupUrl ?? "");
    setOpenEditEventInfo(true);
  };
  const saveEditEventInfo = () => {
    if (!editInfoEventId) return;
    const t = clampStr(editTitle);
    if (!t) return alert("กรุณาใส่ชื่อกิจกรรม");

    const start = combineDateTime(editStartDate, editStartTime);
    const end = combineDateTime(editEndDate, editEndTime);
    if (start >= end) return alert("วัน/เวลาเริ่มต้องก่อนวัน/เวลาจบ");

    const rawLink = clampStr(editSignupUrl);
    const signupUrl = rawLink ? (rawLink.startsWith("http://") || rawLink.startsWith("https://") ? rawLink : `https://${rawLink}`) : "";

    setEvents((prev) =>
      prev.map((e) => (e.id === editInfoEventId ? { ...e, title: t, start, end, signupUrl } : e))
    );
    setOpenEditEventInfo(false);
    setEditInfoEventId(null);
  };

  // ---------- suggest ----------
  const activeEventForSuggest = useMemo(
    () => events.find((e) => e.id === activeEventIdForSuggest) ?? null,
    [events, activeEventIdForSuggest]
  );

  const openSuggestForEvent = (eventId) => {
    setActiveEventIdForSuggest(eventId);
    setSuggestSearch("");
    setSuggestSelection({});
  };

  const assignedKidIds = useMemo(() => {
    const ev = activeEventForSuggest;
    if (!ev) return new Set();
    return new Set((ev.participants ?? []).map((p) => p.kidId));
  }, [activeEventForSuggest]);

  const suggestedKids = useMemo(() => {
    const ev = activeEventForSuggest;
    if (!ev) return [];
    const evTags = new Set(ev.tags ?? []);
    const q = suggestSearch.trim().toLowerCase();

    const scored = kids
      .filter((k) => !assignedKidIds.has(k.id))
      .filter((k) => {
        if (!q) return true;
        const nameHit = (k.name ?? "").toLowerCase().includes(q);
        const tagHit = (k.tags ?? []).some((t) => t.toLowerCase().includes(q));
        return nameHit || tagHit;
      })
      .map((k) => {
        const score = intersectionCount(k.tags ?? [], evTags);
        return { kid: k, score };
      })
      .filter((x) => x.score > 0);

    scored.sort((a, b) => b.score - a.score || a.kid.name.localeCompare(b.kid.name));
    return scored;
  }, [activeEventForSuggest, kids, suggestSearch, assignedKidIds]);


  const newCandidateIdsForSuggest = useMemo(() => {
    const ev = activeEventForSuggest;
    if (!ev) return new Set();
    const baseline = ev.suggestedAt ?? 0;
    if (!baseline) return new Set();
    const s = new Set();
    for (const { kid, score } of suggestedKids) {
      const createdAt = kid.createdAt ?? 0;
      if (createdAt > baseline && score > 1) s.add(kid.id);
    }
    return s;
  }, [activeEventForSuggest, suggestedKids]);


  const toggleSuggestPick = (kidId) =>
    setSuggestSelection((prev) => ({ ...prev, [kidId]: !prev[kidId] }));

  const selectAllMatchGt0 = () => {
    const n = {};
    for (const { kid, score } of suggestedKids) if (score > 0) n[kid.id] = true;
    setSuggestSelection(n);
  };

  const clearSuggestSelection = () => setSuggestSelection({});

  const confirmSuggested = () => {
    const ev = activeEventForSuggest;
    if (!ev) return;
    const picked = Object.entries(suggestSelection)
      .filter(([, v]) => v)
      .map(([id]) => id);
    const existing = new Set((ev.participants ?? []).map((p) => p.kidId));
    const toAdd = picked
      .filter((id) => !existing.has(id))
      .map((id) => ({ kidId: id, status: 0 }));
    setEvents((prev) =>
      prev.map((e) =>
        (e.id === ev.id
          ? { ...e, suggestedAt: e.suggestedAt ?? Date.now(), participants: [...(e.participants ?? []), ...toAdd] }
          : e)
      )
    );
    setActiveEventIdForSuggest(null);
  };

  // ---------- participants status & remove ----------
  const cycleParticipantStatus = (eventId, kidId) => {
    setEvents((prev) =>
      prev.map((e) => {
        if (e.id !== eventId) return e;
        const next = (e.participants ?? []).map((p) =>
          p.kidId === kidId ? { ...p, status: (p.status + 1) % 3 } : p
        );
        return { ...e, participants: next };
      })
    );
  };

  const removeParticipant = (eventId, kidId) => {
    setEvents((prev) =>
      prev.map((e) =>
        e.id === eventId ? { ...e, participants: (e.participants ?? []).filter((p) => p.kidId !== kidId) } : e
      )
    );
  };

  // ---------- Event detail "new suggestions" banner ----------
  const detailNewMatches = useMemo(() => {
    const ev = activeEventForDetail;
    if (!ev) return [];
    // Only show this warning for events that have been suggested/assigned before
    const baseline = ev.suggestedAt ?? 0;
    if (!baseline) return [];

    const evTagsSet = new Set(ev.tags ?? []);
    if (evTagsSet.size === 0) return [];
    const assigned = new Set((ev.participants ?? []).map((p) => p.kidId));

    const hits = [];
    for (const k of kids) {
      if (assigned.has(k.id)) continue;
      const createdAt = k.createdAt ?? 0;
      if (createdAt <= baseline) continue;
      const score = intersectionCount(k.tags ?? [], evTagsSet);
      if (score > 1) hits.push({ kid: k, score });
    }
    hits.sort((a, b) => b.score - a.score || a.kid.name.localeCompare(b.kid.name));
    return hits;
  }, [activeEventForDetail, kids]);
  const attentionById = useMemo(() => {
    const out = {};
    for (const ev of events) {
      const evTagsSet = new Set(ev.tags ?? []);
      if (evTagsSet.size === 0) { out[ev.id] = 0; continue; }

      // ⚠️ should show only when there are suggested candidates (tag match, not yet assigned)
      // that still have NO note (i.e., not yet "considered").
      const notes = ev.suggestNotes ?? {};
      const assigned = new Set((ev.participants ?? []).map((p) => p.kidId));

      let pending = 0;
      for (const k of kids) {
        if (assigned.has(k.id)) continue;
        const score = intersectionCount(k.tags ?? [], evTagsSet);
        if (score <= 0) continue;

        const noteText = (notes[k.id] ?? "").trim();
        if (!noteText) pending++;
      }
      out[ev.id] = pending;
    }
    return out;
  }, [events, kids]);

  // ---------- List View data ----------
  const listViewEvents = useMemo(() => {
    const norm = (s) => String(s ?? "").toLowerCase().trim();

    const activeTags = new Set(listFilterTags ?? []);
    const q = norm(listSearch);

    const matchTags = (ev) => {
      if (activeTags.size === 0) return true;
      const evTags = new Set(ev.tags ?? []);
      for (const t of activeTags) if (!evTags.has(t)) return false;
      return true;
    };

    const matchQuery = (ev) => {
      if (!q) return true;
      const hay = [
        ev.title,
        ...(ev.tags ?? []),
        ...(ev.participants ?? []).map((p) => kidById.get(p.kidId)?.name ?? ""),
        ...Object.values(ev.suggestNotes ?? {}),
      ]
        .map(norm)
        .join(" | ");
      return hay.includes(q);
    };

    const nowEpoch = listNowEpoch;
    const fromBound = listFromDate ? combineDateTime(listFromDate, "00:00") : null;
    const toBound = listToDate ? combineDateTime(listToDate, "23:59") : null;
    const matchDate = (ev) => {
      const s = ev.start instanceof Date ? ev.start : ev.start ? new Date(ev.start) : null;
      const e = ev.end instanceof Date ? ev.end : ev.end ? new Date(ev.end) : null;
      if (e && e.getTime() < nowEpoch) return false; // hide past (based on time when list view opened)
      if (fromBound && e && e < fromBound) return false;
      if (toBound && s && s > toBound) return false;
      return true;
    };

    return (events ?? [])
      .filter((ev) => matchTags(ev) && matchQuery(ev) && matchDate(ev))
      .slice()
      .sort((a, b) => (a.start?.getTime?.() ?? 0) - (b.start?.getTime?.() ?? 0));
  }, [events, kidById, listFilterTags, listSearch, listFromDate, listToDate, listNowEpoch]);

  const listViewGrouped = useMemo(() => {
    const groups = new Map(); // ymd(dayStart) -> events[]
    for (const ev of listViewEvents) {
      const key = ymd(atStartOfDay(ev.start));
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(ev);
    }
    // ensure each group is sorted
    for (const [k, arr] of groups) {
      arr.sort((a, b) => (a.start?.getTime?.() ?? 0) - (b.start?.getTime?.() ?? 0));
      groups.set(k, arr);
    }
    return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [listViewEvents]);



  // ---------- layout ----------
  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif" }}>
      <style>{`
        /* compact buttons/inputs everywhere (override inline styles) */
        button {
          font-size: 12px !important;
          padding: 4px 6px !important;
          border-radius: 10px !important;
          line-height: 1.1 !important;
        }
        input, select, textarea {
          font-size: 12px !important;
          padding: 6px 8px !important;
          border-radius: 10px !important;
        }
        /* remove black focus ring (keep our own visual states) */
        button:focus, button:focus-visible,
        input:focus, input:focus-visible,
        select:focus, select:focus-visible,
        textarea:focus, textarea:focus-visible {
          outline: none !important;
          box-shadow: none !important;
        }
      `}</style>

      {/* Sidebar */}
      <div style={{ width: 480, borderRight: "1px solid #ddd", padding: 16, overflow: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h3 style={{ margin: 0, flex: 1 }}>เด็ก</h3>
          <button
            onClick={() => setOpenTagLibrary(true)}
            style={{ border: "1px solid #eee", background: "#fff", padding: "8px 10px", borderRadius: 12, cursor: "pointer" }}
          >
            🏷️ Tag Library
          </button>
        </div>

        <div style={{ marginTop: 12 }}>
          <input
            value={kidSearch}
            onChange={(e) => setKidSearch(e.target.value)}
            placeholder="ค้นหาเด็ก (ชื่อหรือ tag)…"
            style={{ width: "100%", padding: 10, borderRadius: 12, border: "1px solid #ddd" }}
          />
          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.7 }}>
            แสดง {filteredKids.length} / {kids.length}
          </div>
        </div>

        {/* NEW: Kid filter by tags */}
        <div style={{ marginTop: 12, padding: 12, borderRadius: 14, border: "1px solid #eee", background: "#fff" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ fontWeight: 900, flex: 1 }}>ตัวกรอง (ตาม Tag)</div>
            <button
              onClick={() => setOpenKidFilter(true)}
              style={{ padding: "8px 10px", borderRadius: 12, border: "1px solid #ddd", background: "#fff", cursor: "pointer" }}
            >
              เลือกตัวกรอง…
            </button>
          </div>
          <div style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
            {kidFilterTags.length === 0 ? (
              <span style={{ fontSize: 12, opacity: 0.65 }}>(ยังไม่เลือกตัวกรอง)</span>
            ) : (
              kidFilterTags.map((t) => <TagPill key={t} text={t} />)
            )}
          </div>
          {kidFilterTags.length > 0 ? (
            <div style={{ marginTop: 10 }}>
              <button
                onClick={() => setKidFilterTags([])}
                style={{ padding: "8px 10px", borderRadius: 12, border: "1px solid #ddd", background: "#fff", cursor: "pointer" }}
              >
                ล้างตัวกรอง
              </button>
              <div style={{ marginTop: 6, fontSize: 12, opacity: 0.65 }}>
                เงื่อนไข: ต้องมีทุกแท็กที่เลือก (AND)
              </div>
            </div>
          ) : null}
        </div>

        <div style={{ marginTop: 14, display: "grid", gap: 8 }}>
          <input
            placeholder="ชื่อเด็ก..."
            value={newKidName}
            onChange={(e) => setNewKidName(e.target.value)}
            onKeyDown={(e) => (e.key === "Enter" ? addKid() : null)}
            style={{ width: "100%", padding: 10, borderRadius: 12, border: "1px solid #ddd" }}
          />

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              onClick={() => setOpenNewKidTagPicker(true)}
              style={{ padding: "10px 12px", borderRadius: 12, border: "1px solid #ddd", background: "#fff", cursor: "pointer" }}
            >
              เลือก Tag เด็ก…
            </button>

            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", flex: 1 }}>
              {newKidTags.length === 0 ? (
                <span style={{ fontSize: 12, opacity: 0.65 }}>(ยังไม่เลือกแท็ก)</span>
              ) : (
                newKidTags.map((t) => <TagPill key={t} text={t} />)
              )}
            </div>
          </div>

          <button
            onClick={addKid}
            style={{ padding: "10px 12px", borderRadius: 12, border: "1px solid #ddd", background: "#fff", cursor: "pointer", width: 130 }}
          >
            + เพิ่มเด็ก
          </button>
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button onClick={showAll} style={{ padding: "8px 10px", borderRadius: 12, border: "1px solid #ddd", background: "#fff", cursor: "pointer" }}>
            เปิดทั้งหมด
          </button>
          <button onClick={hideAll} style={{ padding: "8px 10px", borderRadius: 12, border: "1px solid #ddd", background: "#fff", cursor: "pointer" }}>
            ปิดทั้งหมด
          </button>
        </div>

        <div style={{ marginTop: 16, display: "grid", gap: 10 }}>
          {filteredKids.map((kid) => (
            <div key={kid.id} style={{ padding: 10, borderRadius: 12, border: "1px solid #eee", background: "#fff" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <input type="checkbox" checked={!!visible[kid.id]} onChange={() => toggleVisible(kid.id)} />

                <div style={{ flex: 1, fontWeight: 900, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {kid.name}
                </div>

                <div style={{ display: "flex", gap: 6 }}>
                  <IconButton title="แก้ชื่อ" onClick={() => renameKid(kid.id)}>
                    ✏️
                  </IconButton>
                  <IconButton title="แก้ tag เด็ก" onClick={() => openEditTagsForKid(kid.id)}>
                    🏷️
                  </IconButton>
                  <IconButton title="ลบเด็ก" onClick={() => deleteKid(kid.id)} danger>
                    🗑️
                  </IconButton>
                </div>
              </div>

              <div style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
                {(kid.tags ?? []).length === 0 ? <span style={{ fontSize: 12, opacity: 0.6 }}>(ยังไม่มี tag)</span> : null}
                {(kid.tags ?? []).map((t) => <TagPill key={t} text={t} />)}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Main */}
      <div style={{ flex: 1, padding: 16, overflow: "auto", background: "#fafafa" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h2 style={{ margin: 0, flex: 1 }}>Calendar</h2>
          <div style={{ fontSize: 12, opacity: 0.7 }}>
            กรองกิจกรรมตามเด็กที่เปิดการมองเห็นไว้ (กิจกรรมที่ยังไม่มอบหมายจะแสดงเสมอ)
          </div>
        </div>

        {/* Create Event */}
        <div style={{ padding: 12, border: "1px solid #eee", borderRadius: 16, background: "#fff", margin: "14px 0 16px", maxWidth: 1120 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ fontWeight: 900, fontSize: 16, flex: 1 }}>สร้างกิจกรรมใหม่</div>
            <button onClick={() => setOpenEvTagPicker(true)} style={{ padding: "8px 10px", borderRadius: 12, border: "1px solid #ddd", background: "#fff", cursor: "pointer" }}>
              เลือก Tag กิจกรรม…
            </button>
          </div>

          <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
            <input placeholder="ชื่อกิจกรรม…" value={evTitle} onChange={(e) => setEvTitle(e.target.value)} style={{ padding: 10, minWidth: 260, flex: 1, borderRadius: 12, border: "1px solid #ddd" }} />

            <input placeholder="ลิงก์สมัคร (ถ้ามี)…" value={evSignupUrl} onChange={(e) => setEvSignupUrl(e.target.value)} style={{ padding: 10, minWidth: 220, flex: 1, borderRadius: 12, border: "1px solid #ddd" }} />

            <label style={{ display: "grid", gap: 4 }}>
              <span style={{ fontSize: 12, opacity: 0.7 }}>วันที่เริ่ม</span>
              <input type="date" value={evStartDate} onChange={(e) => setEvStartDate(e.target.value)} style={{ padding: 10, borderRadius: 12, border: "1px solid #ddd" }} />
            </label>

            <label style={{ display: "grid", gap: 4 }}>
              <span style={{ fontSize: 12, opacity: 0.7 }}>เวลาเริ่ม</span>
              <input type="time" value={evStartTime} onChange={(e) => setEvStartTime(e.target.value)} style={{ padding: 10, borderRadius: 12, border: "1px solid #ddd" }} />
            </label>

            <label style={{ display: "grid", gap: 4 }}>
              <span style={{ fontSize: 12, opacity: 0.7 }}>วันที่จบ</span>
              <input type="date" value={evEndDate} onChange={(e) => setEvEndDate(e.target.value)} style={{ padding: 10, borderRadius: 12, border: "1px solid #ddd" }} />
            </label>

            <label style={{ display: "grid", gap: 4 }}>
              <span style={{ fontSize: 12, opacity: 0.7 }}>เวลาจบ</span>
              <input type="time" value={evEndTime} onChange={(e) => setEvEndTime(e.target.value)} style={{ padding: 10, borderRadius: 12, border: "1px solid #ddd" }} />
            </label>

            <button onClick={createEvent} style={{ padding: "10px 12px", borderRadius: 12, border: "1px solid #1a73e8", background: "#1a73e8", color: "#fff", cursor: "pointer" }}>
              + สร้าง
            </button>
          </div>

          <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
            {evTags.length === 0 ? <span style={{ fontSize: 12, opacity: 0.65 }}>(ยังไม่เลือกแท็ก)</span> : null}
            {evTags.map((t) => <TagPill key={t} text={t} />)}
          </div>
        </div>

        {/* Month Calendar */}
        <div style={{ maxWidth: 1120 }}>
          <MonthCalendar
            cursor={calCursor}
            setCursor={setCalCursor}
            events={visibleEvents}
            onPickDay={pickDay}
            onOpenEvent={openEventDetail}
            attentionById={attentionById}
            onOpenListView={() => { setListNowEpoch(Date.now()); setOpenListView(true); }}
          />
        </div>
      </div>

      {/* Tag Library modal */}
      <TagPickerModal
        open={openTagLibrary}
        title="Tag Library (เพิ่มหมวด / เพิ่มแท็ก / แก้ชื่อ / ลบ)"
        tagCatalog={tagCatalog}
        setTagCatalog={setTagCatalog}
        selectedTags={null}
        setSelectedTags={null}
        onCancel={() => setOpenTagLibrary(false)}
        onSave={() => setOpenTagLibrary(false)}
        saveLabel="ปิด"
        allowEditLibrary={true}
        onRenameTag={renameTagInCategory}
        onDeleteTag={deleteTagInCategory}
      />

      {/* Kid filter modal */}
      <TagPickerModal
        open={openKidFilter}
        title="ตัวกรองเด็ก (เลือก Tag ได้หลายอัน)"
        tagCatalog={tagCatalog}
        setTagCatalog={setTagCatalog}
        selectedTags={kidFilterTags}
        setSelectedTags={setKidFilterTags}
        onCancel={() => setOpenKidFilter(false)}
        onSave={() => setOpenKidFilter(false)}
        saveLabel="ใช้ตัวกรองนี้"
        allowEditLibrary={false}
      />

      {/* New kid tags */}
      <TagPickerModal
        open={openNewKidTagPicker}
        title="เลือก Tag เด็ก (ก่อนกดเพิ่ม)"
        tagCatalog={tagCatalog}
        setTagCatalog={setTagCatalog}
        selectedTags={newKidTags}
        setSelectedTags={setNewKidTags}
        onCancel={() => setOpenNewKidTagPicker(false)}
        onSave={() => setOpenNewKidTagPicker(false)}
        saveLabel="ใช้แท็กนี้"
        allowEditLibrary={false}
      />

      {/* Edit kid tags */}
      <TagPickerModal
        open={openEditKidTagPicker}
        title="แก้ Tag เด็ก (เฉพาะคนนี้)"
        tagCatalog={tagCatalog}
        setTagCatalog={setTagCatalog}
        selectedTags={editKidTags}
        setSelectedTags={setEditKidTags}
        onCancel={() => {
          setOpenEditKidTagPicker(false);
          setEditKidId(null);
          setEditKidTags([]);
        }}
        onSave={saveEditKidTags}
        saveLabel="บันทึกให้เด็กคนนี้"
        allowEditLibrary={false}
      />

      {/* Event tag picker (create) */}
      <TagPickerModal
        open={openEvTagPicker}
        title="เลือก Tag กิจกรรม"
        tagCatalog={tagCatalog}
        setTagCatalog={setTagCatalog}
        selectedTags={evTags}
        setSelectedTags={setEvTags}
        onCancel={() => setOpenEvTagPicker(false)}
        onSave={() => setOpenEvTagPicker(false)}
        saveLabel="ใช้แท็กนี้"
        allowEditLibrary={false}
      />

      {/* Edit event tags */}
      <TagPickerModal
        open={openEditEventTagPicker}
        title="แก้ Tag กิจกรรม"
        tagCatalog={tagCatalog}
        setTagCatalog={setTagCatalog}
        selectedTags={editEventTags}
        setSelectedTags={setEditEventTags}
        onCancel={() => {
          setOpenEditEventTagPicker(false);
          setEditEventId(null);
          setEditEventTags([]);
        }}
        onSave={saveEditEventTags}
        saveLabel="บันทึก Tag กิจกรรม"
        allowEditLibrary={false}
      />

      {/* Edit event info */}
      {openEditEventInfo ? (
        <Modal title="แก้ไขกิจกรรม (ชื่อ / วันเริ่ม-วันจบ / เวลา)" onClose={() => setOpenEditEventInfo(false)} width={640}>
          <div style={{ display: "grid", gap: 10 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <div style={{ fontWeight: 900 }}>ชื่อกิจกรรม</div>
              <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} style={{ padding: 10, borderRadius: 12, border: "1px solid #ddd" }} />
            </label>

            <label style={{ display: "grid", gap: 6 }}>
              <div style={{ fontWeight: 900 }}>ลิงก์สมัคร (ถ้ามี)</div>
              <input value={editSignupUrl} onChange={(e) => setEditSignupUrl(e.target.value)} placeholder="https://..." style={{ padding: 10, borderRadius: 12, border: "1px solid #ddd" }} />
            </label>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <label style={{ display: "grid", gap: 6, flex: 1, minWidth: 220 }}>
                <div style={{ fontWeight: 900 }}>วันที่เริ่ม</div>
                <input type="date" value={editStartDate} onChange={(e) => setEditStartDate(e.target.value)} style={{ padding: 10, borderRadius: 12, border: "1px solid #ddd" }} />
              </label>

              <label style={{ display: "grid", gap: 6, flex: 1, minWidth: 160 }}>
                <div style={{ fontWeight: 900 }}>เวลาเริ่ม</div>
                <input type="time" value={editStartTime} onChange={(e) => setEditStartTime(e.target.value)} style={{ padding: 10, borderRadius: 12, border: "1px solid #ddd" }} />
              </label>

              <label style={{ display: "grid", gap: 6, flex: 1, minWidth: 220 }}>
                <div style={{ fontWeight: 900 }}>วันที่จบ</div>
                <input type="date" value={editEndDate} onChange={(e) => setEditEndDate(e.target.value)} style={{ padding: 10, borderRadius: 12, border: "1px solid #ddd" }} />
              </label>

              <label style={{ display: "grid", gap: 6, flex: 1, minWidth: 160 }}>
                <div style={{ fontWeight: 900 }}>เวลาจบ</div>
                <input type="time" value={editEndTime} onChange={(e) => setEditEndTime(e.target.value)} style={{ padding: 10, borderRadius: 12, border: "1px solid #ddd" }} />
              </label>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 6 }}>
              <button onClick={() => setOpenEditEventInfo(false)} style={{ padding: "10px 12px", borderRadius: 12, border: "1px solid #ddd", background: "#fff", cursor: "pointer" }}>
                ยกเลิก
              </button>
              <button onClick={saveEditEventInfo} style={{ padding: "10px 12px", borderRadius: 12, border: "1px solid #1a73e8", background: "#1a73e8", color: "#fff", cursor: "pointer" }}>
                บันทึก
              </button>
            </div>
          </div>
        </Modal>
      ) : null}

      {/* Suggest modal */}
      {activeEventForSuggest ? (
        <Modal title={`Suggest เด็กสำหรับกิจกรรม: ${activeEventForSuggest.title}`} onClose={() => setActiveEventIdForSuggest(null)} width={940}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 320 }}>
              <div style={{ fontWeight: 900, marginBottom: 8 }}>Tag ของกิจกรรม</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {(activeEventForSuggest.tags ?? []).length === 0 ? (
                  <div style={{ opacity: 0.7 }}>(ไม่มี tag → ระบบจะแนะนำได้น้อย)</div>
                ) : (
                  activeEventForSuggest.tags.map((t) => <TagPill key={t} text={t} />)
                )}
              </div>
            </div>

            <div style={{ flex: 2, minWidth: 420 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                <div style={{ fontWeight: 900, flex: 1 }}>รายชื่อเด็ก (เรียงตามความตรง)</div>
                <input value={suggestSearch} onChange={(e) => setSuggestSearch(e.target.value)} placeholder="ค้นหาเด็ก…" style={{ padding: 10, borderRadius: 12, border: "1px solid #ddd", width: 240 }} />
              </div>

              <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
                <button onClick={selectAllMatchGt0} style={{ padding: "8px 10px", borderRadius: 12, border: "1px solid #ddd", background: "#fff", cursor: "pointer" }}>
                  เลือกทั้งหมด (match &gt; 0)
                </button>
                <button onClick={clearSuggestSelection} style={{ padding: "8px 10px", borderRadius: 12, border: "1px solid #ddd", background: "#fff", cursor: "pointer" }}>
                  ล้างที่เลือก
                </button>
              </div>

              {suggestedKids.length === 0 ? (
                <div style={{ opacity: 0.7 }}>ไม่มีเด็กให้เลือกแล้ว (หรือค้นหาแล้วไม่เจอ)</div>
              ) : (
                <div style={{ display: "grid", gap: 8 }}>
                  {suggestedKids.map(({ kid, score }) => (
                    <label
                      key={kid.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: 10,
                        borderRadius: 12,
                        border: ((activeEventForSuggest.suggestNotes ?? {})[kid.id] ?? "").trim() ? "1px solid #cfcfcf" : (newCandidateIdsForSuggest.has(kid.id) ? "1px solid #ffb3b3" : "1px solid #eee"),
                        background: ((activeEventForSuggest.suggestNotes ?? {})[kid.id] ?? "").trim() ? "#eee" : (newCandidateIdsForSuggest.has(kid.id) ? "#fff1f1" : "#fff"),

                        cursor: "pointer",
                      }}
                    >
                      <input type="checkbox" checked={!!suggestSelection[kid.id]} onChange={() => toggleSuggestPick(kid.id)} />
                      <div style={{ flex: 1 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <div style={{ fontWeight: 900 }}>
                            {kid.name}{" "}
                            {newCandidateIdsForSuggest.has(kid.id) ? (
                              <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 900, color: "#b42318" }}>NEW</span>
                            ) : null}{" "}
                            <span style={{ fontWeight: 400, opacity: 0.6 }}>(match {score})</span>
                          </div>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              const note = prompt(`Note สำหรับ ${kid.name} (จะบันทึกไว้ในกิจกรรมนี้)`, (activeEventForSuggest.suggestNotes ?? {})[kid.id] ?? "");
                              if (note === null) return;
                              setEvents((prev) =>
                                prev.map((ev) =>
                                  ev.id === activeEventForSuggest.id
                                    ? { ...ev, suggestNotes: { ...(ev.suggestNotes ?? {}), [kid.id]: note } }
                                    : ev
                                )
                              );
                            }}
                            style={{ padding: "6px 8px", borderRadius: 10, border: "1px solid #ddd", background: "#fff", cursor: "pointer", fontSize: 11 }}
                          >
                            note
                          </button>
                        </div>
                        {(activeEventForSuggest.suggestNotes ?? {})[kid.id] ? (
                          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>
                            📝 {(activeEventForSuggest.suggestNotes ?? {})[kid.id]}
                          </div>
                        ) : null}
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                          {(kid.tags ?? []).length === 0 ? <span style={{ fontSize: 12, opacity: 0.6 }}>(ไม่มี tag)</span> : null}
                          {(kid.tags ?? []).map((t) => <TagPill key={t} text={t} />)}
                        </div>
                      </div>
                    </label>
                  ))}
                </div>
              )}

              <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button onClick={() => setActiveEventIdForSuggest(null)} style={{ padding: "10px 12px", borderRadius: 12, border: "1px solid #ddd", background: "#fff", cursor: "pointer" }}>
                  ยกเลิก
                </button>
                <button onClick={confirmSuggested} style={{ padding: "10px 12px", borderRadius: 12, border: "1px solid #1a73e8", background: "#1a73e8", color: "#fff", cursor: "pointer" }}>
                  Confirm (มอบหมาย)
                </button>
              </div>
            </div>
          </div>
        </Modal>
      ) : null}


      {/* List View: tag filter modal */}
      <TagPickerModal
        open={openListFilterTagPicker}
        title="ตัวกรอง List View (ตาม Tag)"
        tagCatalog={tagCatalog}
        setTagCatalog={setTagCatalog}
        selectedTags={listFilterTags}
        setSelectedTags={setListFilterTags}
        onCancel={() => setOpenListFilterTagPicker(false)}
        onSave={() => setOpenListFilterTagPicker(false)}
        saveLabel="ใช้ตัวกรองนี้"
        allowEditLibrary={false}
      />

      {/* List View modal */}
      {openListView ? (
        <Modal title="List View" onClose={() => setOpenListView(false)} width={980}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button
              onClick={() => setOpenListFilterTagPicker(true)}
              style={{ padding: "8px 10px", borderRadius: 12, border: "1px solid #ddd", background: "#fff", cursor: "pointer" }}
            >
              ตัวกรอง Tag…
            </button>

            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {listFilterTags.length === 0 ? <span style={{ fontSize: 12, opacity: 0.65 }}>(ไม่กรอง tag)</span> : null}
              {listFilterTags.map((t) => (
                <TagPill key={t} text={t} />
              ))}
            </div>

            <div style={{ flex: 1 }} />

            <label style={{ display: "grid", gap: 4 }}>
              <span style={{ fontSize: 12, opacity: 0.7 }}>จากวันที่</span>
              <input type="date" value={listFromDate} onChange={(e) => setListFromDate(e.target.value)} style={{ padding: 10, borderRadius: 12, border: "1px solid #ddd" }} />
            </label>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={{ fontSize: 12, opacity: 0.7 }}>ถึงวันที่</span>
              <input type="date" value={listToDate} onChange={(e) => setListToDate(e.target.value)} style={{ padding: 10, borderRadius: 12, border: "1px solid #ddd" }} />
            </label>

            <input
              value={listSearch}
              onChange={(e) => setListSearch(e.target.value)}
              placeholder="ค้นหา keyword (ชื่อกิจกรรม / tag / เด็ก / note)…"
              style={{ padding: 10, borderRadius: 12, border: "1px solid #ddd", width: 360, maxWidth: "100%" }}
            />
          </div>

          <div style={{ marginTop: 14, maxHeight: "70vh", overflowY: "auto" }}>
            {listViewGrouped.length === 0 ? (
              <div style={{ opacity: 0.7 }}>(ไม่พบกิจกรรม)</div>
            ) : (
              <div style={{ display: "grid", gap: 14 }}>
                {listViewGrouped.map(([dayKey, evs]) => (
                  <div key={dayKey} style={{ border: "1px solid #eee", borderRadius: 14, overflow: "hidden" }}>
                    <div style={{ padding: "10px 12px", background: "#fafafa", fontWeight: 900 }}>
                      {dayKey}
                    </div>
                    <div style={{ padding: 12, display: "grid", gap: 10 }}>
                      {evs.map((ev) => {
                        const notes = ev.suggestNotes ?? {};
                        const noteKidIds = Object.keys(notes);
                        return (
                          <div key={ev.id} style={{ padding: 12, borderRadius: 14, border: "1px solid #eee", background: "#fff" }}>
                            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                              <div style={{ fontWeight: 900, fontSize: 15, flex: 1, minWidth: 240 }}>{ev.title}</div>
                              <div style={{ fontSize: 12, opacity: 0.75, display: "flex", alignItems: "center", gap: 8 }}>
                                <span>{ymd(ev.start)} {hm(ev.start)} – {ymd(ev.end)} {hm(ev.end)}</span>
                                {ev.signupUrl ? (
                                  <a href={ev.signupUrl} target="_blank" rel="noreferrer" title="เปิดลิงก์สมัคร" style={{ textDecoration: "none", fontSize: 16 }}>
                                    🔗
                                  </a>
                                ) : null}
                              </div>
                              <button
                                onClick={() => {
                                  setOpenListView(false);
                                  openEventDetail(ev.id);
                                }}
                                style={{ padding: "6px 8px", borderRadius: 12, border: "1px solid #ddd", background: "#fff", cursor: "pointer", fontSize: 12 }}
                              >
                                เปิดรายละเอียด
                              </button>
                            </div>

                            <div style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
                              {(ev.tags ?? []).length === 0 ? <span style={{ fontSize: 12, opacity: 0.6 }}>(ไม่มี tag)</span> : null}
                              {(ev.tags ?? []).map((t) => (
                                <TagPill key={t} text={t} />
                              ))}
                            </div>

                            <div style={{ marginTop: 10 }}>
                              <div style={{ fontWeight: 900, fontSize: 12 }}>ผู้เข้าร่วม</div>
                              <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
                                {(ev.participants ?? []).length === 0 ? (
                                  <div style={{ opacity: 0.7, fontSize: 12 }}>(ยังไม่มีผู้เข้าร่วม)</div>
                                ) : (
                                  (ev.participants ?? []).map((p) => {
                                    const name = kidById.get(p.kidId)?.name ?? "(เด็กถูกลบแล้ว)";
                                    const status = p.status ?? 0;
                                    const bg = status === 0 ? "#fff3bf" : status === 1 ? "#d0ebff" : "#d3f9d8";
                                    const bd = status === 0 ? "#ffe066" : status === 1 ? "#74c0fc" : "#69db7c";
                                    return (
                                      <span
                                        key={p.kidId}
                                        style={{
                                          border: `1px solid ${bd}`,
                                          background: bg,
                                          padding: "6px 10px",
                                          borderRadius: 999,
                                          fontSize: 13,
                                          whiteSpace: "nowrap",
                                        }}
                                      >
                                        {name}
                                      </span>
                                    );
                                  })
                                )}
                              </div>
                            </div>

                            {noteKidIds.length > 0 ? (
                              <div style={{ marginTop: 10 }}>
                                <div style={{ fontWeight: 900, fontSize: 12 }}>Notes</div>
                                <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
                                  {noteKidIds.map((kidId) => {
                                    const name = kidById.get(kidId)?.name ?? "(เด็กถูกลบแล้ว)";
                                    return (
                                      <div key={kidId} style={{ fontSize: 12, opacity: 0.85 }}>
                                        📝 <span style={{ fontWeight: 800 }}>{name}</span>: {notes[kidId]}
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Modal>
      ) : null}

      {/* Event detail modal */}
      {activeEventForDetail ? (
        <Modal title={`กิจกรรม: ${activeEventForDetail.title}`} onClose={() => setActiveEventIdForDetail(null)} width={940}>
          {(activeEventForDetail.participants ?? []).length === 0 ? (
            <div style={{ padding: 12, borderRadius: 12, border: "1px solid #ffd8a8", background: "#fff4e6", color: "#d9480f", fontWeight: 900, marginBottom: 12 }}>
              ⚠️ กิจกรรมนี้ยังไม่ได้มอบหมายให้ใคร — กรุณากด “Suggest” เพื่อมอบหมาย
            </div>
          ) : null}

          {/* NEW warning for new matches */}
          {detailNewMatches.length > 0 ? (
            <div style={{ padding: 12, borderRadius: 12, border: "1px solid #ffe066", background: "#fff9db", color: "#664d03", fontWeight: 900, marginBottom: 12 }}>
              ⚠️ มีน้องใหม่ที่ match &gt; 1 แต่ยังไม่ถูกมอบหมายในกิจกรรมนี้:{" "}
              <span style={{ fontWeight: 700 }}>
                {detailNewMatches.slice(0, 8).map((x) => x.kid.name).join(", ")}
                {detailNewMatches.length > 8 ? " …" : ""}
              </span>
            </div>
          ) : null}

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 260 }}>
              <div style={{ fontWeight: 900 }}>ช่วงเวลา</div>
              <div style={{ marginTop: 4 }}>
                {ymd(activeEventForDetail.start)} {hm(activeEventForDetail.start)} – {ymd(activeEventForDetail.end)} {hm(activeEventForDetail.end)}
              </div>

              {activeEventForDetail.signupUrl ? (
                <div style={{ marginTop: 6 }}>
                  <a href={activeEventForDetail.signupUrl} target="_blank" rel="noreferrer" title="เปิดลิงก์สมัคร" style={{ textDecoration: "none", fontSize: 18 }}>
                    🔗
                  </a>
                </div>
              ) : null}

              <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button onClick={() => { setActiveEventIdForDetail(null); openEditInfoForEvent(activeEventForDetail.id); }} style={{ padding: "8px 10px", borderRadius: 12, border: "1px solid #ddd", background: "#fff", cursor: "pointer" }}>
                  ✏️ แก้ชื่อ/วัน/เวลา
                </button>
                <button onClick={() => { setActiveEventIdForDetail(null); openEditTagsForEvent(activeEventForDetail.id); }} style={{ padding: "8px 10px", borderRadius: 12, border: "1px solid #ddd", background: "#fff", cursor: "pointer" }}>
                  🏷️ แก้ Tag
                </button>
                <button onClick={() => { setActiveEventIdForDetail(null); openSuggestForEvent(activeEventForDetail.id); }} style={{ padding: "8px 10px", borderRadius: 12, border: "1px solid #ddd", background: "#fff", cursor: "pointer" }}>
                  Suggest
                </button>
              </div>
            </div>

            <div style={{ flex: 2, minWidth: 320 }}>
              <div style={{ fontWeight: 900 }}>Tags</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                {(activeEventForDetail.tags ?? []).length === 0 ? <div style={{ opacity: 0.7 }}>(ไม่มี tag)</div> : null}
                {(activeEventForDetail.tags ?? []).map((t) => <TagPill key={t} text={t} />)}
              </div>
            </div>
          </div>

          <div style={{ marginTop: 14 }}>
            <div style={{ fontWeight: 900 }}>ผู้เข้าร่วม (กดชื่อเพื่อวนสีสถานะ)</div>

            <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
              {(activeEventForDetail.participants ?? []).length === 0 ? (
                <div style={{ opacity: 0.7 }}>(ยังไม่มีผู้เข้าร่วม)</div>
              ) : (
                activeEventForDetail.participants.map((p) => {
                  const name = kidById.get(p.kidId)?.name ?? "(เด็กถูกลบแล้ว)";
                  return (
                    <div key={p.kidId} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <StatusChip label={name} status={p.status} onClick={() => cycleParticipantStatus(activeEventForDetail.id, p.kidId)} />
                      <IconButton title="เอาเด็กออกจากกิจกรรม" onClick={() => removeParticipant(activeEventForDetail.id, p.kidId)}>
                        ✖
                      </IconButton>
                    </div>
                  );
                })
              )}
            </div>

            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}>
              สี: เหลือง=ยังไม่แจ้ง • ฟ้า=กำลังดำเนินการ • เขียว=แจ้งแล้ว
            </div>
          </div>

          <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button onClick={() => deleteEvent(activeEventForDetail.id)} style={{ padding: "10px 12px", borderRadius: 12, border: "1px solid #eee", background: "#fff", cursor: "pointer" }}>
              ลบกิจกรรม
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}