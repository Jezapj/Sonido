/**
 * profile
 *
 * Everything worth keeping (songs and their takes, the preset bank, settings,
 * practice defaults, identity and stats) lives in one JSON file, the profile.
 * This store holds the loaded profile and writes each change back to its file.
 * A file that can't be read is never overwritten.
 */

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { DEFAULT_SETTINGS, type AppSettings } from "./Settings";
import { unloadGuide } from "./takes";
import type { Song, SongFolder } from "./DashboardChordBank";
import type { PresetEntry } from "./PresetsCard";

const FORMAT = "stanza-profile";
const VERSION = 1;
const EXTENSION = "stanzaprofile";
const FILE_FILTERS = [{ name: "Stanza profile", extensions: [EXTENSION] }];
const SAVE_DELAY_MS = 400;

const LS_LAST_PATH = "stanza-profile-path";
const LS_MIGRATED = "stanza-profile-migrated";

export type Theme = "dark" | "light";

export interface PracticeDefaults {
  bpm: number;
  sigIdx: number;
  volume: number;
  handsOn: boolean;
  handLook: string;
  guideSound: boolean;
}

export interface ProfileData {
  format: typeof FORMAT;
  version: number;
  name: string;
  avatar: number;
  createdAt: string;
  sessions: number;
  presetsSaved: number;
  theme: Theme;
  settings: AppSettings;
  practice: PracticeDefaults;
  songs: Song[];
  folders: SongFolder[];
  presets: PresetEntry[];
}

export type SaveStatus = "idle" | "saving" | "saved" | "error";

export interface ProfileState {
  ready: boolean;                   // the startup load has finished
  path: string | null;              // null until a profile is loaded or created
  data: ProfileData;
  saveStatus: SaveStatus;
  error: string | null;
}

const DEFAULT_PRACTICE: PracticeDefaults = { bpm: 120, sigIdx: 2, volume: 0.7, handsOn: false, handLook: "outline", guideSound: false };

function blank(name: string): ProfileData {
  return {
    format: FORMAT,
    version: VERSION,
    name,
    avatar: 0,
    createdAt: new Date().toISOString(),
    sessions: 0,
    presetsSaved: 0,
    theme: "dark",
    settings: { ...DEFAULT_SETTINGS },
    practice: { ...DEFAULT_PRACTICE },
    songs: [],
    folders: [],
    presets: [],
  };
}

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

const normalizeSong = (s: Song): Song => ({ ...s, folderId: s.folderId ?? null, takes: Array.isArray(s.takes) ? s.takes : [] });
const songsOf = (value: unknown) => (Array.isArray(value) ? (value as Song[]).map(normalizeSong) : []);

/** Checks a file's contents, filling in anything missing. Throws if it isn't a profile this version can read. */
function parseProfile(text: string): ProfileData {
  let raw: Partial<ProfileData>;
  try { raw = JSON.parse(text); } catch { throw new Error("the file is damaged or isn't a Stanza profile"); }
  if (raw?.format !== FORMAT) throw new Error("that file isn't a Stanza profile");
  if (count(raw.version) > VERSION) throw new Error("it was saved by a newer version of Stanza");
  return {
    ...blank(typeof raw.name === "string" ? raw.name : ""),
    ...(typeof raw.createdAt === "string" ? { createdAt: raw.createdAt } : {}),
    avatar: count(raw.avatar),
    sessions: count(raw.sessions),
    presetsSaved: count(raw.presetsSaved),
    theme: raw.theme === "light" ? "light" : "dark",
    settings: { ...DEFAULT_SETTINGS, ...raw.settings },
    practice: { ...DEFAULT_PRACTICE, ...raw.practice },
    songs: songsOf(raw.songs),
    folders: Array.isArray(raw.folders) ? raw.folders : [],
    presets: Array.isArray(raw.presets) ? raw.presets : [],
  };
}

const lsGet = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const lsSet = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* not essential */ } };

function lsJson(key: string): any {
  try { return JSON.parse(lsGet(key) ?? "null"); } catch { return null; }
}

/** What earlier versions kept in browser storage. It is left in place as a backup. */
function fromBrowserStorage(name: string): ProfileData {
  const data = blank(name);
  const bank = lsJson("stanza-chord-bank");
  data.songs = songsOf(Array.isArray(bank) ? bank : bank?.songs);
  data.folders = Array.isArray(bank?.folders) ? bank.folders : [];
  const presets = lsJson("stanza-preset-bank");
  data.presets = Array.isArray(presets) ? presets : [];
  data.settings = { ...DEFAULT_SETTINGS, ...lsJson("stanza-settings") };
  data.sessions = count(Number(lsGet("stanza-sessions")));
  data.presetsSaved = count(Number(lsGet("stanza-presets-saved")));
  data.practice.handsOn = lsGet("stanza-piano-hands-on") === "1";
  data.practice.handLook = lsGet("stanza-piano-hand-look") ?? "outline";
  return data;
}

// ── Store ─────────────────────────────────────────────────────────────────────

let state: ProfileState = { ready: false, path: null, data: blank(""), saveStatus: "idle", error: null };
const listeners = new Set<() => void>();

