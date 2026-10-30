import { useEffect, useRef, useState } from "react";
import type { DockviewApi } from "dockview";

import { applyCanvas, CANVAS_TONES, loadCanvas, type CanvasId } from "./core/canvas";
import { Hub, hubUrl, type HubStatus } from "./hub/client";
import { Ticker } from "./shell/Ticker";
import { UpdateToast } from "./shell/UpdateToast";
import { addPanelOf, applyPreset, currentView, PANEL_KINDS, PanelIcon, PRESETS, switchView, VIEWS, Workspace, type Preset, type View } from "./shell/Workspace";
import { useFullscreen } from "./core/fullscreen";
import { Dropdown } from "./ui/Dropdown";
import { ChainIcon, ChartIcon, FullscreenEnterIcon, FullscreenExitIcon, PaletteIcon } from "./ui/icons";
import { Logo } from "./ui/Logo";
import { WorkspaceNav } from "./shell/WorkspaceMenu";
import type { SavedWorkspace } from "./core/workspaces";

const STATUS_TEXT: Record<HubStatus, string> = {
  connecting: "Connecting",
  open: "Live",
  reconnecting: "Reconnecting",
  closed: "Disconnected",
};

const STATUS_TONE: Record<HubStatus, string> = {
  connecting: "mh-busy",
  open: "mh-ok",
  reconnecting: "mh-busy",
  closed: "mh-error",
};

