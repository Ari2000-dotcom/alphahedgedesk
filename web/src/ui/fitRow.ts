import { useLayoutEffect, useState } from "react";

/**
 * Keeps a row of readouts on its one line by hiding its least-needed pieces, measured rather than
 * guessed from breakpoints: a longer name (BANKNIFTY), a bigger price or a rolled strike only changes
 * what fits, never clips it.
 *
 * Every element in the row marked `data-drop="n"` can give way, the lowest `n` first, all of one rank
 * together (the CE and PE legs). Each pass shows them all, then hides rank by rank until the row
 * stops overflowing. It runs after every render, as new values change the widths, and whenever the
 * row's container or one of its pieces changes size.
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
    const observer = new ResizeObserver(() => refit(row, overflows));
    observer.observe(row.parentElement ?? row);
    // A piece that grows by itself (the title bar's index prices, drawn by components of their own
    // that update without the row re-rendering) refits the row too.
    for (const piece of row.querySelectorAll("[data-drop]")) observer.observe(piece);
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

const rankOf = (piece: HTMLElement) => Number(piece.dataset.drop);

/** A row's pieces, their ranks lowest first, and a way to hide or show one rank. */
function piecesOf(row: HTMLElement) {
  const pieces = [...row.querySelectorAll<HTMLElement>("[data-drop]")];
  const ranks = [...new Set(pieces.map(rankOf))].sort((a, b) => a - b);
  const setHidden = (rank: number, hidden: boolean) => {
    for (const piece of pieces) if (rankOf(piece) === rank) piece.hidden = hidden;
  };
  return { pieces, ranks, setHidden };
}

/** From nothing hidden: after a render, when any value may have changed width. */
function fit(row: HTMLElement, overflows: (row: HTMLElement) => boolean): void {
  const { pieces, ranks, setHidden } = piecesOf(row);
  for (const piece of pieces) piece.hidden = false;
  let over = overflows(row);
  for (const rank of ranks) {
    if (!over) break;
    setHidden(rank, true);
    over = overflows(row);
  }
  // Still over with everything given way (a wrapping row on two lines): styles can lay it out for that.
  row.toggleAttribute("data-overflowing", over);
}

/**
 * From what is hidden now: on a resize, which a splitter drag sends every frame. Showing every
 * piece only to hide them again cost a layout per rank on each frame; this hides the next rank
 * while the row is over, or gives back the last one hidden while the room holds it, so a frame
 * that changes nothing costs one or two measurements. Ranks still go lowest first.
 */
function refit(row: HTMLElement, overflows: (row: HTMLElement) => boolean): void {
  const { pieces, ranks, setHidden } = piecesOf(row);
  const hidden = ranks.filter((rank) => pieces.some((p) => rankOf(p) === rank && p.hidden));
  let over = overflows(row);
  if (over) {
    for (const rank of ranks) {
      if (hidden.includes(rank)) continue;
      setHidden(rank, true);
      over = overflows(row);
      if (!over) break;
    }
  } else {
    for (const rank of hidden.reverse()) {
      setHidden(rank, false);
      if (overflows(row)) {
        setHidden(rank, true);
        break;
      }
    }
  }
  row.toggleAttribute("data-overflowing", over);
}
