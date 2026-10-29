import { createContext, useContext, useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from "dockview";

import { dayLabel } from "../core/format";
import { DeltaOiPanel } from "../greeks/DeltaOiPanel";
import type { Hub } from "../hub/client";
import { readPick, StraddlePage, type Pick } from "../straddle/StraddlePage";
import { DetailsPanel, TablePanel } from "../desk/panels";
import { ChainPanel } from "../option/ChainPanel";
import { ScripPage, type ScripPick } from "../chart/ScripPage";
import { ChartIcon, ChevronDownIcon, CloseIcon, MaximizeIcon, PlusIcon, RestoreIcon, SplitDownIcon, SplitRightIcon, TableIcon } from "../ui/icons";

/**
 * The desk, QuantDesk's way (its `shell/Workspace.tsx`, on the same dockview): containers with a
 * tab strip, any number of straddles, side by side or stacked.
 *
 * - Each tab is one straddle with its own underlying, expiry and session (`StraddlePage`), its
 *   title following the pick ("NIFTY · 27 Oct").
 * - A container's strip holds its tabs; on hover a "+" adds a tab to it, and two buttons at its
 *   right end open a new container to its right or below. A tab dragged to a container's edge
 *   docks there; dropped on a strip it joins that container. The gap between two containers is
 *   the splitter.
 * - The arrangement (and each tab's pick) is saved on this computer as it changes and comes back
 *   on the next visit. `applyPreset` lays out a whole desk at once (the Layout menu).
 */

const LAYOUT_KEY = "mh.layout";

/** The three screens of the title bar. Each keeps its own layout on this computer. */
export type View = "straddle" | "chain" | "workspace";
export const VIEWS: readonly { id: View; name: string }[] = [
  { id: "straddle", name: "Straddle" },
  { id: "chain", name: "Option chain" },
  { id: "workspace", name: "Workspace" },
];
const VIEW_KEY = "mh.view";
let activeView: View = (() => {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return VIEWS.some((x) => x.id === v) ? (v as View) : "workspace";
  } catch {
    return "workspace";
  }
})();
/** Workspace keeps the key the desk has always saved under, so nobody loses their layout. */
const viewKey = (v: View) => (v === "workspace" ? LAYOUT_KEY : `${LAYOUT_KEY}.${v}`);
export const currentView = () => activeView;
/** Coalesced: a splitter drag changes the layout every frame. */
const SAVE_DELAY_MS = 400;

interface StraddleParams {
  pick?: Pick | null;
  /** A preset's underlying, picked once the hub is there. */
  autoPick?: string;
}

const Desk = createContext<{ hub: Hub; themeKey: string } | null>(null);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A tab's title: the underlying and its expiry, and the day when it is a past session. */
function titleOf(pick: Pick | null | undefined, autoPick?: string): string {
  if (!pick) return autoPick ?? "New straddle";
  const [, m, d] = pick.expiry.split("-").map(Number);
  const expiry = `${d} ${MONTHS[(m ?? 1) - 1]}`;
  return pick.day === "live" ? `${pick.underlying.name} · ${expiry}` : `${pick.underlying.name} · ${expiry} · ${dayLabel(pick.day)}`;
}

// One sequence for every "+" and preset, so two panels made in one millisecond cannot collide.
let counter = 0;
export type PanelKind = "straddle" | "chain" | "deltaoi" | "table" | "details" | "scrip";
const nextId = (kind: PanelKind = "straddle") => `${kind}-${++counter}-${Date.now()}`;

interface ChainParams {
  pick?: Pick | null;
}

interface ScripParams {
  id?: string;
  interval?: string;
}

/* -- a tab's content: one straddle ------------------------------------------------------------- */

