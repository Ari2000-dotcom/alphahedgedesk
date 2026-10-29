import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";

import { ChevronDownIcon } from "./icons";

export interface DropdownOption<T extends string> {
  value: T;
  label: ReactNode;
  /** A quiet line beside the label (days to expiry, what a tone is). */
  note?: ReactNode;
  icon?: ReactNode;
  /** The section it sits under (an expiry's month); a heading starts each run. */
  group?: string;
  /** A thin rule above this item: TradingView's way of grouping a menu without headings. */
  separator?: boolean;
}

/**
 * A pick-one menu. The trigger is QuantDesk's flat strip picker: what it picks
 * one ink tier down ("Expiry"), then the pick and a chevron, straight on the
 * strip with a wash on hover. With `icon` it is a round icon button instead
 * (the canvas picker). The list floats under it with the current item in the
 * interaction blue. ↑/↓, Home/End move; Enter or a click picks; Escape, Tab or
 * a click outside closes.
 */
export function Dropdown<T extends string>({
  label,
  value,
  options,
  onChange,
  heading,
  icon,
  lead,
  tone,
  align = "start",
  renderValue,
  caption = true,
}: Readonly<{
  label: string;
  value: T;
  options: readonly DropdownOption<T>[];
  onChange: (value: T) => void;
  heading?: string;
  /** An icon-only trigger. */
  icon?: ReactNode;
  /** An icon before the pick on the trigger (the session's live mark). */
  lead?: ReactNode;
  /** `warn`: the pick is one to notice (a past session, never to be taken for live). */
  tone?: "warn";
  align?: "start" | "end";
  renderValue?: (option: DropdownOption<T> | undefined) => ReactNode;
  /** The label before the pick on the trigger; off when the pick says it all. */
  caption?: boolean;
}>) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const current = options.findIndex((o) => o.value === value);

  const show = () => {
    setActive(Math.max(0, current));
    setOpen(true);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const pick = (index: number) => {
    const option = options[index];
    if (option) onChange(option.value);
    close(true);
  };

  // Focus the list when it opens; close on a click anywhere else.
  useEffect(() => {
    if (!open) return;
    list.current?.focus();
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  // Keep the active item in view as the keys move it.
  useEffect(() => {
    if (open) document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, id]);

  const onListKey = (e: React.KeyboardEvent) => {
    const last = options.length - 1;
    const moves: Record<string, () => void> = {
      ArrowDown: () => setActive((i) => Math.min(last, i + 1)),
      ArrowUp: () => setActive((i) => Math.max(0, i - 1)),
      Home: () => setActive(0),
      End: () => setActive(last),
      Enter: () => pick(active),
      " ": () => pick(active),
      Escape: () => close(true),
      Tab: () => close(false),
    };
    const move = moves[e.key];
    if (!move) return;
    if (e.key !== "Tab") e.preventDefault();
    move();
  };

  const picked = options[current];

  return (
    <div className={`mh-dropdown${align === "end" ? " mh-end" : ""}`} ref={root}>
      <button
        ref={trigger}
        type="button"
        className={icon ? "mh-icon-btn" : `mh-picker${tone === "warn" ? " mh-warn" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={icon ? label : undefined}
        title={icon ? label : undefined}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            show();
          }
        }}
      >
        {icon ?? (
          <>
            {caption ? <span className="mh-picker-caption">{label}</span> : null}
            {lead}
            <span className="mh-picker-value">{renderValue ? renderValue(picked) : picked?.label}</span>
            <ChevronDownIcon size={13} />
          </>
        )}
      </button>
      {open && (
        <div className="mh-menu mh-pop">
          {heading ? <div className="mh-menu-heading">{heading}</div> : null}
          <ul
            ref={list}
            id={id}
            role="listbox"
            tabIndex={-1}
            aria-label={label}
            aria-activedescendant={`${id}-${active}`}
            className="mh-menu-list"
            onKeyDown={onListKey}
          >
            {options.map((o, i) => (
              <Fragment key={o.value}>
                {o.group && o.group !== options[i - 1]?.group ? (
                  <li role="presentation" className="mh-menu-group">
                    {o.group}
                  </li>
                ) : null}
                {o.separator && i > 0 ? <li role="separator" className="mh-menu-rule" /> : null}
                <li
                  id={`${id}-${i}`}
                  role="option"
                  aria-selected={o.value === value}
                  className={i === active ? "mh-menu-item mh-active" : "mh-menu-item"}
                  onPointerEnter={() => setActive(i)}
                  onClick={() => pick(i)}
                >
                  {o.icon ? <span className="mh-menu-icon">{o.icon}</span> : null}
                  <span className="mh-menu-text">{o.label}</span>
                  {o.note ? <span className="mh-menu-note">{o.note}</span> : null}
                </li>
              </Fragment>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
