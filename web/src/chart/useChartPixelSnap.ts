import { useEffect, type RefObject } from "react";

/**
 * Keeps a chart's host on the screen's pixel grid (openalgo-charts' "device pixels, exactly"). At
 * a fractional display scale (Windows at 125% or 150%) the frame starts part way into a device
 * pixel (5 CSS px is 6.25 device px at 1.25) and a box 1590 px wide is 1987.5 device px: the
 * browser then resamples the whole bitmap every frame and every line comes out soft. `inner` is
 * nudged onto the next whole device pixel and sized to an exact number of them, so its canvases
 * map one to one onto the screen. Done again on a resize and on a change of display scale.
 */
export function useChartPixelSnap(outer: RefObject<HTMLElement | null>, inner: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const outerEl = outer.current;
    const innerEl = inner.current;
    if (!outerEl || !innerEl) return;
    let ratio = 0;
    let query: MediaQueryList | null = null;
    const snap = () => {
      const dpr = window.devicePixelRatio || 1;
      const r = outerEl.getBoundingClientRect();
      const dx = Math.ceil(r.left * dpr - 0.001) / dpr - r.left;
      const dy = Math.ceil(r.top * dpr - 0.001) / dpr - r.top;
      const w = Math.floor((r.width - dx) * dpr + 0.001) / dpr;
      const h = Math.floor((r.height - dy) * dpr + 0.001) / dpr;
      Object.assign(innerEl.style, { left: `${dx}px`, top: `${dy}px`, width: `${w}px`, height: `${h}px` });
      if (dpr !== ratio) {
        ratio = dpr;
        query?.removeEventListener("change", snap);
        query = window.matchMedia(`(resolution: ${dpr}dppx)`);
        query.addEventListener("change", snap);
      }
    };
    snap();
    const observer = new ResizeObserver(snap);
    observer.observe(outerEl);
    window.addEventListener("resize", snap);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", snap);
      query?.removeEventListener("change", snap);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
