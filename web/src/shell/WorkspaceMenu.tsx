import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { DockviewApi } from "dockview";

import { markCurrentWorkspace, removeWorkspace, saveWorkspace, useWorkspaces, type SavedWorkspace } from "../core/workspaces";
import { CheckIcon, ChevronDownIcon, CloseIcon, SearchIcon, TrashIcon, WorkspaceIcon } from "../ui/icons";
import "./workspace-menu.css";

/** "Today 4:21 pm", "Yesterday", "3 Nov": when a workspace was kept, short. */
function when(at: number): string {
  const day = (t: number) => new Date(t).toDateString();
  const time = new Date(at).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
  if (day(at) === day(Date.now())) return `Today ${time}`;
  if (day(at) === day(Date.now() - 86_400_000)) return "Yesterday";
  return new Date(at).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

type Rect = readonly [x: number, y: number, w: number, h: number];

interface SerializedNode {
  type?: string;
  size?: number;
  data?: unknown;
}

/**
 * The containers of a saved layout as rectangles on a unit square, read from the dock's own
 * serialisation (a tree of rows and columns, each child sized along its parent's axis), so a row in
 * the menu shows the arrangement the workspace actually has.
 */
function rectsOf(layout: unknown): Rect[] {
  const grid = (layout as { grid?: { root?: SerializedNode; orientation?: string } } | null)?.grid;
  const out: Rect[] = [];
  const walk = (node: SerializedNode | undefined, x: number, y: number, w: number, h: number, horizontal: boolean) => {
    if (!node) return;
    if (node.type === "branch" && Array.isArray(node.data)) {
      const kids = node.data as SerializedNode[];
      const total = kids.reduce((sum, k) => sum + (k.size && k.size > 0 ? k.size : 1), 0);
      let at = 0;
      for (const kid of kids) {
        const share = (kid.size && kid.size > 0 ? kid.size : 1) / total;
        if (horizontal) walk(kid, x + at * w, y, share * w, h, !horizontal);
        else walk(kid, x, y + at * h, w, share * h, !horizontal);
        at += share;
      }
    } else {
      out.push([x, y, w, h]);
    }
  };
  walk(grid?.root, 0, 0, 1, 1, grid?.orientation !== "VERTICAL");
  return out.length > 0 ? out : [[0, 0, 1, 1]];
}

/** A workspace's arrangement, drawn small. */
function Arrangement({ layout }: Readonly<{ layout: unknown }>) {
  const rects = useMemo(() => rectsOf(layout), [layout]);
  return (
    <svg className="mh-ws-thumb" width="24" height="18" viewBox="0 0 24 18" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden>
      {rects.map(([x, y, w, h], i) => (
        <rect key={i} x={1 + x * 22 + 0.5} y={1 + y * 16 + 0.5} width={Math.max(1, w * 22 - 1)} height={Math.max(1, h * 16 - 1)} rx="1" />
      ))}
    </svg>
  );
}

/**
 * The Workspace screen's tab, with its menu of saved workspaces: a search, one row for each (the
 * arrangement it has, its name, how many panels and when it was kept), and under them a field to
 * keep the current layout under a name. A click on a row brings it back.
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
  const [status, setStatus] = useState("");
  /** The row whose delete is waiting for its second click. */
  const [asking, setAsking] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const { list: kept, current } = useWorkspaces();

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
    if (!status) return;
    const timer = setTimeout(() => setStatus(""), 2400);
    return () => clearTimeout(timer);
  }, [status]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? kept.filter((w) => w.name.toLowerCase().includes(q)) : kept;
  }, [kept, query]);
  const currentName = kept.find((w) => w.id === current)?.name ?? null;

  const keep = (as: string) => {
    const api = getApi();
    const clean = as.trim();
    if (!api || !clean) return;
    const replaced = kept.some((w) => w.name.toLowerCase() === clean.toLowerCase());
    saveWorkspace(clean, api.toJSON(), api.panels.length);
    setName("");
    setStatus(replaced ? `Updated “${clean}”` : `Saved “${clean}”`);
  };

  /** Arrow keys move between the search field and the rows. */
  const rows = () => [...(list.current?.querySelectorAll<HTMLButtonElement>(".mh-ws-item") ?? [])];
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      rows()[0]?.focus();
    } else if (e.key === "Enter" && shown.length === 1) {
      load(shown[0]!);
    }
  };
  const onRowKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const all = rows();
    const at = all.indexOf(e.currentTarget);
    if (e.key === "ArrowUp" && at <= 0) search.current?.focus();
    else all[at + (e.key === "ArrowDown" ? 1 : -1)]?.focus();
  };

  const load = (w: SavedWorkspace) => {
    markCurrentWorkspace(w.id);
    onLoad(w);
    setOpen(false);
  };

  return (
    <div className="mh-wsnav" ref={root}>
      <button
        type="button"
        className="mh-nav-item mh-nav-icon"
        aria-current={active ? "page" : undefined}
        // On the Workspace screen already, the name has nothing else to do: it opens the menu too.
        onClick={() => (active ? setOpen((v) => !v) : onOpen())}
      >
        <WorkspaceIcon size={16} />
        Workspace
      </button>
      <button type="button" className="mh-nav-caret" aria-label="Saved workspaces" aria-expanded={open} aria-haspopup="dialog" title="Saved workspaces" onClick={() => setOpen((v) => !v)}>
        <ChevronDownIcon size={12} />
      </button>
      {open ? (
        <div className="mh-ws" role="dialog" aria-label="Saved workspaces">
          <div className="mh-ws-search">
            <SearchIcon size={14} />
            <input ref={search} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onSearchKey} placeholder="Search workspaces" aria-label="Search workspaces" spellCheck={false} />
            {query ? (
              <button type="button" aria-label="Clear the search" onClick={() => setQuery("")}>
                <CloseIcon size={12} />
              </button>
            ) : null}
          </div>

          {kept.length > 0 ? (
            <>
              <div className="mh-ws-head">Saved workspaces</div>
              {shown.length > 0 ? (
                <ul className="mh-ws-list" ref={list}>
                  {shown.map((w) => (
                    <li key={w.id} onMouseLeave={() => asking === w.id && setAsking(null)}>
                      <button type="button" className="mh-ws-item" data-current={w.id === current || undefined} onClick={() => load(w)} onKeyDown={onRowKey}>
                        <Arrangement layout={w.layout} />
                        <span className="mh-ws-text">
                          <span className="mh-ws-name">{w.name}</span>
                          <span className="mh-ws-meta">
                            {w.panels} {w.panels === 1 ? "panel" : "panels"} · {when(w.savedAt)}
                          </span>
                        </span>
                        {w.id === current ? <CheckIcon size={14} /> : null}
                      </button>
                      {asking === w.id ? (
                        <button type="button" className="mh-ws-confirm" onClick={() => removeWorkspace(w.id)} onBlur={() => setAsking(null)} autoFocus>
                          Delete
                        </button>
                      ) : (
                        <button type="button" className="mh-ws-del" aria-label={`Delete ${w.name}`} title="Delete" onClick={() => setAsking(w.id)}>
                          <TrashIcon size={14} />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="mh-ws-empty">No workspace matches “{query}”.</div>
              )}
            </>
          ) : (
            <div className="mh-ws-empty">No saved workspaces. Save the current layout to open it again later.</div>
          )}

          <div className="mh-ws-save">
            <div className="mh-ws-savebar">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && keep(name)}
                placeholder="Name the current layout"
                aria-label="Workspace name"
                maxLength={40}
                spellCheck={false}
              />
              <button type="button" className="mh-ws-savebtn" disabled={!name.trim()} onClick={() => keep(name)}>
                Save
              </button>
            </div>
            <div className="mh-ws-foot" aria-live="polite">
              {status ? (
                <span className="mh-ws-status">{status}</span>
              ) : currentName ? (
                <button type="button" className="mh-ws-update" onClick={() => keep(currentName)}>
                  Update “{currentName}” with this layout
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
