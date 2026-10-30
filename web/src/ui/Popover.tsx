import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

interface Place {
  left: number;
  top: number;
  minWidth: number;
  maxHeight: number;
  up: boolean;
}

/** Room kept clear between a menu and the window's edge, and between a menu and its trigger. */
const EDGE = 8;
const GAP = 4;
/** No narrower than this, or than its trigger: an icon button's menu still has room for its rows. */
const MIN_WIDTH = 200;

/**
 * A menu's floating box, drawn at the page's top level with fixed coordinates read off its
 * trigger. A dock panel clips what it holds (overflow and paint containment), so a menu drawn
 * inside a short panel used to be cut off at the panel's edge.
 *
 * It opens under the trigger, or over it when there is more room above; it slides sideways to
 * stay in the window and is never taller than the room it has (its list scrolls). It follows the
 * trigger through a scroll or a resize and refits when its own content changes height (a search
 * narrowing the list).
 */
export function Popover({
  anchor,
  boxRef,
  align = "start",
  className,
  children,
}: Readonly<{
  anchor: RefObject<HTMLElement>;
  /** The box, so its owner can tell a click inside it from one outside. */
  boxRef: RefObject<HTMLDivElement>;
  align?: "start" | "end";
  className?: string;
  children: ReactNode;
}>) {
  const [place, setPlace] = useState<Place | null>(null);
  const placed = useRef<Place | null>(null);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const position = () => {
      const a = anchor.current?.getBoundingClientRect();
      if (!a) return;
      const below = window.innerHeight - a.bottom - GAP - EDGE;
      const above = a.top - GAP - EDGE;
      const natural = box.scrollHeight;
      const up = natural > below && above > below;
      const maxHeight = Math.max(120, Math.floor(up ? above : below));
      const height = Math.min(natural, maxHeight);
      const width = Math.max(box.offsetWidth, a.width);
      const wanted = align === "end" ? a.right - width : a.left;
      const left = Math.round(Math.min(Math.max(EDGE, wanted), window.innerWidth - width - EDGE));
      const top = Math.round(up ? a.top - GAP - height : a.bottom + GAP);
      const next = { left, top, minWidth: Math.round(Math.max(MIN_WIDTH, a.width)), maxHeight, up };
      const was = placed.current;
      if (was && was.left === next.left && was.top === next.top && was.maxHeight === next.maxHeight && was.minWidth === next.minWidth && was.up === next.up) return;
      placed.current = next;
      setPlace(next);
    };
    position();
    const content = new ResizeObserver(position);
    content.observe(box);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      content.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [anchor, boxRef, align]);

  return createPortal(
    <div
      ref={boxRef}
      className={className ? `mh-menu mh-pop ${className}` : "mh-menu mh-pop"}
      data-up={place?.up || undefined}
      data-align={align}
      style={
        place
          ? { left: place.left, top: place.top, minWidth: place.minWidth, maxHeight: place.maxHeight }
          : // Measured once off screen before it is placed: still focusable there (a hidden box is
            // not), so its owner can put the keys in its search box or list as it opens.
            { left: -10000, top: 0 }
      }
    >
      {children}
    </div>,
    document.body,
  );
}
