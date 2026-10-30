import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

import { ChevronDownIcon, SearchIcon } from "./icons";
import { filterOptions, SEARCH_FROM, useTypeahead } from "./menuSearch";
import { Popover } from "./Popover";

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
  /** More words the search finds it by, beyond its label, note and value. */
  keywords?: string;
}

/**
 * A pick-one menu. The trigger is QuantDesk's flat strip picker: what it picks one ink tier down
 * ("Expiry"), then the pick and a chevron, straight on the strip with a wash on hover. With `icon`
 * it is an icon button instead (the canvas picker).
 *
 * The list floats over the page (`Popover`), never clipped by the panel it opens from: flat rows,
 * a wash under the pointer or the keys, the current pick in the interaction blue. A long list (an
 * underlying out of hundreds) opens with a search box; a short one jumps to what is typed.
 * ↑/↓, Home/End move; Enter or a click picks; Escape, Tab or a click outside closes.
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
  search,
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
  const current = options.findIndex((o) => o.value === value);

  const show = () => {
    setQuery("");
    setActive(Math.max(0, current));
    setOpen(true);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const pick = (index: number) => {
    const option = shown[index];
    if (option) onChange(option.value);
    close(true);
  };

  // Keys go to the search box or the list as it opens; a click anywhere else closes it.
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

  // Keep the active item in view as the keys move it.
  useEffect(() => {
    if (open) document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, id]);

  const typeahead = useTypeahead(shown, active, setActive);
  const onKey = (e: React.KeyboardEvent) => {
    const last = shown.length - 1;
    const moves: Record<string, () => void> = {
      ArrowDown: () => setActive((i) => Math.min(last, i + 1)),
      ArrowUp: () => setActive((i) => Math.max(0, i - 1)),
      Enter: () => pick(active),
      Escape: () => close(true),
      Tab: () => close(false),
      // In the search box these keys type and move the caret.
      ...(searchable ? {} : { Home: () => setActive(0), End: () => setActive(last), " ": () => pick(active) }),
    };
    const move = moves[e.key];
    if (!move) {
      if (!searchable && typeahead(e)) e.preventDefault();
      return;
    }
    if (e.key !== "Tab") e.preventDefault();
    move();
  };

  const picked = options[current];
  const activeId = shown.length > 0 ? `${id}-${active}` : undefined;

  return (
    <div className="mh-dropdown" ref={root}>
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
      {open ? (
        <Popover anchor={trigger} boxRef={box} align={align}>
          {heading ? <div className="mh-menu-heading">{heading}</div> : null}
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
              ))
            )}
          </ul>
        </Popover>
      ) : null}
    </div>
  );
}
