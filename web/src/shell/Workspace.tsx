import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type MouseEvent, type PointerEvent, type RefObject } from "react";
import {
  DockviewReact,
  type DockviewApi,
  type DockviewGroupPanel,
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
import { Popover } from "../ui/Popover";

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

/**
 * The panel kinds as a menu under `anchor`: what a tab's caret and a strip's "+" open. It floats
 * over the page (`Popover`), so a short container never clips it. The keys work as in every other
 * menu: ↑/↓, Home/End move, Enter picks, Escape or Tab closes (Escape back to the button), and so
 * does a click outside.
 */
function KindMenu({ anchor, onPick, onClose }: Readonly<{ anchor: RefObject<HTMLButtonElement>; onPick: (kind: PanelKind) => void; onClose: () => void }>) {
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [active, setActive] = useState(0);
  const id = useId();
  useEffect(() => {
    list.current?.focus({ preventScroll: true });
    const away = (e: globalThis.PointerEvent) => {
      const target = e.target as Node;
      if (!box.current?.contains(target) && !anchor.current?.contains(target)) onClose();
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [anchor, onClose]);
  const last = PANEL_KINDS.length - 1;
  const onKey = (e: React.KeyboardEvent) => {
    const moves: Record<string, () => void> = {
      ArrowDown: () => setActive((i) => Math.min(last, i + 1)),
      ArrowUp: () => setActive((i) => Math.max(0, i - 1)),
      Home: () => setActive(0),
      End: () => setActive(last),
      Enter: () => onPick(PANEL_KINDS[active]!.kind),
      " ": () => onPick(PANEL_KINDS[active]!.kind),
      Escape: () => {
        onClose();
        anchor.current?.focus();
      },
      Tab: onClose,
    };
    const move = moves[e.key];
    if (!move) return;
    if (e.key !== "Tab") e.preventDefault();
    // A tab's own keys (dockview's) never see what the menu used.
    e.stopPropagation();
    move();
  };
  return (
    <Popover anchor={anchor} boxRef={box}>
      {/* Its events still bubble through React to the tab it opened from: kept from starting a drag there. */}
      <ul
        ref={list}
        className="mh-menu-list"
        role="menu"
        tabIndex={-1}
        aria-activedescendant={`${id}-${active}`}
        onKeyDown={onKey}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {PANEL_KINDS.map((k, i) => (
          <li
            key={k.kind}
            id={`${id}-${i}`}
            role="menuitem"
            className={i === active ? "mh-menu-item mh-active" : "mh-menu-item"}
            onPointerEnter={() => setActive(i)}
            onClick={() => onPick(k.kind)}
          >
            <span className="mh-menu-icon">
              <PanelIcon kind={k.kind} />
            </span>
            <span className="mh-menu-text">{k.name}</span>
            <span className="mh-menu-note">{k.note}</span>
          </li>
        ))}
      </ul>
    </Popover>
  );
}

/** The caret on a tab: what the container shows. Picking another kind opens it in place and closes this one. */
function TypeCaret({ panelId, containerApi, onReplaced }: Readonly<{ panelId: string; containerApi: DockviewApi; onReplaced: () => void }>) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button
        ref={button}
        type="button"
        className="mh-tab-caret"
        aria-label="Change what this container shows"
        title="Change what this container shows"
        aria-haspopup="menu"
        aria-expanded={open}
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        <ChevronDownIcon size={11} />
      </button>
      {open ? (
        <KindMenu
          anchor={button}
          onClose={close}
          onPick={(kind) => {
            setOpen(false);
            addPanelOf(containerApi, kind, { referencePanel: panelId });
            onReplaced();
          }}
        />
      ) : null}
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

/**
 * The room a container keeps when the desk is split in two: the chart takes 60%, the other stuff
 * the rest. A split from a container's header, a layout from the Layout menu, and a double click
 * on a divider all land here.
 */
const KEEP = 0.6;

/** A container split in two: the new one takes the share the first one does not keep. */
function split(api: DockviewApi, group: DockviewGroupPanel, direction: "right" | "below") {
  const room = direction === "right" ? group.api.width : group.api.height;
  const panel = addStraddle(api, { referenceGroup: group, direction });
  panel.api.setSize(direction === "right" ? { width: Math.round(room * (1 - KEEP)) } : { height: Math.round(room * (1 - KEEP)) });
}

/**
 * A double click on a divider puts the two sides it separates back to their default: the first
 * (left or upper) one keeps KEEP of the room the two share, the other gets the rest.
 */
function resetDivider(api: DockviewApi, sash: Element) {
  const s = sash.getBoundingClientRect();
  const vertical = s.height > s.width;
  const near = (a: number, b: number) => Math.abs(a - b) <= 10;
  let first: DockviewGroupPanel | undefined;
  let second: DockviewGroupPanel | undefined;
  for (const g of api.groups) {
    const r = g.element.getBoundingClientRect();
    if (vertical) {
      const overlaps = r.top < s.bottom && r.bottom > s.top;
      if (overlaps && near(r.right, s.left + s.width / 2)) first ??= g;
      if (overlaps && near(r.left, s.left + s.width / 2)) second ??= g;
    } else {
      const overlaps = r.left < s.right && r.right > s.left;
      if (overlaps && near(r.bottom, s.top + s.height / 2)) first ??= g;
      if (overlaps && near(r.top, s.top + s.height / 2)) second ??= g;
    }
  }
  if (!first || !second) return;
  if (vertical) first.api.setSize({ width: Math.round((first.api.width + second.api.width) * KEEP) });
  else first.api.setSize({ height: Math.round((first.api.height + second.api.height) * KEEP) });
}

/** What a "+" or a split can open, in the order the menus list them. */
export const PANEL_KINDS: readonly { kind: PanelKind; name: string; note: string }[] = [
  { kind: "straddle", name: "Straddle chart", note: "Compare up to 5" },
  { kind: "chain", name: "Option chain", note: "Add strikes" },
  { kind: "scrip", name: "Scrip chart", note: "Candles + ATR" },
  { kind: "deltaoi", name: "Delta × OI", note: "Call and put exposure" },
  { kind: "table", name: "All straddles", note: "A row per chart" },
  { kind: "details", name: "ATM straddle", note: "Legs, VWAP, IV" },
];

/** A panel kind's mark in the menus: a chart's line or a table's grid, as its tab shows. */
export function PanelIcon({ kind }: Readonly<{ kind: PanelKind }>) {
  return kind === "straddle" || kind === "scrip" ? <ChartIcon size={13} /> : <TableIcon size={13} />;
}

function HeaderAdd({ containerApi, group }: IDockviewHeaderActionsProps) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  return (
    <div className="mh-header-add" data-open={open || undefined}>
      <button
        ref={button}
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
        <KindMenu
          anchor={button}
          onClose={close}
          onPick={(kind) => {
            setOpen(false);
            addPanelOf(containerApi, kind, { referenceGroup: group });
          }}
        />
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
      <button type="button" className="mh-dock-btn" aria-label="Split right" title="Split right" onPointerDown={stop} onClick={() => split(containerApi, group, "right")}>
        <SplitRightIcon size={14} />
      </button>
      <button type="button" className="mh-dock-btn" aria-label="Split down" title="Split down" onPointerDown={stop} onClick={() => split(containerApi, group, "below")}>
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
  { id: "side", name: "Straddle and option chain", short: "Chart + chain", rects: [[0, 0, 0.6, 1], [0.6, 0, 0.4, 1]] },
  { id: "stacked", name: "Straddle above option chain", short: "Chart over chain", rects: [[0, 0, 1, 0.6], [0, 0.6, 1, 0.4]] },
  { id: "three", name: "Straddle, option chain and details", short: "Chart + chain + details", rects: [[0, 0, 0.6, 1], [0.6, 0, 0.4, 0.62], [0.6, 0.62, 0.4, 0.38]] },
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
    if (preset === "side") second.api.setSize({ width: Math.round(api.width * (1 - KEEP)) });
    else second.api.setSize({ height: Math.round(api.height * 0.4) });
    first.api.setActive();
  } else if (preset === "three") {
    const first = straddle(0);
    const second = chain({ referencePanel: first, direction: "right" });
    second.api.setSize({ width: Math.round(api.width * (1 - KEEP)) });
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
  // A double click on a divider puts the two sides back to their default share.
  useEffect(() => {
    const el = host.current;
    if (!api || !el) return;
    const onDouble = (e: Event) => {
      const sash = (e.target as Element | null)?.closest(".dv-sash");
      if (sash) resetDivider(api, sash);
    };
    el.addEventListener("dblclick", onDouble);
    return () => el.removeEventListener("dblclick", onDouble);
  }, [api]);

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
