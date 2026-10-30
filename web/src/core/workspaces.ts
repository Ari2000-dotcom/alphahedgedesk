import { useSyncExternalStore } from "react";

/**
 * Named desks the user keeps on this computer: the whole layout (`DockviewApi.toJSON()`, its panels
 * and what each has picked) under a name, to bring back later from the Workspace menu. Saving under
 * a name already used replaces that one.
 */
export interface SavedWorkspace {
  id: string;
  name: string;
  savedAt: number;
  panels: number;
  layout: unknown;
}

interface State {
  list: readonly SavedWorkspace[];
  /** The one last saved or loaded: marked in the menu. */
  current: string | null;
}

const KEY = "mh.workspaces";
const CURRENT_KEY = "mh.workspace.current";

function read(): State {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    const list = Array.isArray(raw) ? (raw as SavedWorkspace[]).filter((w) => w && typeof w.id === "string" && typeof w.name === "string" && w.layout) : [];
    return { list, current: localStorage.getItem(CURRENT_KEY) };
  } catch {
    return { list: [], current: null };
  }
}

let state: State = read();
const listeners = new Set<() => void>();

function commit(next: State) {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next.list));
    if (next.current) localStorage.setItem(CURRENT_KEY, next.current);
    else localStorage.removeItem(CURRENT_KEY);
  } catch {
    // A per-viewer convenience: not being able to keep it is not an error to show.
  }
  for (const fn of listeners) fn();
}

export const useWorkspaces = (): State =>
  useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
  );

/** Keeps `layout` under `name`, newest first; a name already kept is replaced in place. */
export function saveWorkspace(name: string, layout: unknown, panels: number): SavedWorkspace {
  const clean = name.trim().replace(/\s+/g, " ").slice(0, 40);
  const same = state.list.find((w) => w.name.toLowerCase() === clean.toLowerCase());
  const saved: SavedWorkspace = { id: same?.id ?? `ws${Date.now().toString(36)}`, name: same?.name ?? clean, savedAt: Date.now(), panels, layout };
  commit({ list: [saved, ...state.list.filter((w) => w.id !== saved.id)], current: saved.id });
  return saved;
}

export function removeWorkspace(id: string) {
  commit({ list: state.list.filter((w) => w.id !== id), current: state.current === id ? null : state.current });
}

export function markCurrentWorkspace(id: string | null) {
  if (state.current !== id) commit({ ...state, current: id });
}
