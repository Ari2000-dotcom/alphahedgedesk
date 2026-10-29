import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";

import { CheckIcon, ChevronDownIcon } from "./icons";
import type { DropdownOption } from "./Dropdown";

/**
 * `Dropdown`'s pick-many sibling: the same flat strip trigger and floating list, a checkbox on
 * every row, ticked on the picked ones. A click toggles membership and leaves the list open, so
 * several can be picked in one visit; Escape, Tab or a click outside closes it. ↑/↓, Home/End
 * move; Enter or Space toggles the active item.
 */
export function MultiDropdown<T extends string>({
  label,
  value,
  options,
  onChange,
  renderValue,
  caption = true,
}: Readonly<{
  label: string;
  value: readonly T[];
  options: readonly DropdownOption<T>[];
  onChange: (value: T[]) => void;
  renderValue?: (picked: readonly DropdownOption<T>[]) => ReactNode;
  /** The label before the pick on the trigger; off when the pick says it all. */
  caption?: boolean;
}>) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const picked = options.filter((o) => value.includes(o.value));

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const toggle = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(value.includes(option.value) ? value.filter((v) => v !== option.value) : [...value, option.value]);
  };

  useEffect(() => {
    if (!open) return;
    list.current?.focus();
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

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
      Enter: () => toggle(active),
      " ": () => toggle(active),
      Escape: () => close(true),
      Tab: () => close(false),
    };
    const move = moves[e.key];
    if (!move) return;
    if (e.key !== "Tab") e.preventDefault();
    move();
  };

  return (
    <div className="mh-dropdown" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="mh-picker"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setActive(0);
            setOpen(true);
          }
        }}
      >
        {caption ? <span className="mh-picker-caption">{label}</span> : null}
        <span className="mh-picker-value">{renderValue ? renderValue(picked) : picked.map((o) => o.label).join(", ") || null}</span>
        <ChevronDownIcon size={13} />
      </button>
      {open && (
        <div className="mh-menu mh-pop">
          <ul ref={list} id={id} role="listbox" aria-multiselectable="true" tabIndex={-1} aria-label={label} aria-activedescendant={`${id}-${active}`} className="mh-menu-list" onKeyDown={onListKey}>
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
                  aria-selected={value.includes(o.value)}
                  className={i === active ? "mh-menu-item mh-active" : "mh-menu-item"}
                  onPointerEnter={() => setActive(i)}
                  onClick={() => toggle(i)}
                >
                  <span className="mh-menu-check" aria-hidden>
                    {value.includes(o.value) ? <CheckIcon size={12} /> : null}
                  </span>
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
