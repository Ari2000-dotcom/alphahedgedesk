import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent } from "react";

import { DEFAULT_THEME, LiteChart, type LiteHover, type LiteOptions, type LiteSeries, type LiteTheme } from "./engine";

/**
 * React host for the lite chart engine (`engine.ts`, unchanged from QuantDesk).
 *
 * QuantDesk's version wraps MUI and its theme store; this one is plain DOM, so
 * the web build carries no UI library. The engine draws; this component only
 * mounts it, passes data and options through, and re-reads the colour tokens
 * when the theme changes (`themeKey`).
 *
 * Keyboard (focus the chart): ←/→ step the crosshair, +/− zoom, Home shows the
 * whole session, End or 0 returns to the latest bars, Esc clears the crosshair.
 * Mouse/touch: wheel zooms at the pointer, drag pans, double-click resets.
 */

export interface LiteChartHandle {
  fitAll(): void;
  resetView(): void;
  zoomBy(factor: number): void;
  scrollToLatest(): void;
}

export interface LiteChartViewProps extends Omit<LiteOptions, "onHover"> {
  times: readonly number[];
  series: readonly LiteSeries[];
  /** The default window is re-applied whenever this changes (a new session). */
  viewKey?: string;
  /** Changes when the colour theme does, so the engine re-reads its tokens. */
  themeKey?: string;
  theme?: Partial<LiteTheme>;
  onHoverIndex?: (index: number | null) => void;
  ariaLabel: string;
}

export const LiteChartView = forwardRef<LiteChartHandle, LiteChartViewProps>(function LiteChartView(
  { times, series, viewKey, themeKey, theme, onHoverIndex, ariaLabel, ...options },
  ref,
) {
  const holder = useRef<HTMLDivElement>(null);
  const chart = useRef<LiteChart | null>(null);
  const reported = useRef<number | null>(null);

  const onHover = (hover: LiteHover | null) => {
    const index = hover ? hover.index : null;
    if (index !== reported.current) {
      reported.current = index;
      onHoverIndex?.(index);
    }
  };
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;
  const hostPlotChange = options.onPlotChange;
  const plotRef = useRef(hostPlotChange);
  plotRef.current = hostPlotChange;
  const plotChange = (plot: { x: number; y: number; w: number; h: number }) => plotRef.current?.(plot);

  useEffect(() => {
    const element = holder.current;
    if (!element) return;
    const instance = new LiteChart(element, { ...options, onPlotChange: plotChange, onHover: (h) => onHoverRef.current(h) }, { ...DEFAULT_THEME, ...theme });
    chart.current = instance;
    return () => {
      instance.destroy();
      chart.current = null;
    };
    // Mount once; options, theme and data flow in through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    chart.current?.setOptions({ ...options, onPlotChange: plotChange, onHover: (h) => onHoverRef.current(h) });
  });

  const themeJson = JSON.stringify(theme ?? {});
  useEffect(() => {
    chart.current?.setTheme({ ...DEFAULT_THEME, ...theme });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeKey, themeJson]);

  useEffect(() => {
    chart.current?.setData(times, series, []);
  }, [times, series]);

  useEffect(() => {
    chart.current?.resetView();
  }, [viewKey]);

  useImperativeHandle(
    ref,
    () => ({
      fitAll: () => chart.current?.fitAll(),
      resetView: () => chart.current?.resetView(),
      zoomBy: (factor: number) => chart.current?.zoomBy(factor),
      scrollToLatest: () => chart.current?.scrollToLatest(),
    }),
    [],
  );

  const onKeyDown = (e: KeyboardEvent) => {
    const c = chart.current;
    if (!c) return;
    const keys: Record<string, () => void> = {
      ArrowLeft: () => c.step(e.shiftKey ? -10 : -1),
      ArrowRight: () => c.step(e.shiftKey ? 10 : 1),
      "+": () => c.zoomBy(0.8),
      "=": () => c.zoomBy(0.8),
      "-": () => c.zoomBy(1.25),
      _: () => c.zoomBy(1.25),
      Home: () => c.fitAll(),
      End: () => c.resetView(),
      "0": () => c.resetView(),
      Escape: () => c.clearHover(),
    };
    const run = keys[e.key];
    if (run) {
      run();
      e.preventDefault();
    }
  };

  return (
    <div
      ref={holder}
      className="lite-chart"
      tabIndex={0}
      role="img"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      onBlur={() => chart.current?.clearHover()}
    />
  );
});
