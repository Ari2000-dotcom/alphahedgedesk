/**
 * Whether the WINDOW an element sits in can be seen — per element, because a
 * popped-out container sits in a different document from the rest of the app.
 *
 * What it is for: a chart's canvases are its heaviest memory, sized to its
 * window (a maximised 4K pop-out holds 100MB+ in them), and a minimised window
 * draws nothing. So charts hand their bitmaps back while hidden and rebuild
 * them when shown.
 *
 * Why not just the resize observer: a hidden document runs no rendering steps,
 * so a resize observer stays silent until the window is shown again — too late
 * to give anything back. `visibilitychange` fires at once. For a pop-out it
 * fires because the host tells WebView2 the minimised window is invisible
 * (`popout.rs`); WebView2 does not do that on its own.
 *
 * One listener per document, however many charts are in it. Documents are
 * held weakly, so a closed pop-out's document is not kept alive by this.
 */

type Watcher = { element: Element; onChange: (hidden: boolean) => void };

const watchers = new Set<Watcher>();
const watched = new WeakSet<Document>();

/** Starts listening to a document. Cheap to call again; safe on any document. */
export function watchDocument(doc: Document): void {
  if (watched.has(doc)) return;
  watched.add(doc);
  doc.addEventListener("visibilitychange", () => {
    const hidden = doc.hidden;
    // Matched on the element's CURRENT document: a chart moves between the
    // main window and a pop-out without re-registering.
    for (const watcher of watchers) {
      if (watcher.element.ownerDocument === doc) watcher.onChange(hidden);
    }
  });
}

/** Calls `onChange` when the window `element` is in is hidden or shown again. Returns the stop. */
export function onWindowHidden(element: Element, onChange: (hidden: boolean) => void): () => void {
  watchDocument(element.ownerDocument);
  const watcher: Watcher = { element, onChange };
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}
