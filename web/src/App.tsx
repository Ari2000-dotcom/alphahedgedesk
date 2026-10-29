import { useEffect, useRef, useState } from "react";
import type { DockviewApi } from "dockview";

import { applyCanvas, CANVAS_TONES, loadCanvas, type CanvasId } from "./core/canvas";
import { Hub, hubUrl, type HubStatus } from "./hub/client";
import { Ticker } from "./shell/Ticker";
import { UpdateToast } from "./shell/UpdateToast";
import { addPanelOf, applyPreset, currentView, PANEL_KINDS, PRESETS, switchView, VIEWS, Workspace, type Preset, type View } from "./shell/Workspace";
import { useFullscreen } from "./core/fullscreen";
import { Dropdown } from "./ui/Dropdown";
import { FullscreenEnterIcon, FullscreenExitIcon, PaletteIcon } from "./ui/icons";
import { Logo } from "./ui/Logo";

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
  const [panelCount, setPanelCount] = useState(2);
  // Runs a change a menu makes, then counts the panels once the dock has settled.
  const lay = (fn: (api: DockviewApi) => void) => {
    const api = dock.current;
    if (!api) return;
    fn(api);
    window.setTimeout(() => setPanelCount(api.panels.length), 400);
  };
  useEffect(() => hub?.onStatus(setStatus), [hub]);
  const [fullscreen, toggleFullscreen] = useFullscreen();

  return (
    <div className="mh-app">
      <header className="mh-titlebar">
        <div className="mh-brand">
          <Logo />
          MarketHub
        </div>
        <nav className="mh-nav" aria-label="Screens">
          {VIEWS.map((v) => (
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
              {v.name}
            </button>
          ))}
        </nav>
        <span className="mh-spacer" />
        {hub ? <Ticker hub={hub} /> : null}
        <span className="mh-feed" title="Connection to the hub">
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
            } else if (value === "reset") {
              setLayout("side");
              lay((api) => applyPreset(api, "side"));
            }
          }}
          renderValue={() => {
            const spec = PRESETS.find((p) => p.id === layout);
            return (
              <span className="mh-layout-value">
                <LayoutGlyph rects={spec?.rects ?? [[0, 0, 1, 1]]} />
                {spec ? spec.short : `Custom · ${panelCount} ${panelCount === 1 ? "panel" : "panels"}`}
              </span>
            );
          }}
          options={[
            ...PRESETS.map((p) => ({ value: `preset:${p.id}`, label: p.name, group: "Layout", icon: <LayoutGlyph rects={p.rects} /> })),
            ...PANEL_KINDS.map((k) => ({ value: `add:${k.kind}`, label: k.name, note: k.note, group: "Add a panel" })),
            { value: "reset", label: "Reset layout", group: "Add a panel" },
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
