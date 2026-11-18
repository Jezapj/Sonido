import { useCallback, useEffect, useMemo, useRef, useState, FC } from "react";
import {
  claimPending, exportTakeMidi, fmtDuration, loadGuide, midiToTake, nudgeTakeSync, refreshGuide,
  retimeTake, setTakeSynced, takeFirstCount, tempoLabel, unloadGuide, useTakes,
  type Take,
} from "./takes";
import { TIME_SIGNATURES } from "./DashboardMetronome";
import { getProfile, updateProfile } from "./profileStore";
import { useChordPractice } from "./chordPractice";

export type ChordVerse = {
  label: string;
  chords: string[];
};

export type Song = {
  id: string;
  title: string;
  key: string;
  verses: ChordVerse[];
  folderId: string | null;
  takes: Take[];
};

export type SongFolder = {
  id: string;
  name: string;
};

const TrashIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="3 6 5 6 21 6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <line x1="10" y1="11" x2="10" y2="17" />
    <line x1="14" y1="11" x2="14" y2="17" />
  </svg>
);

const EditIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
  </svg>
);

const btnBase: React.CSSProperties = {
  background: "transparent",
  border: "0.5px solid rgba(255,255,255,0.25)",
  color: "#ffffff",
  borderRadius: 8,
  padding: "4px 10px",
  fontSize: 11,
  fontFamily: "monospace",
  cursor: "pointer",
  letterSpacing: "0.04em",
  whiteSpace: "nowrap" as const,
};

const fieldStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 6,
  color: "#fff",
  fontFamily: "monospace",
  fontSize: 11,
  padding: "5px 8px",
  outline: "none",
};

/**
 * Parse chord text into verses.
 * - Blank line or --- starts a new verse
 * - A line like [Chorus] or Verse: becomes the verse label
 * - Other tokens (space-separated) are chords
 */
export function parseChordText(text: string): ChordVerse[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const verses: ChordVerse[] = [];
  let label = "";
  let chords: string[] = [];
  let verseIndex = 0;

  const flush = () => {
    if (chords.length === 0 && !label) return;
    verseIndex += 1;
    verses.push({
      label: label || `V${verseIndex}`,
      chords: [...chords],
    });
    label = "";
    chords = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line === "---" || line === "--") {
      flush();
      continue;
    }
    const bracket = line.match(/^\[([^\]]+)\]\s*(.*)$/);
    const colon = line.match(/^([A-Za-z][A-Za-z0-9 /_-]{0,24}):\s*(.*)$/);
    if (bracket) {
      if (chords.length > 0 || label) flush();
      label = bracket[1].trim();
      if (bracket[2].trim()) {
        chords.push(...bracket[2].trim().split(/\s+/).filter(Boolean));
      }
      continue;
    }
    if (colon && !/^[A-G][#b]?(m|maj|min|dim|aug|sus|add)?\d*/i.test(colon[1])) {
      if (chords.length > 0 || label) flush();
      label = colon[1].trim();
      if (colon[2].trim()) {
        chords.push(...colon[2].trim().split(/\s+/).filter(Boolean));
      }
      continue;
    }
    chords.push(...line.split(/\s+/).filter(Boolean));
  }
  flush();
  return verses;
}

function versesToText(verses: ChordVerse[]): string {
  return verses
    .map(v => `[${v.label}]\n${v.chords.join(" ")}`)
    .join("\n\n");
}

type Mode = "list" | "view" | "edit";

const SYNC_ACCENT = "#AFA9EC";