export function App() {
  const [canvas, setCanvas] = useState<CanvasId>(loadCanvas);
  useEffect(() => applyCanvas(canvas), [canvas]);

  // The site is open to everyone: one connection per page, no key. The hub
  // client reconnects by itself, so a hub that is down reads "Reconnecting".
  const [hub, setHub] = useState<Hub | null>(null);
  useEffect(() => {
    const h = new Hub(hubUrl());
    setHub(h);
    return () => {
      h.close();
      setHub(null);
    };
  }, []);

  const [status, setStatus] = useState<HubStatus>("connecting");
  const dock = useRef<DockviewApi | null>(null);
  const [view, setView] = useState<View>(currentView);
  const [layout, setLayout] = useState<Preset | "custom">("custom");
  const [panelCount, setPanelCount] = useState(0);
  // Runs a change a menu makes on the dock.
  const lay = (fn: (api: DockviewApi) => void) => {
    const api = dock.current;
    if (api) fn(api);
  };
  // A saved workspace: on the Workspace screen, its layout laid in place of this one.
  const loadWorkspace = (workspace: SavedWorkspace) => {
    setView("workspace");
    setLayout("custom");
    lay((api) => {
      if (currentView() !== "workspace") switchView(api, "workspace");
      try {
        api.fromJSON(workspace.layout as Parameters<DockviewApi["fromJSON"]>[0]);
      } catch {
        // A layout that will not restore leaves the desk as it was.
      }
    });
  };
  // The Layout trigger's count follows the dock itself: a tab closed, a split or a restored screen.
  const [dockApi, setDockApi] = useState<DockviewApi | null>(null);
  useEffect(() => {
    if (!dockApi) return;
    const count = () => setPanelCount(dockApi.panels.length);
    count();
    const subscriptions = [dockApi.onDidAddPanel(count), dockApi.onDidRemovePanel(count), dockApi.onDidLayoutFromJSON(count)];
    return () => {
      for (const each of subscriptions) each.dispose();
    };
  }, [dockApi]);
  useEffect(() => hub?.onStatus(setStatus), [hub]);
  const [fullscreen, toggleFullscreen] = useFullscreen();

  return (
    <div className="mh-app">
      <header className="mh-titlebar">
        <div className="mh-brand">
          <Logo />
          <span className="mh-wordmark">
            Alpha<span className="mh-wordmark-hedge">Hedge</span>
          </span>
        </div>
        <nav className="mh-nav" aria-label="Screens">
          {VIEWS.map((v) =>
            v.id === "workspace" ? (
              <WorkspaceNav
                key={v.id}
                active={view === v.id}
                getApi={() => dock.current}
                onOpen={() => {
                  setView(v.id);
                  setLayout("custom");
                  lay((api) => switchView(api, v.id));
                }}
                onLoad={loadWorkspace}
              />
            ) : (
            <button
              key={v.id}
              type="button"
              className="mh-nav-item"
              aria-current={view === v.id ? "page" : undefined}
              onClick={() => {
                setView(v.id);
                setLayout("custom");
                lay((api) => switchView(api, v.id));
              }}
            >
              {v.id === "straddle" ? <ChartIcon size={16} /> : <ChainIcon size={16} />}
              {v.name}
            </button>
            ),
          )}
        </nav>
        <span className="mh-spacer" />
        {hub ? <Ticker hub={hub} /> : null}
        <span className="mh-feed" title="Connection to the market data feed">
          <span className={`mh-dot ${STATUS_TONE[status]}`} />
          {STATUS_TEXT[status]}
        </span>
        <Dropdown<string>
          label="Layout"
          caption={false}
          align="end"
          value={layout === "custom" ? "custom" : `preset:${layout}`}
          onChange={(value) => {
            if (value.startsWith("preset:")) {
              const id = value.slice(7) as Preset;
              setLayout(id);
              lay((api) => applyPreset(api, id));
            } else if (value.startsWith("add:")) {
              const kind = value.slice(4) as (typeof PANEL_KINDS)[number]["kind"];
              setLayout("custom");
              lay((api) => addPanelOf(api, kind, { referenceGroup: api.activeGroup ?? undefined, direction: "right" }));
            }
          }}
          renderValue={() => {
            const spec = PRESETS.find((p) => p.id === layout);
            return (
              <span className="mh-layout-value">
                <LayoutGlyph rects={spec?.rects ?? [[0, 0, 1, 1]]} />
                <span className="mh-layout-name">{spec ? spec.short : `Custom · ${panelCount} ${panelCount === 1 ? "panel" : "panels"}`}</span>
              </span>
            );
          }}
          options={[
            ...PRESETS.map((p) => ({ value: `preset:${p.id}`, label: p.name, group: "Layout", icon: <LayoutGlyph rects={p.rects} /> })),
            ...PANEL_KINDS.map((k) => ({ value: `add:${k.kind}`, label: k.name, note: k.note, group: "Add a panel", icon: <PanelIcon kind={k.kind} /> })),
          ]}
        />
        <button
          type="button"
          className="mh-icon-btn"
          onClick={toggleFullscreen}
          aria-pressed={fullscreen}
          aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen: hide the browser's own bars"}
          title={fullscreen ? "Exit fullscreen" : "Fullscreen: hide the browser's own bars"}
        >
          {fullscreen ? <FullscreenExitIcon /> : <FullscreenEnterIcon />}
        </button>
        <Dropdown
          label="Canvas"
          heading="Canvas"
          icon={<PaletteIcon />}
          align="end"
          value={canvas}
          onChange={setCanvas}
          options={CANVAS_TONES.map((tone) => ({
            value: tone.id,
            label: tone.name,
            note: tone.note,
            icon: (
              <span className="mh-swatch-tone" data-canvas={tone.id} aria-hidden>
                <span className="mh-swatch-chrome" />
                <span className="mh-swatch-page" />
                <span className="mh-swatch-row" />
              </span>
            ),
          }))}
        />
      </header>
      <main className="mh-main">
        {hub ? (
          <Workspace
            hub={hub}
            themeKey={canvas}
            onApi={(api) => {
              dock.current = api;
              setDockApi(api);
            }}
          />
        ) : null}
      </main>
      <UpdateToast />
    </div>
  );
}

/** A layout's picture: the rectangles its containers take, drawn small. */
function LayoutGlyph({ rects }: Readonly<{ rects: readonly (readonly [number, number, number, number])[] }>) {
  return (
    <svg className="mh-glyph" width="20" height="15" viewBox="0 0 18 14" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden>
      {rects.map(([x, y, w, h], i) => (
        <rect key={i} x={1 + x * 16 + 0.5} y={1 + y * 12 + 0.5} width={w * 16 - 1} height={h * 12 - 1} rx="1" />
      ))}
    </svg>
  );
}