function StraddlePanel({ api, params }: IDockviewPanelProps<StraddleParams>) {
  const desk = useContext(Desk);
  const [front, setFront] = useState(api.isActive);
  useEffect(() => {
    const subscription = api.onDidActiveChange((e) => setFront(e.isActive));
    return () => subscription.dispose();
  }, [api]);
  if (!desk) return null;
  return (
    <StraddlePage
      hub={desk.hub}
      themeKey={desk.themeKey}
      initialPick={params.pick ?? null}
      autoPick={params.autoPick}
      active={front}
      onPick={(pick) => {
        const title = titleOf(pick, params.autoPick);
        if (api.title !== title) api.setTitle(title);
        api.updateParameters({ pick, autoPick: pick ? undefined : params.autoPick });
      }}
    />
  );
}

function ChainDockPanel({ api, params }: IDockviewPanelProps<ChainParams>) {
  const desk = useContext(Desk);
  if (!desk) return null;
  return (
    <ChainPanel
      hub={desk.hub}
      initialPick={params.pick}
      onPick={(pick) => {
        const title = pick ? `Chain · ${pick.underlying.name}` : "Option chain";
        if (api.title !== title) api.setTitle(title);
        api.updateParameters({ pick });
      }}
    />
  );
}

function DeltaOiDockPanel({ api, params }: IDockviewPanelProps<ChainParams>) {
  const desk = useContext(Desk);
  if (!desk) return null;
  return (
    <DeltaOiPanel
      hub={desk.hub}
      initialPick={params.pick}
      onPick={(pick) => {
        const title = pick ? `Δ×OI · ${pick.underlying.name}` : "Delta × OI";
        if (api.title !== title) api.setTitle(title);
        api.updateParameters({ pick });
      }}
    />
  );
}

function TableDockPanel() {
  return <TablePanel />;
}
function DetailsDockPanel() {
  const desk = useContext(Desk);
  return desk ? <DetailsPanel hub={desk.hub} /> : null;
}

function ScripDockPanel({ api, params }: IDockviewPanelProps<ScripParams>) {
  const desk = useContext(Desk);
  if (!desk) return null;
  return (
    <ScripPage
      hub={desk.hub}
      themeKey={desk.themeKey}
      initialId={params.id}
      initialInterval={params.interval}
      onPick={(pick: ScripPick | null) => {
        const title = pick ? `Chart · ${pick.name}` : "Chart";
        if (api.title !== title) api.setTitle(title);
        api.updateParameters({ id: pick?.id, interval: pick?.interval });
      }}
    />
  );
}

const COMPONENTS = { straddle: StraddlePanel, chain: ChainDockPanel, table: TableDockPanel, details: DetailsDockPanel, deltaoi: DeltaOiDockPanel, scrip: ScripDockPanel };

/* -- a tab: icon, title, a close button that shows on hover ----------------------------------- */

function DeskTab({ api, containerApi }: IDockviewPanelHeaderProps) {
  const [title, setTitle] = useState(api.title ?? "");
  useEffect(() => {
    setTitle(api.title ?? "");
    const subscription = api.onDidTitleChange((e) => setTitle(e.title));
    return () => subscription.dispose();
  }, [api]);
  // A middle click closes, as in a browser.
  const middle = useRef(false);
  const close = (e: MouseEvent | PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    api.close();
  };
  return (
    <div
      className="mh-tab"
      title={title}
      onPointerDown={(e) => {
        middle.current = e.button === 1;
      }}
      onPointerUp={(e) => {
        if (middle.current && e.button === 1) close(e);
        middle.current = false;
      }}
    >
      <span className="mh-tab-icon" aria-hidden>
        {api.id.startsWith("straddle") || api.id.startsWith("scrip") ? <ChartIcon size={13} /> : <TableIcon size={13} />}
      </span>
      <span className="mh-tab-title">{title}</span>
      <TypeCaret panelId={api.id} containerApi={containerApi} onReplaced={() => api.close()} />
      <button
        type="button"
        className="mh-tab-close"
        aria-label={`Close ${title}`}
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onClick={close}
      >
        <CloseIcon size={11} />
      </button>
    </div>
  );
}

