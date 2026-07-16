import { useCallback, useEffect, useState, FC } from "react";

export type ChordVerse = {
  label: string;
  chords: string[];
};

export type Song = {
  id: string;
  title: string;
  key: string;
  verses: ChordVerse[];
};

const LS_KEY = "stanza-chord-bank";

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

function loadSongs(): Song[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw) as Song[];
  } catch { /* ignore */ }
  return [];
}

function saveSongs(songs: Song[]) {
  localStorage.setItem(LS_KEY, JSON.stringify(songs));
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
  const [songs, setSongs] = useState<Song[]>(() => loadSongs());
  const [mode, setMode] = useState<Mode>("list");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [songKey, setSongKey] = useState("");
  const [chordText, setChordText] = useState("");

  useEffect(() => { saveSongs(songs); }, [songs]);

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
  }, [activeId, title, songKey, chordText]);

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

  // ── LIST ─────────────────────────────────────────────────────────────────
  if (mode === "list") {
    return (
      <div className="da-chords" style={{
        width: 300, height: 168, display: "flex", flexDirection: "column",
        gap: 6, boxSizing: "border-box", userSelect: "none",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span className="da-songs-count" style={{
            fontFamily: "monospace", fontSize: 10, letterSpacing: "0.08em",
            color: "rgba(255,255,255,0.4)",
          }}>
            SONGS ({songs.length})
          </span>
          <button type="button" onClick={startNew} style={{
            ...btnBase,
            borderColor: "rgba(175,169,236,0.55)",
            color: "#AFA9EC",
            background: "rgba(175,169,236,0.1)",
            padding: "3px 10px",
          }}>+ ADD</button>
        </div>

        <div className="da-songs-scroll" style={{
          flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4,
          minHeight: 0, boxShadow: "none",
        }}>
          {songs.length === 0 ? (
            <div style={{
              fontFamily: "monospace", fontSize: 11, color: "rgba(255,255,255,0.3)",
              padding: "20px 0", textAlign: "center",
            }}>
              No songs yet
            </div>
          ) : songs.map(s => (
            <button
              key={s.id}
              type="button"
              className="da-song-row"
              onClick={() => openSong(s.id)}
              style={{
                ...btnBase,
                textAlign: "left",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                padding: "6px 8px",
                background: "rgba(255,255,255,0.03)",
                boxShadow: "none",
              }}
            >
              <span className="da-song-title" style={{
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                color: "rgba(255,255,255,0.85)",
              }}>{s.title}</span>
              {s.key ? (
                <span style={{
                  flexShrink: 0, fontSize: 10, color: "#AFA9EC",
                  border: "1px solid rgba(175,169,236,0.35)",
                  borderRadius: 4, padding: "1px 5px",
                }}>{s.key}</span>
              ) : null}
            </button>
          ))}
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
          &lsaquo;
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
        <button type="button" onClick={startEdit} style={{ ...btnBase, padding: "2px 7px" }}>
          EDIT
        </button>
        <button type="button" onClick={deleteSong} style={{
          ...btnBase, padding: "2px 7px",
          borderColor: "rgba(239,68,68,0.45)", color: "#ef4444",
        }}>
          DEL
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