/** Tie a take to a tempo / time signature, and line its bar lines up with the playing. */
function TakeSyncEditor({ take, onChange }: { take: Take; onChange: (next: Take) => void }) {
  const [bpmText, setBpmText] = useState(String(take.bpm));
  useEffect(() => { setBpmText(String(take.bpm)); }, [take.bpm]);

  const small: React.CSSProperties = { ...btnBase, padding: "1px 5px", fontSize: 9, lineHeight: "1.4" };
  const label: React.CSSProperties = { fontFamily: "monospace", fontSize: 9, color: "rgba(255,255,255,0.45)" };
  const synced = !!take.sync;
  const sigIdx = TIME_SIGNATURES.findIndex(s => s.beats === take.timeSig[0] && s.noteValue === take.timeSig[1]);

  const commitBpm = () => {
    const v = Math.round(Number(bpmText) * 100) / 100;
    if (v >= 20 && v <= 300) { if (v !== take.bpm) onChange(retimeTake(take, v, take.timeSig)); }
    else setBpmText(String(take.bpm));
  };
  const cycleSig = (dir: -1 | 1) => {
    const n = TIME_SIGNATURES.length;
    const s = TIME_SIGNATURES[sigIdx < 0 ? 2 : (sigIdx + dir + n) % n];
    onChange(retimeTake(take, take.bpm, [s.beats, s.noteValue]));
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 0 1px 16px", flexWrap: "wrap" }}>
      <button
        type="button"
        onClick={() => onChange(setTakeSynced(take, !synced))}
        title={synced ? "Stop treating this take as in time" : "Draw bars and note lengths at this tempo"}
        style={{
          ...small,
          borderColor: synced ? "rgba(175,169,236,0.6)" : "rgba(255,255,255,0.25)",
          color: synced ? SYNC_ACCENT : "rgba(255,255,255,0.6)",
          background: synced ? "rgba(175,169,236,0.12)" : "transparent",
        }}
      >
        {synced ? "SYNC ON" : "SYNC OFF"}
      </button>
      {synced && (
        <>
          <input
            value={bpmText}
            inputMode="decimal"
            onChange={e => setBpmText(e.target.value)}
            onBlur={commitBpm}
            onKeyDown={e => { if (e.key === "Enter") commitBpm(); }}
            title="Tempo (clicks per minute)"
            style={{ ...fieldStyle, width: 38, padding: "1px 4px", fontSize: 9, textAlign: "center" }}
          />
          <span style={label}>BPM</span>
          <button type="button" style={small} onClick={() => cycleSig(-1)}>&lsaquo;</button>
          <span style={{ ...label, color: "rgba(255,255,255,0.85)", minWidth: 24, textAlign: "center" }}>
            {take.timeSig[0]}/{take.timeSig[1]}
          </span>
          <button type="button" style={small} onClick={() => cycleSig(1)}>&rsaquo;</button>
          <button type="button" style={small} title="First note a 16th earlier in the bar"
            onClick={() => onChange(nudgeTakeSync(take, -1))}>&lsaquo;</button>
          <span style={{ ...label, minWidth: 34, textAlign: "center" }} title="Count the first note falls on">
            on <span style={{ color: SYNC_ACCENT }}>{takeFirstCount(take)}</span>
          </span>
          <button type="button" style={small} title="First note a 16th later in the bar"
            onClick={() => onChange(nudgeTakeSync(take, 1))}>&rsaquo;</button>
        </>
      )}
    </div>
  );
}

