import { CHART_FONT_FAMILY, darkTheme, type ChartTheme } from "openalgo-charts";

/**
 * openalgo-charts theming shared by every chart in the app, so they read as one
 * canvas rather than a page of boxes in slightly different styles.
 */

/** A token from the page's palette, resolved: the canvas cannot read `var(--x)`. */
export function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** The axes' text, CSS px: TradingView's 12. */
export const AXIS_FONT = 12;

/**
 * The library's dark theme on the page's palette, set the way TradingView sets its own: axis text
 * at 12 px, a dashed crosshair whose time and price sit in dark chips on the axes (their ink is
 * read off the chip).
 */
export function themeFromPage(): ChartTheme {
  return {
    ...darkTheme,
    background: token("--mh-bg") || darkTheme.background,
    grid: token("--mh-chart-grid") || darkTheme.grid,
    axisText: token("--mh-chart-axis-text") || darkTheme.axisText,
    axisLine: token("--mh-chart-axis-line") || darkTheme.axisLine,
    paneSeparator: token("--mh-chart-pane-seam") || darkTheme.paneSeparator,
    crosshair: token("--mh-chart-crosshair") || darkTheme.crosshair,
    crosshairStyle: "dashed",
    crosshairLabelBackground: token("--mh-chart-crosshair-tag") || undefined,
    axisFontSize: AXIS_FONT,
    lastPriceText: token("--mh-bg") || darkTheme.lastPriceText,
  };
}

/**
 * Each price axis's width, CSS px, sized as TradingView sizes its scale: to the widest value it
 * will show, in the axis's own type, with room either side. The library's fixed 56 px clips a
 * value tag as wide as "22,707.18".
 */
export function priceAxisWidth(): number {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return 72;
  ctx.font = `${AXIS_FONT}px ${CHART_FONT_FAMILY}`;
  return Math.ceil(ctx.measureText("88,888.88").width) + 2 * 8;
}
