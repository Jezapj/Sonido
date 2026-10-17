import { useCallback, useEffect, useRef, useState, FC } from "react";

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
};

export type SongFolder = {
  id: string;
  name: string;
};

type BankStore = {
  songs: Song[];
  folders: SongFolder[];
};

const LS_KEY = "stanza-chord-bank";

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

function normalizeSong(s: Song): Song {
  return { ...s, folderId: s.folderId ?? null };
}

function loadBank(): BankStore {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { songs: [], folders: [] };
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      return { songs: data.map(normalizeSong), folders: [] };
    }
    return {
      songs: Array.isArray(data.songs) ? data.songs.map(normalizeSong) : [],
      folders: Array.isArray(data.folders) ? data.folders : [],
    };
  } catch { /* ignore */ }
  return { songs: [], folders: [] };
}

function saveBank(store: BankStore) {
  localStorage.setItem(LS_KEY, JSON.stringify(store));
}

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

const DashboardChordBank: FC = () => {
  const [songs, setSongs] = useState<Song[]>(() => loadBank().songs);
  const [folders, setFolders] = useState<SongFolder[]>(() => loadBank().folders);
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

  useEffect(() => { saveBank({ songs, folders }); }, [songs, folders]);

  const active = songs.find(s => s.id === activeId) ?? null;

  const openSong = useCallback((id: string) => {
    setActiveId(id);
    setMode("view");
  }, []);

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
        width: 300, height: 168, display: "flex", flexDirection: "column",
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
        width: 300, height: 168, display: "flex", flexDirection: "column",
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

  return (
    <div className="da-chords" style={{
      width: 300, height: 168, display: "flex", flexDirection: "column",
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

      <div className="da-songs-scroll" style={{
        flex: 1, overflowY: "auto", minHeight: 0,
        display: "flex", flexDirection: "column", gap: 6,
        paddingRight: 2, boxShadow: "none",
      }}>
        {active.verses.map((v, vi) => (
          <div key={`${v.label}-${vi}`}>
            <div style={{
              fontFamily: "monospace", fontSize: 9, letterSpacing: "0.1em",
              color: "rgba(175,169,236,0.65)", marginBottom: 3,
              textTransform: "uppercase",
            }}>
              {v.label}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, justifyContent: "center" }}>
              {v.chords.map((c, ci) => (
                <span
                  key={`${c}-${ci}`}
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
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default DashboardChordBank;