/** The caret on a tab: what the container shows. Picking another kind opens it in place and closes this one. */
function TypeCaret({ panelId, containerApi, onReplaced }: Readonly<{ panelId: string; containerApi: DockviewApi; onReplaced: () => void }>) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!at) return;
    const away = () => setAt(null);
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [at]);
  return (
    <>
      <button
        type="button"
        className="mh-tab-caret"
        aria-label="Change what this container shows"
        title="Change what this container shows"
        aria-haspopup="menu"
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          setAt(at ? null : { x: r.left, y: r.bottom + 4 });
        }}
      >
        <ChevronDownIcon size={11} />
      </button>
      {at
        ? createPortal(
            <ul className="mh-menu mh-pop mh-type-menu" role="menu" style={{ left: at.x, top: at.y }} onPointerDown={(e) => e.stopPropagation()}>
              {PANEL_KINDS.map((k) => (
                <li
                  key={k.kind}
                  role="menuitem"
                  className="mh-menu-item"
                  onClick={() => {
                    setAt(null);
                    addPanelOf(containerApi, k.kind, { referencePanel: panelId });
                    onReplaced();
                  }}
                >
                  <span className="mh-menu-text">{k.name}</span>
                  <span className="mh-menu-note">{k.note}</span>
                </li>
              ))}
            </ul>,
            document.body,
          )
        : null}
    </>
  );
}

/* -- a container's strip: "+" after its tabs, split buttons at its end ------------------------ */

const stop = (e: PointerEvent) => e.stopPropagation();

type Position = Parameters<DockviewApi["addPanel"]>[0]["position"];

/** A new panel of `kind`: a straddle chart (empty, to be picked) or an option chain (on the last pick). */
export function addPanelOf(api: DockviewApi, kind: PanelKind, position: Position) {
  const panel =
    kind === "chain"
      ? api.addPanel({ id: nextId("chain"), component: "chain", title: "Option chain", params: { pick: readPick() } satisfies ChainParams, position })
      : kind === "deltaoi"
        ? api.addPanel({ id: nextId("deltaoi"), component: "deltaoi", title: "Delta × OI", params: { pick: readPick() } satisfies ChainParams, position })
        : kind === "table"
          ? api.addPanel({ id: nextId("table"), component: "table", title: "All straddles", position })
          : kind === "details"
            ? api.addPanel({ id: nextId("details"), component: "details", title: "ATM straddle", position })
            : kind === "scrip"
              ? api.addPanel({ id: nextId("scrip"), component: "scrip", title: "Chart", params: {} satisfies ScripParams, position })
            : api.addPanel({ id: nextId(), component: "straddle", title: "New straddle", params: { pick: null } satisfies StraddleParams, position });
  panel.api.setActive();
  return panel;
}
const addStraddle = (api: DockviewApi, position: Position) => addPanelOf(api, "straddle", position);

/** What a "+" or a split can open, in the order the menus list them. */
export const PANEL_KINDS: readonly { kind: PanelKind; name: string; note: string }[] = [
  { kind: "straddle", name: "Straddle chart", note: "Compare up to 5" },
  { kind: "chain", name: "Option chain", note: "Add strikes" },
  { kind: "scrip", name: "Scrip chart", note: "Candles + ATR" },
  { kind: "deltaoi", name: "Delta × OI", note: "Call and put exposure" },
  { kind: "table", name: "All straddles", note: "Table" },
  { kind: "details", name: "ATM straddle", note: "Details" },
];

