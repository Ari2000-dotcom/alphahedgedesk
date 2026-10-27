import { useEffect, useState } from "react";

/**
 * The page's own fullscreen state (the Fullscreen API): on, the browser's address bar, tab
 * strip and bookmarks bar are gone, and the desk has the whole screen — the standard way a web
 * app reclaims the browser's own chrome without an install (TradingView's and Kite's own
 * "fullscreen" buttons do the same). `toggle` asks the browser; the state here only ever
 * reflects what the browser granted, including an exit by its own Esc.
 */
export function useFullscreen(): [boolean, () => void] {
  const [on, setOn] = useState(() => document.fullscreenElement !== null);
  useEffect(() => {
    const onChange = () => setOn(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggle = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().catch(() => undefined);
  };
  return [on, toggle];
}
