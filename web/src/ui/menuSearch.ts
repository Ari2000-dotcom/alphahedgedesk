import { useRef } from "react";

import type { DropdownOption } from "./Dropdown";

/** Menus longer than this get a search box at the top. */
export const SEARCH_FROM = 10;

/** The words an option answers to: its label and note when they are text, its value, its keywords. */
export function optionText<T extends string>(o: DropdownOption<T>): string {
  return [typeof o.label === "string" ? o.label : "", typeof o.note === "string" ? o.note : "", o.value, o.keywords ?? ""].join(" ").toLowerCase();
}

/**
 * The options that hold every word of `query`, those whose label starts with it first, each group
 * in its own order. An empty query keeps them all.
 */
export function filterOptions<T extends string>(options: readonly DropdownOption<T>[], query: string): DropdownOption<T>[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...options];
  const hits = options.filter((o) => {
    const text = optionText(o);
    return words.every((w) => text.includes(w));
  });
  const q = words.join(" ");
  const starts = (o: DropdownOption<T>) => (typeof o.label === "string" && o.label.toLowerCase().startsWith(q) ? 0 : 1);
  return hits.map((o, i) => [o, i] as const).sort((a, b) => starts(a[0]) - starts(b[0]) || a[1] - b[1]).map(([o]) => o);
}

/**
 * Type to jump, as a native select does: letters typed within a moment of each other spell the
 * start of the label to move to; the same letter again moves on to the next one that starts with it.
 * Returns a key handler that answers whether it used the key.
 */
export function useTypeahead<T extends string>(options: readonly DropdownOption<T>[], active: number, setActive: (i: number) => void) {
  const typed = useRef({ text: "", at: 0 });
  return (e: React.KeyboardEvent): boolean => {
    if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey || e.key === " ") return false;
    const now = Date.now();
    const was = typed.current;
    const text = (now - was.at < 700 ? was.text : "") + e.key.toLowerCase();
    typed.current = { text, at: now };
    const label = (o: DropdownOption<T>) => (typeof o.label === "string" ? o.label : o.value).toLowerCase();
    // One letter pressed again cycles through the options that start with it.
    const repeat = text.length > 1 && [...text].every((c) => c === text[0]);
    const prefix = repeat ? text[0]! : text;
    const from = repeat || text.length === 1 ? active + 1 : active;
    for (let k = 0; k < options.length; k++) {
      const i = (from + k) % options.length;
      if (label(options[i]!).startsWith(prefix)) {
        setActive(i);
        break;
      }
    }
    return true;
  };
}
