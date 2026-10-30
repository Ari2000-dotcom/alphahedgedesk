import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { DockviewApi } from "dockview";

import { markCurrentWorkspace, removeWorkspace, saveWorkspace, useWorkspaces, type SavedWorkspace } from "../core/workspaces";
import { CheckIcon, ChevronDownIcon, CloseIcon, SaveIcon, SearchIcon, TrashIcon, WorkspaceIcon } from "../ui/icons";
import "./workspace-menu.css";

/** "Today 4:21 pm", "Yesterday", "3 Nov": when a workspace was kept, short. */
function when(at: number): string {
  const day = (t: number) => new Date(t).toDateString();
  const time = new Date(at).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
  if (day(at) === day(Date.now())) return `Today ${time}`;
  if (day(at) === day(Date.now() - 86_400_000)) return "Yesterday";
  return new Date(at).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

/**
 * The Workspace screen's tab, with its menu: a search over the workspaces kept on this computer,
 * each a named desk (its icon, its name, how many containers it holds and when it was kept) to
 * bring back with a click, and a field at the foot to keep the desk as it is under a name.
 */
export function WorkspaceNav({
  active,
  onOpen,
  getApi,
  onLoad,
}: Readonly<{
  active: boolean;
  /** The tab itself: go to the Workspace screen. */
  onOpen: () => void;
  getApi: () => DockviewApi | null;
  onLoad: (workspace: SavedWorkspace) => void;
}>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [flash, setFlash] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const { list, current } = useWorkspaces();

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(""), 2200);
    return () => clearTimeout(timer);
  }, [flash]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? list.filter((w) => w.name.toLowerCase().includes(q)) : list;
  }, [list, query]);
  const currentName = list.find((w) => w.id === current)?.name ?? null;

  const save = () => {
    const api = getApi();
    const clean = name.trim();
    if (!api || !clean) return;
    const replaced = list.some((w) => w.name.toLowerCase() === clean.toLowerCase());
    saveWorkspace(clean, api.toJSON(), api.panels.length);
    setName("");
    setFlash(replaced ? `Updated “${clean}”` : `Saved “${clean}”`);
  };
  const onNameKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") save();
  };

  return (
    <div className="mh-wsnav" ref={root}>
      <button type="button" className="mh-nav-item mh-nav-icon" aria-current={active ? "page" : undefined} onClick={onOpen}>
        <WorkspaceIcon size={15} />
        Workspace
      </button>
      <button type="button" className="mh-nav-caret" aria-label="Saved workspaces" aria-expanded={open} aria-haspopup="dialog" title="Saved workspaces" onClick={() => setOpen((v) => !v)}>
        <ChevronDownIcon size={12} />
      </button>
      {open ? (
        <div className="mh-ws" role="dialog" aria-label="Saved workspaces">
          <div className="mh-ws-search">
            <SearchIcon size={14} />
            <input ref={search} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search workspaces" aria-label="Search workspaces" spellCheck={false} />
            {query ? (
              <button type="button" aria-label="Clear the search" onClick={() => setQuery("")}>
                <CloseIcon size={12} />
              </button>
            ) : null}
          </div>

          <div className="mh-ws-head">
            <span>Saved workspaces</span>
            <em>{list.length}</em>
          </div>
          <ul className="mh-ws-list">
            {shown.map((w) => (
              <li key={w.id}>
                <button
                  type="button"
                  className="mh-ws-item"
                  data-current={w.id === current || undefined}
                  onClick={() => {
                    markCurrentWorkspace(w.id);
                    onLoad(w);
                    setOpen(false);
                  }}
                >
                  <span className="mh-ws-icon">
                    <WorkspaceIcon size={18} />
                  </span>
                  <span className="mh-ws-text">
                    <span className="mh-ws-name">{w.name}</span>
                    <span className="mh-ws-meta">
                      {w.panels} {w.panels === 1 ? "container" : "containers"} · {when(w.savedAt)}
                    </span>
                  </span>
                  {w.id === current ? <CheckIcon size={14} /> : null}
                </button>
                <button type="button" className="mh-ws-del" aria-label={`Delete ${w.name}`} title="Delete this workspace" onClick={() => removeWorkspace(w.id)}>
                  <TrashIcon size={14} />
                </button>
              </li>
            ))}
          </ul>
          {shown.length === 0 ? (
            <div className="mh-ws-empty">
              <WorkspaceIcon size={22} />
              {list.length === 0 ? <span>No saved workspaces yet. Name this desk below to keep it.</span> : <span>No workspace called “{query}”.</span>}
            </div>
          ) : null}

          <div className="mh-ws-save">
            <div className="mh-ws-head">
              <span>Save this desk</span>
              {currentName ? <em>on “{currentName}”</em> : null}
            </div>
            <div className="mh-ws-savebar">
              <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={onNameKey} placeholder="Name this workspace" aria-label="Workspace name" maxLength={40} spellCheck={false} />
              <button type="button" className="mh-ws-savebtn" disabled={!name.trim()} onClick={save}>
                <SaveIcon size={14} />
                Save
              </button>
            </div>
            <div className="mh-ws-flash" aria-live="polite">
              {flash}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
