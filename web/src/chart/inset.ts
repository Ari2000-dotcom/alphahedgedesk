/**
 * Where every chart's overlay text starts, CSS px from the PLOT's edges (2026-10-14, "they are not
 * in line"): the candle chart's OHLC legend and study readouts, its 1D·2D·5D ranges, the pane
 * titles and level labels the engines paint, and every lite chart's readout all share this one
 * line, so text across a chart (and across charts side by side) starts at the same x.
 */
export const CHART_INSET_X = 10;

/** The same, down from the plot's top. */
export const CHART_INSET_TOP = 8;