const DashboardChordBank: FC<{ size?: { w: number; h: number } }> = ({ size }) => {
  const panelW = size?.w ?? 300, panelH = size?.h ?? 168;
  const roomy = panelW > 420;   // focused: verses flow into columns
  const [songs, setSongs] = useState<Song[]>(() => getProfile().songs);
  const [folders, setFolders] = useState<SongFolder[]>(() => getProfile().folders);
  const [mode, setMode] = useState<Mode>("list");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [songKey, setSongKey] = useState("");
  const [chordText, setChordText] = useState("");
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});
  const [draftFolder, setDraftFolder] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragRef = useRef<{ id: string; x: number; y: number; moved: boolean } | null>(null);

  useEffect(() => { updateProfile({ songs, folders }); }, [songs, folders]);

  const active = songs.find(s => s.id === activeId) ?? null;

  const takeStore = useTakes();
  const [viewTab, setViewTab] = useState<"chords" | "takes">("chords");
  const [renamingTake, setRenamingTake] = useState<{ id: string; name: string } | null>(null);
  const [takeError, setTakeError] = useState("");
  const midiInputRef = useRef<HTMLInputElement>(null);

  // ── Practice: step through the song's chords as the chord tracker hears them ──
  const [practicing, setPracticing] = useState(false);
  const songChords = useMemo(() => (active ? active.verses.flatMap(v => v.chords) : []), [active]);
  const practiceOn = practicing && mode === "view" && viewTab === "chords";
  const practice = useChordPractice(songChords, practiceOn);
  const chordScrollRef = useRef<HTMLDivElement>(null);
  const currentChipRef = useRef<HTMLSpanElement>(null);

  // Keep the chord to play in view as the song advances
  useEffect(() => {
    if (!practiceOn) return;
    const box = chordScrollRef.current, chip = currentChipRef.current;
    if (!box || !chip) return;
    const top = chip.offsetTop, bottom = top + chip.offsetHeight;
    if (top < box.scrollTop) box.scrollTop = Math.max(0, top - 18);
    else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight + 6;
  }, [practiceOn, practice.index]);

  const openSong = useCallback((id: string) => {
    setActiveId(id);
    setViewTab("chords");
    setTakeError("");
    setPracticing(false);
    setMode("view");
  }, []);

  const updateTakes = useCallback((songId: string, fn: (takes: Take[]) => Take[]) => {
    setSongs(prev => prev.map(s => s.id === songId ? { ...s, takes: fn(s.takes) } : s));
  }, []);

  const saveTakeToSong = useCallback(() => {
    if (!active) return;
    const take = claimPending(`Take ${active.takes.length + 1}`);
    if (take) updateTakes(active.id, ts => [...ts, take]);
  }, [active, updateTakes]);

  const importMidi = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !active) return;
    try {
      const take = midiToTake(new Uint8Array(await file.arrayBuffer()), file.name.replace(/\.midi?$/i, ""));
      updateTakes(active.id, ts => [...ts, take]);
      setTakeError("");
    } catch (err) {
      setTakeError(err instanceof Error ? err.message : "Could not read that MIDI file");
    }
  }, [active, updateTakes]);

  const [syncEditId, setSyncEditId] = useState<string | null>(null);
  const editTake = useCallback((next: Take) => {
    if (!active) return;
    updateTakes(active.id, ts => ts.map(t => t.id === next.id ? next : t));
    refreshGuide(next);
  }, [active, updateTakes]);

  const deleteTake = useCallback((take: Take) => {
    if (!active) return;
    if (takeStore.guide?.id === take.id) unloadGuide();
    updateTakes(active.id, ts => ts.filter(t => t.id !== take.id));
  }, [active, takeStore.guide, updateTakes]);

  const commitRename = useCallback(() => {
    if (!active || !renamingTake) return;
    const name = renamingTake.name.trim();
    if (name) updateTakes(active.id, ts => ts.map(t => t.id === renamingTake.id ? { ...t, name } : t));
    setRenamingTake(null);
  }, [active, renamingTake, updateTakes]);

  const startNew = useCallback(() => {
    setActiveId(null);
    setTitle("");
    setSongKey("");
    setChordText("[Verse]\nG D Em C\n\n[Chorus]\nAm F C G");
    setMode("edit");
  }, []);

  const startEdit = useCallback(() => {
    if (!active) return;
    setTitle(active.title);
    setSongKey(active.key);
    setChordText(versesToText(active.verses));
    setPracticing(false);
    setMode("edit");
  }, [active]);

  const saveSong = useCallback(() => {
    const verses = parseChordText(chordText);
    if (!title.trim() || verses.length === 0) return;
    const entry: Song = {
      id: activeId ?? `song-${Date.now()}`,
      title: title.trim(),
      key: songKey.trim(),
      verses,
      folderId: songs.find(s => s.id === activeId)?.folderId ?? null,
      takes: songs.find(s => s.id === activeId)?.takes ?? [],
    };
    setSongs(prev => {
      const idx = prev.findIndex(s => s.id === entry.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = entry;
        return next;
      }
      return [...prev, entry];
    });
    setActiveId(entry.id);
    setMode("view");
  }, [activeId, title, songKey, chordText, songs]);

  const deleteSong = useCallback(() => {
    if (!activeId) return;
    setSongs(prev => prev.filter(s => s.id !== activeId));
    setActiveId(null);
    setMode("list");
  }, [activeId]);

  const backToList = () => {
    setMode("list");
    setActiveId(null);
    setPracticing(false);
  };

  const commitDraftFolder = useCallback(() => {
    const name = draftFolder?.trim();
    setDraftFolder(null);
    if (!name) return;
    const id = `folder-${Date.now()}`;
    setFolders(prev => [...prev, { id, name }]);
    setOpenFolders(prev => ({ ...prev, [id]: true }));
  }, [draftFolder]);

  const deleteFolder = useCallback((folderId: string) => {
    setSongs(prev => prev.map(s => s.folderId === folderId ? { ...s, folderId: null } : s));
    setFolders(prev => prev.filter(f => f.id !== folderId));
    setOpenFolders(prev => {
      const next = { ...prev };
      delete next[folderId];
      return next;
    });
  }, []);

  const moveSong = useCallback((songId: string, folderId: string | null) => {
    setSongs(prev => prev.map(s => s.id === songId ? { ...s, folderId } : s));
    if (folderId) setOpenFolders(p => ({ ...p, [folderId]: true }));
  }, []);

  const dropTargetAt = (clientX: number, clientY: number): string | null => {
    const ignore = document.querySelector(".da-song-row[data-dragging='true']") as HTMLElement | null;
    const prev = ignore?.style.pointerEvents;
    if (ignore) ignore.style.pointerEvents = "none";
    const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    if (ignore) ignore.style.pointerEvents = prev || "";
    if (!el) return null;
    const folder = el.closest("[data-drop-folder]") as HTMLElement | null;
    if (folder?.dataset.dropFolder) return folder.dataset.dropFolder;
    if (el.closest("[data-drop-root]")) return "root";
    return null;
  };

  const onSongPointerDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { id, x: e.clientX, y: e.clientY, moved: false };
  };

  const onSongPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dist = Math.hypot(e.clientX - d.x, e.clientY - d.y);
    if (!d.moved && dist < 8) return;
    if (!d.moved) {
      d.moved = true;
      setDraggingId(d.id);
    }
    setDropId(dropTargetAt(e.clientX, e.clientY));
  };

  const onSongPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    const wasDragging = d?.moved;
    const id = d?.id;
    const target = wasDragging ? dropTargetAt(e.clientX, e.clientY) : null;
    setDraggingId(null);
    setDropId(null);
    if (!id) return;
    if (wasDragging) {
      if (target === "root") moveSong(id, null);
      else if (target) moveSong(id, target);
      return;
    }
    openSong(id);
  };

  const songRow = (s: Song, nested: boolean) => (
    <button
      key={s.id}
      type="button"
      className="da-song-row"
      data-dragging={draggingId === s.id ? "true" : undefined}
      onPointerDown={e => onSongPointerDown(e, s.id)}
      onPointerMove={onSongPointerMove}
      onPointerUp={onSongPointerUp}
      onPointerCancel={onSongPointerUp}
      style={{
        ...btnBase,
        textAlign: "left",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        padding: nested ? "5px 8px 5px 18px" : "6px 8px",
        background: draggingId === s.id ? "rgba(175,169,236,0.18)" : "rgba(255,255,255,0.03)",
        boxShadow: "none",
        opacity: draggingId === s.id ? 0.55 : 1,
        cursor: draggingId ? "grabbing" : "grab",
        touchAction: "none",
      }}
    >
      <span className="da-song-title" style={{
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        color: "rgba(255,255,255,0.85)",
      }}>{s.title}</span>
      {s.key ? (
        <span className="da-key-badge" style={{
          flexShrink: 0, fontSize: 10, color: "#AFA9EC",
          border: "1px solid rgba(175,169,236,0.35)",
          borderRadius: 4, padding: "1px 5px",
        }}>{s.key}</span>
      ) : null}
    </button>
  );

  // ── LIST ─────────────────────────────────────────────────────────────────
  if (mode === "list") {
    return (
      <div className="da-chords" style={{
        width: panelW, height: panelH, display: "flex", flexDirection: "column",
        gap: 6, boxSizing: "border-box", userSelect: "none",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
          <span className="da-songs-count" style={{
            fontFamily: "monospace", fontSize: 10, letterSpacing: "0.08em",
            color: "rgba(255,255,255,0.4)",
          }}>
            SONGS ({songs.length})
          </span>
          <div style={{ display: "flex", gap: 5 }}>
            <button type="button" onClick={() => setDraftFolder("")} style={{
              ...btnBase,
            }}>+ FOLDER</button>
            <button type="button" onClick={startNew} style={{
              ...btnBase,
              borderColor: "rgba(175,169,236,0.55)",
              color: "#AFA9EC",
              background: "rgba(175,169,236,0.1)",
             
            }}>+ ADD</button>
          </div>
        </div>

        <div
          className="da-songs-scroll"
          data-drop-root=""
          style={{
            flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4,
            minHeight: 0, boxShadow: "none",
            borderRadius: 8,
            outline: dropId === "root" && draggingId ? "1px dashed rgba(175,169,236,0.55)" : "none",
            outlineOffset: -1,
          }}
        >
          {draftFolder !== null && (
            <input
              autoFocus
              value={draftFolder}
              placeholder="Folder name"
              onChange={e => setDraftFolder(e.target.value)}
              onBlur={commitDraftFolder}
              onKeyDown={e => {
                if (e.key === "Enter") commitDraftFolder();
                if (e.key === "Escape") setDraftFolder(null);
              }}
              style={fieldStyle}
            />
          )}

          {folders.map(f => {
            const kids = songs.filter(s => s.folderId === f.id);
            const open = !!openFolders[f.id];
            const hot = dropId === f.id;
            return (
              <div
                key={f.id}
                data-drop-folder={f.id}
                style={{ display: "flex", flexDirection: "column", gap: 3 }}
              >
                <div
                  className="da-song-row da-folder-row"
                  style={{
                    display: "flex", alignItems: "center", gap: 6,
                    padding: "5px 6px 5px 8px",
                    borderRadius: 8,
                    border: hot
                      ? "0.5px solid rgba(175,169,236,0.7)"
                      : "0.5px solid rgba(255,255,255,0.18)",
                    background: hot ? "rgba(175,169,236,0.16)" : "rgba(175,169,236,0.06)",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setOpenFolders(p => ({ ...p, [f.id]: !open }))}
                    style={{
                      ...btnBase, border: "none", padding: "0 2px",
                      flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 6,
                      textAlign: "left",
                    }}
                  >
                    <span style={{ fontSize: 10, color: "#AFA9EC", width: 10 }}>{open ? "▾" : "▸"}</span>
                    <span className="da-song-title" style={{
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      color: "rgba(255,255,255,0.9)", fontSize: 11,
                    }}>
                      {f.name}
                    </span>
                    <span style={{
                      flexShrink: 0, fontSize: 9, color: "rgba(175,169,236,0.7)",
                      fontVariantNumeric: "tabular-nums",
                    }}>{kids.length}</span>
                  </button>
                  <button
                    type="button"
                    title="Delete folder (songs are kept)"
                    onClick={() => deleteFolder(f.id)}
                    style={{
                      ...btnBase,
                      borderColor: "rgba(239,68,68,0.4)", color: "#ef4444",
                      display: "inline-flex", alignItems: "center", justifyContent: "center",
                    }}
                  >
                    <TrashIcon />
                  </button>
                </div>
                {open && kids.map(s => songRow(s, true))}
                {open && kids.length === 0 && (
                  <div style={{
                    fontFamily: "monospace", fontSize: 9, color: "rgba(255,255,255,0.28)",
                    padding: "2px 8px 4px 18px",
                  }}>
                    Drop songs here
                  </div>
                )}
              </div>
            );
          })}

          {songs.filter(s => !s.folderId).map(s => songRow(s, false))}

          {songs.length === 0 && folders.length === 0 && draftFolder === null ? (
            <div style={{
              fontFamily: "monospace", fontSize: 11, color: "rgba(255,255,255,0.3)",
              padding: "20px 0", textAlign: "center",
            }}>
              No songs yet
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  // ── EDIT ─────────────────────────────────────────────────────────────────
  if (mode === "edit") {
    return (
      <div className="da-chords" style={{
        width: panelW, height: panelH, display: "flex", flexDirection: "column",
        gap: 4, boxSizing: "border-box", userSelect: "none",
      }}>
        <div style={{ display: "flex", gap: 4 }}>
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="Song title"
            style={{ ...fieldStyle, flex: 1 }}
          />
          <input
            value={songKey}
            onChange={e => setSongKey(e.target.value)}
            placeholder="Key"
            style={{ ...fieldStyle, width: 52, flexShrink: 0, textAlign: "center" }}
          />
        </div>
        <textarea
          value={chordText}
          onChange={e => setChordText(e.target.value)}
          placeholder={"[Verse]\nG D Em C\n\n[Chorus]\nAm F C G"}
          spellCheck={false}
          style={{
            ...fieldStyle,
            flex: 1,
            minHeight: 0,
            resize: "none",
            lineHeight: 1.35,
          }}
        />
        <div style={{
          fontFamily: "monospace", fontSize: 9, color: "rgba(255,255,255,0.28)",
          letterSpacing: "0.04em",
        }}>
          blank line / --- = new verse · [Label] = section name
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button type="button" onClick={backToList} style={{ ...btnBase, flex: 1, padding: "4px 0" }}>
            CANCEL
          </button>
          <button
            type="button"
            onClick={saveSong}
            disabled={!title.trim() || parseChordText(chordText).length === 0}
            style={{
              ...btnBase,
              flex: 1,
              padding: "4px 0",
              borderColor: "rgba(175,169,236,0.55)",
              color: "#AFA9EC",
              background: "rgba(175,169,236,0.12)",
              opacity: (!title.trim() || parseChordText(chordText).length === 0) ? 0.4 : 1,
            }}
          >
            SAVE
          </button>
        </div>
      </div>
    );
  }

  // ── VIEW (all chords visible) ────────────────────────────────────────────
  if (!active) {
    return null;
  }

  // Where each verse starts in the flat chord list the practice walks through
  const verseStart: number[] = [];
  for (let n = 0, vi = 0; vi < active.verses.length; vi++) {
    verseStart.push(n);
    n += active.verses[vi].chords.length;
  }

  const practiceStatus = !practice.signal ? "NO INPUT"
    : practice.wrong ? `✗ ${practice.heard || "TRY AGAIN"}`
    : practice.heard ? `♪ ${practice.heard}`
    : "STRUM IT";

  return (
    <div className="da-chords" style={{
      width: panelW, height: panelH, display: "flex", flexDirection: "column",
      gap: 4, boxSizing: "border-box", userSelect: "none",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button type="button" onClick={backToList} style={{ ...btnBase, padding: "2px 8px" }}>
          BACK
        </button>
        <span className="da-song-title" style={{
          flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis",
          whiteSpace: "nowrap", fontFamily: "monospace", fontSize: 12,
          fontWeight: 700, color: "rgba(255,255,255,0.9)",
        }}>
          {active.title}
        </span>
        {active.key ? (
          <span style={{
            flexShrink: 0, fontFamily: "monospace", fontSize: 10, color: "#AFA9EC",
            border: "1px solid rgba(175,169,236,0.4)", borderRadius: 4, padding: "1px 6px",
          }}>{active.key}</span>
        ) : null}
        <button type="button" onClick={startEdit} title="Edit song" style={{
          ...btnBase, padding: "2px 7px",
          display: "inline-flex", alignItems: "center", justifyContent: "center",
        }}>
          <EditIcon />
        </button>
        <button type="button" onClick={deleteSong} title="Delete song" style={{
          ...btnBase, padding: "2px 7px",
          borderColor: "rgba(239,68,68,0.45)", color: "#ef4444",
          display: "inline-flex", alignItems: "center", justifyContent: "center",
        }}>
          <TrashIcon />
        </button>
      </div>

      <div style={{ display: "flex", gap: 5 }}>
        <div style={{ display: "flex", flex: 1, minWidth: 0 }}>
        {(["chords", "takes"] as const).map((t, i) => (
          <button
            key={t}
            type="button"
            onClick={() => setViewTab(t)}
            style={{
              ...btnBase,
              flex: 1, fontSize: 9, letterSpacing: "0.1em", padding: "2px 0",
              borderRadius: i === 0 ? "7px 0 0 7px" : "0 7px 7px 0",
              marginLeft: i === 0 ? 0 : -0.5,
              borderColor: viewTab === t ? "rgba(175,169,236,0.6)" : "rgba(255,255,255,0.18)",
              color: viewTab === t ? "#AFA9EC" : "rgba(255,255,255,0.5)",
              background: viewTab === t ? "rgba(175,169,236,0.12)" : "transparent",
            }}
          >
            {t === "chords" ? "CHORDS" : `TAKES (${active.takes.length})`}
          </button>
        ))}
        </div>
        {viewTab === "chords" && (
          <button
            type="button"
            onClick={() => setPracticing(p => !p)}
            disabled={practice.total === 0}
            title={practice.total === 0
              ? "No chords here that can be listened for"
              : practicing ? "Stop listening" : "Play along: each chord lights up when it is heard"}
            style={{
              ...btnBase,
              flexShrink: 0, fontSize: 9, letterSpacing: "0.1em", padding: "2px 8px", borderRadius: 7,
              borderColor: practicing ? "rgba(245,185,113,0.7)" : "rgba(255,255,255,0.18)",
              color: practicing ? "#F5B971" : "rgba(255,255,255,0.5)",
              background: practicing ? "rgba(245,185,113,0.12)" : "transparent",
              opacity: practice.total === 0 ? 0.4 : 1,
            }}
          >
            {practicing ? "■ STOP" : "▶ PRACTICE"}
          </button>
        )}
      </div>

      {practiceOn && (
        <div className={`da-prac-bar${practice.done ? " is-done" : practice.wrong ? " is-wrong" : ""}`}>
          {practice.done ? (
            <>
              <span className="da-prac-target">DONE</span>
              <span className="da-prac-status">{practice.clean}/{practice.total} FIRST TRY</span>
              <button
                type="button"
                onClick={practice.restart}
                style={{ ...btnBase, flexShrink: 0, padding: "1px 7px", fontSize: 9 }}
              >
                AGAIN
              </button>
            </>
          ) : (
            <>
              <span className="da-prac-target">{songChords[practice.index]}</span>
              <span className="da-prac-tones">
                {practice.tones.map((t, i) => (
                  <span
                    key={`${t.name}-${i}`}
                    className={`da-prac-tone${t.heard ? " is-heard" : ""}${t.required ? "" : " is-optional"}`}
                    title={t.required ? undefined : "Often left out of this chord"}
                  >
                    {t.name}
                  </span>
                ))}
              </span>
              <span className="da-prac-status">{practiceStatus}</span>
              <span className="da-prac-count">{practice.played}/{practice.total}</span>
            </>
          )}
        </div>
      )}

      {viewTab === "takes" ? (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", gap: 5 }}>
            <button
              type="button"
              onClick={saveTakeToSong}
              disabled={!takeStore.pending}
              title={takeStore.pending ? "Save the last recording into this song" : "Press REC above the note views first"}
              style={{
                ...btnBase, flex: 1, padding: "3px 0",
                borderColor: "rgba(175,169,236,0.55)", color: "#AFA9EC",
                background: "rgba(175,169,236,0.1)",
                opacity: takeStore.pending ? 1 : 0.4,
              }}
            >
              + SAVE TAKE{takeStore.pending ? ` (${fmtDuration(takeStore.pending.durationMs)})` : ""}
            </button>
            <button
              type="button"
              onClick={() => midiInputRef.current?.click()}
              title="Import a .mid file as a take"
              style={{ ...btnBase, padding: "3px 8px" }}
            >
              IMPORT
            </button>
            <input
              ref={midiInputRef}
              type="file"
              accept=".mid,.midi,audio/midi"
              style={{ display: "none" }}
              onChange={importMidi}
            />
          </div>
          {takeError && (
            <div style={{ fontFamily: "monospace", fontSize: 9, color: "#ef4444" }}>{takeError}</div>
          )}
          <div className="da-songs-scroll" style={{
            flex: 1, overflowY: "auto", minHeight: 0,
            display: "flex", flexDirection: "column", gap: 3,
            paddingRight: 2, boxShadow: "none",
          }}>
            {active.takes.map(tk => {
              const loaded = takeStore.guide?.id === tk.id;
              return (
                <div
                  key={tk.id}
                  className="da-song-row"
                  style={{
                    display: "flex", flexDirection: "column",
                    padding: "3px 4px 3px 8px", borderRadius: 8,
                    border: loaded ? "0.5px solid rgba(245,185,113,0.7)" : "0.5px solid rgba(255,255,255,0.14)",
                    background: loaded ? "rgba(245,185,113,0.1)" : "rgba(255,255,255,0.03)",
                  }}
                >
                <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  {renamingTake?.id === tk.id ? (
                    <input
                      autoFocus
                      value={renamingTake.name}
                      onChange={e => setRenamingTake({ id: tk.id, name: e.target.value })}
                      onBlur={commitRename}
                      onKeyDown={e => {
                        if (e.key === "Enter") commitRename();
                        if (e.key === "Escape") setRenamingTake(null);
                      }}
                      style={{ ...fieldStyle, flex: 1, padding: "2px 6px" }}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => (loaded ? unloadGuide() : loadGuide(tk))}
                      onDoubleClick={() => setRenamingTake({ id: tk.id, name: tk.name })}
                      title={loaded ? "Remove guide from the note views" : "Show as a guide in Bars / Score (double-click to rename)"}
                      style={{
                        ...btnBase, border: "none", padding: 0, flex: 1, minWidth: 0,
                        display: "flex", alignItems: "center", gap: 6, textAlign: "left",
                      }}
                    >
                      <span style={{ fontSize: 9, width: 10, color: loaded ? "#F5B971" : "rgba(175,169,236,0.7)" }}>
                        {loaded ? "●" : "▸"}
                      </span>
                      <span className="da-song-title" style={{
                        flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis",
                        whiteSpace: "nowrap", color: loaded ? "#F5B971" : "rgba(255,255,255,0.85)",
                      }}>
                        {tk.name}
                      </span>
                      <span style={{ flexShrink: 0, fontSize: 9, color: "rgba(255,255,255,0.4)" }}>
                        {fmtDuration(tk.durationMs)} · {tk.notes.length}n
                      </span>
                    </button>
                  )}
                  <button
                    type="button"
                    title={tk.sync ? `In time at ${tempoLabel(tk)}. Edit the sync` : "Not in time. Set a tempo"}
                    onClick={() => setSyncEditId(id => (id === tk.id ? null : tk.id))}
                    style={{
                      ...btnBase, padding: "1px 5px", fontSize: 9,
                      borderColor: tk.sync || syncEditId === tk.id ? "rgba(175,169,236,0.55)" : "rgba(255,255,255,0.25)",
                      color: tk.sync ? SYNC_ACCENT : "rgba(255,255,255,0.45)",
                      background: syncEditId === tk.id ? "rgba(175,169,236,0.12)" : "transparent",
                    }}
                  >
                    {tk.sync ? `♩${Math.round(tk.bpm)}` : "♩"}
                  </button>
                  <button
                    type="button"
                    title="Export as MIDI"
                    onClick={() => void exportTakeMidi(tk, active.title)}
                    style={{ ...btnBase, padding: "1px 6px", fontSize: 9 }}
                  >
                    MIDI
                  </button>
                  <button
                    type="button"
                    title="Delete take"
                    onClick={() => deleteTake(tk)}
                    style={{
                      ...btnBase, padding: "1px 5px",
                      borderColor: "rgba(239,68,68,0.4)", color: "#ef4444",
                      display: "inline-flex", alignItems: "center",
                    }}
                  >
                    <TrashIcon />
                  </button>
                </div>
                {syncEditId === tk.id && <TakeSyncEditor take={tk} onChange={editTake} />}
                </div>
              );
            })}
            {active.takes.length === 0 && (
              <div style={{
                fontFamily: "monospace", fontSize: 10, color: "rgba(255,255,255,0.3)",
                padding: "12px 4px", textAlign: "center", lineHeight: 1.5,
              }}>
                No takes yet. Press REC above Bars / Score,<br />then save it here or import a MIDI file.
              </div>
            )}
          </div>
        </div>
      ) : (
      <div ref={chordScrollRef} className="da-songs-scroll" style={{
        flex: 1, overflowY: "auto", minHeight: 0, position: "relative",
        paddingRight: 2, boxShadow: "none",
      }}>
        <div style={roomy ? { columnWidth: 200, columnGap: 18 } : { display: "flex", flexDirection: "column", gap: 6 }}>
        {active.verses.map((v, vi) => (
          <div key={`${v.label}-${vi}`} style={roomy ? { breakInside: "avoid", marginBottom: 10 } : undefined}>
            <div style={{
              fontFamily: "monospace", fontSize: 9, letterSpacing: "0.1em",
              color: "rgba(175,169,236,0.65)", marginBottom: 3,
              textTransform: "uppercase",
            }}>
              {v.label}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, justifyContent: "center" }}>
              {v.chords.map((c, ci) => {
                const at = verseStart[vi] + ci;
                const canPlay = practiceOn && practice.playable[at];
                const current = canPlay && at === practice.index;
                const state = !practiceOn ? undefined
                  : !canPlay ? "da-prac-chip is-skip"
                  : current ? "da-prac-chip is-current"
                  : practice.results[at] ? `da-prac-chip is-${practice.results[at]}`
                  : "da-prac-chip";
                return (
                <span
                  key={`${c}-${ci}`}
                  ref={current ? currentChipRef : undefined}
                  className={state}
                  onClick={canPlay ? () => practice.jump(at) : undefined}
                  title={canPlay ? "Start from this chord" : undefined}
                  style={{
                    fontFamily: "monospace",
                    fontSize: 13,
                    fontWeight: 700,
                    color: "#fff",
                    background: "rgba(175,169,236,0.14)",
                    border: "1px solid rgba(175,169,236,0.3)",
                    borderRadius: 5,
                    padding: "2px 7px",
                    letterSpacing: "0.02em",
                  }}
                >
                  {c}
                </span>
                );
              })}
            </div>
          </div>
        ))}
        </div>
      </div>
      )}
    </div>
  );
};

export default DashboardChordBank;