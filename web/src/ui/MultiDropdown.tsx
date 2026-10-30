import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

import { CheckIcon, ChevronDownIcon, SearchIcon } from "./icons";
import type { DropdownOption } from "./Dropdown";
import { filterOptions, SEARCH_FROM, useTypeahead } from "./menuSearch";
import { Popover } from "./Popover";

/**
 * `Dropdown`'s pick-many sibling: the same flat strip trigger and floating list (`Popover`, never
 * clipped by its panel), a tick beside every picked item instead of one. A click toggles
 * membership and leaves the list open, so several can be picked in one visit; Escape, Tab or a
 * click outside closes it. A long list opens with a search box, a short one jumps to what is typed.
 * ↑/↓ (and Home/End without a search box) move; Enter toggles the active item.
 */
export function MultiDropdown<T extends string>({
  label,
  value,
  options,
  onChange,
  renderValue,
  caption = true,
  search,
}: Readonly<{
  label: string;
  value: readonly T[];
  options: readonly DropdownOption<T>[];
  onChange: (value: T[]) => void;
  renderValue?: (picked: readonly DropdownOption<T>[]) => ReactNode;
  /** The label before the pick on the trigger; off when the pick says it all. */
  caption?: boolean;
  /** A search box over the list; on by default for a long list. */
  search?: boolean;
}>) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const searchable = search ?? options.length > SEARCH_FROM;
  const shown = useMemo(() => (searchable ? filterOptions(options, query) : [...options]), [options, query, searchable]);
  const picked = options.filter((o) => value.includes(o.value));

  const show = () => {
    setQuery("");
    setActive(Math.max(0, options.findIndex((o) => value.includes(o.value))));
    setOpen(true);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const toggle = (index: number) => {
    const option = shown[index];
    if (!option) return;
    onChange(value.includes(option.value) ? value.filter((v) => v !== option.value) : [...value, option.value]);
  };

  useEffect(() => {
    if (!open) return;
    (searchable ? field.current : list.current)?.focus({ preventScroll: true });
    const away = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!root.current?.contains(target) && !box.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open, searchable]);

  useEffect(() => {
    if (open) document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, id]);

  const typeahead = useTypeahead(shown, active, setActive);
  const onKey = (e: React.KeyboardEvent) => {
    const last = shown.length - 1;
    const moves: Record<string, () => void> = {
      ArrowDown: () => setActive((i) => Math.min(last, i + 1)),
      ArrowUp: () => setActive((i) => Math.max(0, i - 1)),
      Enter: () => toggle(active),
      Escape: () => close(true),
      Tab: () => close(false),
      ...(searchable ? {} : { Home: () => setActive(0), End: () => setActive(last), " ": () => toggle(active) }),
    };
    const move = moves[e.key];
    if (!move) {
      if (!searchable && typeahead(e)) e.preventDefault();
      return;
    }
    if (e.key !== "Tab") e.preventDefault();
    move();
  };

  const activeId = shown.length > 0 ? `${id}-${active}` : undefined;

  return (
    <div className="mh-dropdown" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="mh-picker"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            show();
          }
        }}
      >
        {caption ? <span className="mh-picker-caption">{label}</span> : null}
        <span className="mh-picker-value">{renderValue ? renderValue(picked) : picked.map((o) => o.label).join(", ") || null}</span>
        <ChevronDownIcon size={13} />
      </button>
      {open ? (
        <Popover anchor={trigger} boxRef={box}>
          {searchable ? (
            <div className="mh-menu-search">
              <SearchIcon size={14} />
              <input
                ref={field}
                role="combobox"
                aria-expanded="true"
                aria-controls={id}
                aria-activedescendant={activeId}
                aria-label={`Search ${label.toLowerCase()}`}
                placeholder="Search"
                autoComplete="off"
                spellCheck={false}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onKey}
              />
            </div>
          ) : null}
          <ul
            ref={list}
            id={id}
            role="listbox"
            aria-multiselectable="true"
            tabIndex={-1}
            aria-label={label}
            aria-activedescendant={searchable ? undefined : activeId}
            className="mh-menu-list"
            onKeyDown={searchable ? undefined : onKey}
          >
            {shown.length === 0 ? (
              <li role="presentation" className="mh-menu-empty">
                Nothing matches “{query.trim()}”
              </li>
            ) : (
              shown.map((o, i) => (
                <Fragment key={o.value}>
                  {o.group && o.group !== shown[i - 1]?.group ? (
                    <li role="presentation" className="mh-menu-group">
                      {o.group}
                    </li>
                  ) : null}
                  <li
                    id={`${id}-${i}`}
                    role="option"
                    aria-selected={value.includes(o.value)}
                    className={i === active ? "mh-menu-item mh-active" : "mh-menu-item"}
                    onPointerEnter={() => setActive(i)}
                    onClick={() => toggle(i)}
                  >
                    {o.icon ? <span className="mh-menu-icon">{o.icon}</span> : null}
                    <span className="mh-menu-text">{o.label}</span>
                    {o.note ? <span className="mh-menu-note">{o.note}</span> : null}
                    <span className="mh-menu-tick" aria-hidden>
                      {value.includes(o.value) ? <CheckIcon size={14} /> : null}
                    </span>
                  </li>
                </Fragment>
              ))
            )}
          </ul>
        </Popover>
      ) : null}
    </div>
  );
}