function HeaderAdd({ containerApi, group }: IDockviewHeaderActionsProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: globalThis.PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  return (
    <div className="mh-header-add" ref={root} data-open={open || undefined}>
      <button
        type="button"
        className="mh-dock-btn"
        aria-label="New tab in this container"
        title="New tab in this container"
        aria-haspopup="menu"
        aria-expanded={open}
        onPointerDown={stop}
        onClick={() => setOpen((o) => !o)}
      >
        <PlusIcon size={14} />
      </button>
      {open ? (
        <ul className="mh-menu mh-pop mh-add-menu" role="menu">
          {PANEL_KINDS.map((k) => (
            <li
              key={k.kind}
              role="menuitem"
              className="mh-menu-item"
              onPointerDown={stop}
              onClick={() => {
                setOpen(false);
                addPanelOf(containerApi, k.kind, { referenceGroup: group });
              }}
            >
              <span className="mh-menu-text">{k.name}</span>
              <span className="mh-menu-note">{k.note}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function HeaderSplit({ containerApi, group }: IDockviewHeaderActionsProps) {
  // Maximizing gives one container the whole desk until restored.
  const [maximized, setMaximized] = useState(group.api.isMaximized());
  useEffect(() => {
    setMaximized(group.api.isMaximized());
    const subscription = containerApi.onDidMaximizedGroupChange(() => setMaximized(group.api.isMaximized()));
    return () => subscription.dispose();
  }, [containerApi, group]);
  const toggleMax = () => (maximized ? group.api.exitMaximized() : group.api.maximize());
  const only = containerApi.groups.length <= 1;
  return (
    <div className="mh-header-split">
      <button type="button" className="mh-dock-btn" aria-label="Split right" title="Split right" onPointerDown={stop} onClick={() => addStraddle(containerApi, { referenceGroup: group, direction: "right" })}>
        <SplitRightIcon size={14} />
      </button>
      <button type="button" className="mh-dock-btn" aria-label="Split down" title="Split down" onPointerDown={stop} onClick={() => addStraddle(containerApi, { referenceGroup: group, direction: "below" })}>
        <SplitDownIcon size={14} />
      </button>
      <button
        type="button"
        className="mh-dock-btn"
        aria-label={maximized ? "Restore the layout" : "Maximise this container"}
        title={maximized ? "Restore the layout" : "Maximise this container"}
        disabled={only && !maximized}
        onPointerDown={stop}
        onClick={toggleMax}
      >
        {maximized ? <RestoreIcon size={13} /> : <MaximizeIcon size={13} />}
      </button>
      <button
        type="button"
        className="mh-dock-btn"
        aria-label="Close this container"
        title="Close this container"
        disabled={only}
        onPointerDown={stop}
        onClick={() => {
          for (const panel of [...group.panels]) panel.api.close();
        }}
      >
        <CloseIcon size={11} />
      </button>
    </div>
  );
}

/* -- views ------------------------------------------------------------------------------------- */

export type Preset = "one" | "side" | "stacked" | "three" | "grid";

/**
 * The layouts of the Layout menu, each with its picture: the rectangles (x, y, w, h as fractions
 * of the desk) its containers take. `rows` x `cols` stays for the 2 x 2 straddle grid.
 */
export const PRESETS: readonly { id: Preset; name: string; short: string; rects: readonly (readonly [number, number, number, number])[] }[] = [
  { id: "one", name: "One panel", short: "One panel", rects: [[0, 0, 1, 1]] },
  { id: "side", name: "Straddle and option chain", short: "Chart + chain", rects: [[0, 0, 0.58, 1], [0.58, 0, 0.42, 1]] },
  { id: "stacked", name: "Straddle above option chain", short: "Chart over chain", rects: [[0, 0, 1, 0.6], [0, 0.6, 1, 0.4]] },
  { id: "three", name: "Straddle, option chain and details", short: "Chart + chain + details", rects: [[0, 0, 0.56, 1], [0.56, 0, 0.44, 0.62], [0.56, 0.62, 0.44, 0.38]] },
  { id: "grid", name: "Four straddles and the table", short: "4 straddles + table", rects: [[0, 0, 0.5, 0.35], [0.5, 0, 0.5, 0.35], [0, 0.35, 0.5, 0.35], [0.5, 0.35, 0.5, 0.35], [0, 0.7, 1, 0.3]] },
];

/** The underlyings a preset's containers open on, in reading order. */
const PRESET_PICKS = ["NIFTY", "BANKNIFTY", "SENSEX", "CRUDEOIL"];

/** Lays the whole desk out as one of the PRESETS. */
export function applyPreset(api: DockviewApi, preset: Preset) {
  api.clear();
  const straddle = (index: number, position?: Position) => {
    const autoPick = PRESET_PICKS[index % PRESET_PICKS.length]!;
    return api.addPanel({ id: nextId(), component: "straddle", title: autoPick, params: { pick: null, autoPick } satisfies StraddleParams, position });
  };
  const chain = (position: Position) => api.addPanel({ id: nextId("chain"), component: "chain", title: "Option chain", params: { pick: readPick() } satisfies ChainParams, position });
  if (preset === "one") {
    straddle(0);
  } else if (preset === "side" || preset === "stacked") {
    const first = straddle(0);
    const second = chain({ referencePanel: first, direction: preset === "side" ? "right" : "below" });
    if (preset === "side") second.api.setSize({ width: Math.round(api.width * 0.42) });
    else second.api.setSize({ height: Math.round(api.height * 0.4) });
    first.api.setActive();
  } else if (preset === "three") {
    const first = straddle(0);
    const second = chain({ referencePanel: first, direction: "right" });
    second.api.setSize({ width: Math.round(api.width * 0.44) });
    const third = addPanelOf(api, "details", { referencePanel: second, direction: "below" });
    third.api.setSize({ height: Math.round(api.height * 0.38) });
    first.api.setActive();
  } else {
    const a = straddle(0);
    const b = straddle(1, { referencePanel: a, direction: "right" });
    straddle(2, { referencePanel: a, direction: "below" });
    straddle(3, { referencePanel: b, direction: "below" });
    // No reference: the table takes the whole bottom edge of the desk.
    const table = addPanelOf(api, "table", { direction: "below" });
    table.api.setSize({ height: Math.round(api.height * 0.3) });
    a.api.setActive();
  }
}

/**
 * Switches the title bar's screen: the layout in front is kept under its own name and the other
 * screen's comes back; one that was never opened starts from its default (the Straddle screen: the
 * chart with a narrow chain beside it; the Option chain screen: the chain wide, the chart narrow).
 */
export function switchView(api: DockviewApi, to: View) {
  if (to === activeView) return;
  try {
    localStorage.setItem(viewKey(activeView), JSON.stringify(api.toJSON()));
    localStorage.setItem(VIEW_KEY, to);
  } catch {
    // A per-viewer convenience only.
  }
  activeView = to;
  let restored = false;
  try {
    const saved = localStorage.getItem(viewKey(to));
    if (saved) {
      api.fromJSON(JSON.parse(saved));
      restored = api.panels.length > 0;
    }
  } catch {
    api.clear();
  }
  if (restored) return;
  api.clear();
  if (to === "workspace") {
    applyPreset(api, "side");
    return;
  }
  const chart = api.addPanel({ id: nextId(), component: "straddle", title: "New straddle", params: { pick: readPick() } satisfies StraddleParams });
  const chain = api.addPanel({
    id: nextId("chain"),
    component: "chain",
    title: "Option chain",
    params: { pick: readPick() } satisfies ChainParams,
    position: { referencePanel: chart, direction: to === "straddle" ? "right" : "left" },
  });
  if (to === "straddle") chain.api.setSize({ width: Math.round(api.width * 0.3) });
  else chart.api.setSize({ width: Math.round(api.width * 0.32) });
  (to === "straddle" ? chart : chain).api.setActive();
}

/** The desk a first visit opens on: one container, on the last pick this computer made. */
function opening(api: DockviewApi) {
  const pick = readPick();
  api.addPanel({ id: nextId(), component: "straddle", title: titleOf(pick), params: { pick } satisfies StraddleParams });
}

export function Workspace({ hub, themeKey, onApi }: Readonly<{ hub: Hub; themeKey: string; onApi?: (api: DockviewApi) => void }>) {
  const [api, setApi] = useState<DockviewApi | null>(null);
  const host = useRef<HTMLDivElement>(null);

  const ready = (event: DockviewReadyEvent) => {
    setApi(event.api);
    onApi?.(event.api);
    // StrictMode mounts twice in development; a second restore would add every panel again.
    if (event.api.panels.length > 0) return;
    try {
      const saved = localStorage.getItem(viewKey(activeView));
      if (saved) {
        event.api.fromJSON(JSON.parse(saved));
        if (event.api.panels.length > 0) return;
      }
    } catch {
      // A layout that will not restore is dropped rather than half applied.
      event.api.clear();
    }
    opening(event.api);
  };

  // Saved as it changes, coalesced.
  useEffect(() => {
    if (!api) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const save = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          localStorage.setItem(viewKey(activeView), JSON.stringify(api.toJSON()));
        } catch {
          // A per-viewer convenience only.
        }
      }, SAVE_DELAY_MS);
    };
    const subscriptions = [api.onDidLayoutChange(save), api.onDidActivePanelChange(save)];
    return () => {
      if (timer) clearTimeout(timer);
      for (const each of subscriptions) each.dispose();
    };
  }, [api]);

  // "Add straddle" on a chart: the option chain to pick from, in front, or a new one beside it.
  useEffect(() => {
    if (!api) return;
    const open = () => {
      const chain = api.panels.find((p) => p.id.startsWith("chain"));
      if (chain) chain.api.setActive();
      else addPanelOf(api, "chain", { referenceGroup: api.activeGroup ?? undefined, direction: "right" });
    };
    window.addEventListener("mh-add-straddle", open);
    return () => window.removeEventListener("mh-add-straddle", open);
  }, [api]);

  // An emptied desk is never left blank: closing the last tab opens a fresh one.
  useEffect(() => {
    if (!api) return;
    const subscription = api.onDidRemovePanel(() => {
      if (api.panels.length === 0) addStraddle(api, undefined);
    });
    return () => subscription.dispose();
  }, [api]);

  // A container grows in once, when it is made (styles: `.mh-entering`).
  useEffect(() => {
    if (!api) return;
    const subscription = api.onDidAddGroup((group) => {
      const element = group.element;
      element.classList.add("mh-entering");
      window.setTimeout(() => element.classList.remove("mh-entering"), 400);
    });
    return () => subscription.dispose();
  }, [api]);

  // Fullscreen on and off resizes the window without changing its width, so this should never
  // matter — dockview watches its own element with a ResizeObserver and relays out on its own.
  // Chrome was seen leaving a stale, too-wide layout after exiting fullscreen even so (a
  // horizontal scrollbar on a page that never otherwise has one), so the dock is told its host's
  // real size explicitly once the transition settles, past whatever frame that glitch landed in.
  useEffect(() => {
    if (!api) return;
    const relayout = () => {
      requestAnimationFrame(() => {
        const el = host.current;
        if (el) api.layout(el.clientWidth, el.clientHeight, true);
      });
    };
    document.addEventListener("fullscreenchange", relayout);
    return () => document.removeEventListener("fullscreenchange", relayout);
  }, [api]);

  return (
    <Desk.Provider value={{ hub, themeKey }}>
      <div ref={host} className="mh-dock-host">
        <DockviewReact
          components={COMPONENTS}
          defaultTabComponent={DeskTab}
          leftHeaderActionsComponent={HeaderAdd}
          rightHeaderActionsComponent={HeaderSplit}
          onReady={ready}
          className="mh-dock dockview-theme-dark"
        />
      </div>
    </Desk.Provider>
  );
}
