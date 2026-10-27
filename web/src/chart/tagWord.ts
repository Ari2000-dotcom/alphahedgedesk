/**
 * A value tag's name ("Spot", "ATM IV") cut to fit: both chart engines put a
 * name segment on their axis tags, and a long one (a combo's label) must not
 * reach across the plot.
 */

/** `word` cut to `max` device px with a "…", in the context's current font. */
export function fitWord(ctx: CanvasRenderingContext2D, word: string, max: number): string {
  if (ctx.measureText(word).width <= max) return word;
  let cut = word.length;
  while (cut > 1 && ctx.measureText(`${word.slice(0, cut).trimEnd()}…`).width > max) cut--;
  return `${word.slice(0, cut).trimEnd()}…`;
}
