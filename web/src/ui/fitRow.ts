import { useLayoutEffect, useState } from "react";

/**
 * Keeps a row of readouts on its one line by hiding its least-needed pieces, measured rather than
 * guessed from breakpoints: a longer name (BANKNIFTY), a bigger price or a rolled strike only changes
 * what fits, never clips it.
 *
 * Every element in the row marked `data-drop="n"` can give way, the lowest `n` first, all of one rank
 * together (the CE and PE legs). Each pass shows them all, then hides rank by rank until the row
 * stops overflowing. It runs after every render, as new values change the widths, and whenever the
 * row's container changes size.
 *
 * Returns the ref callback to put on the row.
 */
export function useFitRow(overflows: (row: HTMLElement) => boolean = spills): (row: HTMLElement | null) => void {
  const [row, setRow] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (row) fit(row, overflows);
  });

  useLayoutEffect(() => {
    if (!row) return;
    const observer = new ResizeObserver(() => fit(row, overflows));
    observer.observe(row.parentElement ?? row);
    return () => observer.disconnect();
  }, [row, overflows]);

  return setRow;
}

/** A one-line row overflows when its content is wider than its box. */
export const spills = (row: HTMLElement): boolean => row.scrollWidth > row.clientWidth + 1;

/**
 * A wrapping row overflows when a piece starts below the first one's foot: it went to a second
 * line. Pieces with no height (a flexible spacer) and hidden ones are passed over.
 */
export const wraps = (row: HTMLElement): boolean => {
  let first: HTMLElement | null = null;
  for (const child of row.children) {
    const box = child as HTMLElement;
    if (box.offsetParent === null || box.offsetHeight === 0) continue;
    if (first === null) first = box;
    else if (box.offsetTop >= first.offsetTop + first.offsetHeight) return true;
  }
  return false;
};

function fit(row: HTMLElement, overflows: (row: HTMLElement) => boolean): void {
  const pieces = [...row.querySelectorAll<HTMLElement>("[data-drop]")];
  for (const piece of pieces) piece.hidden = false;
  const ranks = [...new Set(pieces.map((p) => Number(p.dataset.drop)))].sort((a, b) => a - b);
  for (const rank of ranks) {
    if (!overflows(row)) return;
    for (const piece of pieces) if (Number(piece.dataset.drop) === rank) piece.hidden = true;
  }
}
