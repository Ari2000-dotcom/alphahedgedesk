import { Fragment, useEffect, useId, useRef, useState } from "react";

import { CheckIcon, ChevronDownIcon, StarIcon } from "../ui/icons";
import { useTypeahead } from "../ui/menuSearch";
import { Popover } from "../ui/Popover";
import { CANDLE_INTERVALS } from "./useCandles";

const FAVOURITES_KEY = "mh.intervals.favourites";
const DEFAULT_FAVOURITES = ["5m", "15m", "60m", "1d"];

function loadFavourites(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(FAVOURITES_KEY) ?? "null") as unknown;
    if (Array.isArray(saved)) return saved.filter((v): v is string => CANDLE_INTERVALS.some((c) => c.value === v));
  } catch {
    // Nothing saved, or storage is off: the defaults.
  }
  return DEFAULT_FAVOURITES;
}

const OPTIONS = CANDLE_INTERVALS.map((c) => ({ value: c.value, label: c.name }));

/**
 * The interval, picked TradingView's way: the favourite intervals as buttons on the strip, the
 * current one pressed, and a chevron that opens every interval by minutes, hours and days, each
 * with a star that puts it on the strip or takes it off (this viewer's choice, kept on this
 * computer). An interval picked from the menu that is not a favourite shows on the strip while it
 * is the current one. A narrow panel keeps only the current interval and the chevron.
 *
 * In the menu ↑/↓, Home/End move, Enter picks, F stars or unstars the active row, a digit or a
 * letter jumps to it, and Escape, Tab or a click outside closes.
 */
export function IntervalPicker({ value, onChange }: Readonly<{ value: string; onChange: (value: string) => void }>) {
  const [favourites, setFavourites] = useState<string[]>(loadFavourites);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();

  const toggleFavourite = (interval: string) => {
    setFavourites((was) => {
      const next = was.includes(interval) ? was.filter((v) => v !== interval) : [...was, interval];
      try {
        localStorage.setItem(FAVOURITES_KEY, JSON.stringify(next));
      } catch {
        // A per-viewer convenience only.
      }
      return next;
    });
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const pick = (index: number) => {
    const c = CANDLE_INTERVALS[index];
    if (c) onChange(c.value);
    close(true);
  };

  useEffect(() => {
    if (!open) return;
    list.current?.focus({ preventScroll: true });
    const away = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!trigger.current?.contains(target) && !box.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  useEffect(() => {
    if (open) document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, id]);

  const typeahead = useTypeahead(OPTIONS, active, setActive);
  const onKey = (e: React.KeyboardEvent) => {
    const last = CANDLE_INTERVALS.length - 1;
    const moves: Record<string, () => void> = {
      ArrowDown: () => setActive((i) => Math.min(last, i + 1)),
      ArrowUp: () => setActive((i) => Math.max(0, i - 1)),
      Home: () => setActive(0),
      End: () => setActive(last),
      Enter: () => pick(active),
      " ": () => pick(active),
      f: () => toggleFavourite(CANDLE_INTERVALS[active]!.value),
      Escape: () => close(true),
      Tab: () => close(false),
    };
    const move = moves[e.key];
    if (!move) {
      if (typeahead(e)) e.preventDefault();
      return;
    }
    if (e.key !== "Tab") e.preventDefault();
    move();
  };

  const onStrip = CANDLE_INTERVALS.filter((c) => favourites.includes(c.value) || c.value === value);

  return (
    <div className="mh-intervals" role="group" aria-label="Interval">
      {onStrip.map((c) => (
        <button key={c.value} type="button" className="mh-interval" aria-pressed={c.value === value} title={c.name} onClick={() => onChange(c.value)}>
          {c.label}
        </button>
      ))}
      <button
        ref={trigger}
        type="button"
        className="mh-interval-more"
        aria-label="Every interval"
        title="Every interval"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          if (open) close(false);
          else {
            setActive(Math.max(0, CANDLE_INTERVALS.findIndex((c) => c.value === value)));
            setOpen(true);
          }
        }}
      >
        <ChevronDownIcon size={13} />
      </button>
      {open ? (
        <Popover anchor={trigger} boxRef={box}>
          <ul
            ref={list}
            id={id}
            role="listbox"
            tabIndex={-1}
            aria-label="Interval"
            aria-activedescendant={`${id}-${active}`}
            className="mh-menu-list"
            onKeyDown={onKey}
          >
            {CANDLE_INTERVALS.map((c, i) => {
              const starred = favourites.includes(c.value);
              return (
                <Fragment key={c.value}>
                  {c.group !== CANDLE_INTERVALS[i - 1]?.group ? (
                    <li role="presentation" className="mh-menu-group">
                      {c.group}
                    </li>
                  ) : null}
                  <li
                    id={`${id}-${i}`}
                    role="option"
                    aria-selected={c.value === value}
                    className={i === active ? "mh-menu-item mh-active" : "mh-menu-item"}
                    onPointerEnter={() => setActive(i)}
                    onClick={() => pick(i)}
                  >
                    <span className="mh-menu-text">{c.name}</span>
                    <button
                      type="button"
                      tabIndex={-1}
                      className="mh-star"
                      aria-pressed={starred}
                      aria-label={starred ? `Take ${c.name} off the toolbar` : `Put ${c.name} on the toolbar`}
                      title={starred ? "On the toolbar (F)" : "Add to the toolbar (F)"}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleFavourite(c.value);
                      }}
                    >
                      <StarIcon size={14} filled={starred} />
                    </button>
                    <span className="mh-menu-tick" aria-hidden>
                      {c.value === value ? <CheckIcon size={14} /> : null}
                    </span>
                  </li>
                </Fragment>
              );
            })}
          </ul>
        </Popover>
      ) : null}
    </div>
  );
}