function setState(patch: Partial<ProfileState>) {
  state = { ...state, ...patch };
  listeners.forEach(l => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export const getProfile = () => state.data;
export const useProfileState = () => useSyncExternalStore(subscribe, () => state);
/** For components that shouldn't re-render on every save. `select` must return a stable value. */
export const useProfileValue = <T>(select: (data: ProfileData) => T) => useSyncExternalStore(subscribe, () => select(state.data));

export function updateProfile(change: Partial<ProfileData> | ((data: ProfileData) => Partial<ProfileData>)) {
  setState({ data: { ...state.data, ...(typeof change === "function" ? change(state.data) : change) } });
  scheduleSave();
}

export function updatePractice(change: Partial<PracticeDefaults>) {
  updateProfile(data => ({ practice: { ...data.practice, ...change } }));
}

// ── Saving ────────────────────────────────────────────────────────────────────

const serialize = (data: ProfileData) => JSON.stringify(data, null, 2);

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let lastWritten: string | null = null;
let writes: Promise<void> = Promise.resolve();

function scheduleSave() {
  if (!state.path) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushProfile, SAVE_DELAY_MS);
}

/** Writes any unsaved change now. Resolves once all writes have finished. */
export function flushProfile(): Promise<void> {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const path = state.path;
  if (!path) return writes;
  const contents = serialize(state.data);
  if (contents === lastWritten) return writes;
  lastWritten = contents;
  setState({ saveStatus: "saving" });
  writes = writes.then(async () => {
    try {
      await invoke("write_text_file_atomic", { path, contents });
      if (lastWritten === contents) setState({ saveStatus: "saved", error: null });
    } catch (e) {
      if (lastWritten === contents) lastWritten = null;   // the next change tries again
      setState({ saveStatus: "error", error: `Couldn't save: ${message(e)}` });
    }
  });
  return writes;
}

if (typeof window !== "undefined") window.addEventListener("pagehide", () => { void flushProfile(); });

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ── Loading and switching ─────────────────────────────────────────────────────

async function readProfile(path: string) {
  return parseProfile(await invoke<string>("read_text_file", { path }));
}

function adopt(path: string, data: ProfileData, onDisk: boolean) {
  unloadGuide();   // a loaded guide take belongs to the previous profile's songs
  lastWritten = onDisk ? serialize(data) : null;
  lsSet(LS_LAST_PATH, path);
  setState({ path, data, saveStatus: "idle", error: null });
}

let started: Promise<void> | null = null;

/** Reopens the last profile. Safe to call more than once. */
export function initProfile(): Promise<void> {
  started ??= (async () => {
    const path = lsGet(LS_LAST_PATH);
    if (path) {
      try {
        adopt(path, await readProfile(path), true);
      } catch (e) {
        setState({ error: `Couldn't open ${path}: ${message(e)}` });
      }
    }
    setState({ ready: true });
  })();
  return started;
}

const sameName = (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase();

/**
 * Called from the landing screen. The loaded profile carries on if the name
 * matches it; otherwise that name's profile is opened, or created if it's new.
 */
export async function enterProfile(typed: string) {
  await initProfile();
  const name = typed.trim().toUpperCase();
  if (!state.path || (name && !sameName(name, state.data.name))) {
    await flushProfile();
    const path = await invoke<string>("default_profile_path", { name: name || "PLAYER" });
    if (await invoke<boolean>("file_exists", { path })) {
      adopt(path, await readProfile(path), true);
    } else if (lsGet(LS_MIGRATED)) {
      adopt(path, blank(name || "PLAYER"), false);
    } else {
      adopt(path, fromBrowserStorage(name || "PLAYER"), false);
      lsSet(LS_MIGRATED, "1");
    }
  }
  updateProfile(data => ({ sessions: data.sessions + 1 }));
  await flushProfile();
}

const stem = (path: string) => (path.split(/[\\/]/).pop() ?? path).replace(/\.[^.]+$/, "");
const withExtension = (path: string) => (path.toLowerCase().endsWith(`.${EXTENSION}`) ? path : `${path}.${EXTENSION}`);

/** Starts an empty profile in a file the user picks, named after that file. */
export async function newProfile() {
  const chosen = await save({ title: "New profile", filters: FILE_FILTERS, defaultPath: `New profile.${EXTENSION}` });
  if (!chosen) return;
  await flushProfile();
  const path = withExtension(chosen);
  adopt(path, blank(stem(path).toUpperCase()), false);
  await flushProfile();
}

/** Returns an error message for the page to show, if the file can't be opened. */
export async function openProfile(): Promise<string | null> {
  const chosen = await open({ title: "Open profile", filters: FILE_FILTERS, multiple: false, directory: false });
  if (typeof chosen !== "string") return null;
  await flushProfile();
  try {
    adopt(chosen, await readProfile(chosen), true);
    return null;
  } catch (e) {
    return `Couldn't open that file: ${message(e)}`;
  }
}

/** Copies the loaded profile to a new file and carries on in that one. */
export async function saveProfileAs() {
  const chosen = await save({ title: "Save profile as", filters: FILE_FILTERS, defaultPath: `${state.data.name || "Profile"}.${EXTENSION}` });
  if (!chosen) return;
  await flushProfile();
  adopt(withExtension(chosen), state.data, false);
  await flushProfile();
}
