/**
 * A candle's body width, device px, for candles `spacing` CSS px apart — TradingView's own rule
 * (lightweight-charts `optimalCandlestickWidth`, Apache-2.0): the body fills its slot while candles
 * are tight and gives back up to a fifth of it as they widen; 2.5–4 px apart, a fixed 3 px; never
 * under a device pixel. Shared by the candle chart and the lite charts, so a candle reads the same
 * on every chart.
 */
export function candleWidth(spacing: number, dpr: number): number {
  const pixel = Math.max(1, Math.floor(dpr));
  if (spacing >= 2.5 && spacing <= 4) return Math.max(pixel, Math.floor(3 * dpr));
  const coeff = 1 - (0.2 * Math.atan(Math.max(4, spacing) - 4)) / (Math.PI * 0.5);
  const optimal = Math.min(Math.floor(spacing * coeff * dpr), Math.floor(spacing * dpr));
  return Math.max(pixel, optimal);
}
