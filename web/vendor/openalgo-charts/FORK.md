# openalgo-charts, MarketHub fork

Our copy of [openalgo-charts](https://github.com/marketcalls/openalgo-charts) (Apache-2.0, see
`LICENSE` and `NOTICE`), changed to draw the way TradingView's Lightweight Charts draws.

- **Upstream:** tag `v2.6.7`, commit `e1a09d48755bcd01f387cdd7bc11106fcbad0fcd`.
- **What is here:** only the base entry (`src/index.ts`) and the files it imports, 154 of the
  library's ~390 source files. The trade, draw, widget, workspace and other tiers are left out;
  the app imports nothing from them.
- **How the app uses it:** from source, no build step. `web/vite.config.ts` aliases
  `openalgo-charts` to `src/index.ts`, and `web/tsconfig.json` maps the same path. The npm package
  is no longer a dependency.
- **Type-checking:** `npx tsc -p vendor/openalgo-charts` (from `web/`) checks the fork under the
  library's own strict settings; `npm run build` checks it under the app's.

## What we changed

Every change is marked `MarketHub fork` in the source.

| Change | Files |
|---|---|
| TradingView's font stack (`-apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif`) for every piece of chart text, axes at 12 px | `render/font.ts` (new), `render/axis.ts`, `render/grid.ts`, `primitives/pane-legend.ts`, `primitives/price-line.ts`, `primitives/price-levels.ts`, `primitives/axis-tag.ts`, `primitives/time-navigator.ts`, `index.ts` (exports `CHART_FONT_FAMILY`) |
| Legend names in the regular weight, not bold | `primitives/pane-legend.ts` |
| Crosshair: TradingView's long 6-on-6 dash; a dot on every line where the crosshair meets it, ringed in the chart's ground | `render/crosshair.ts`, `core/pane.ts` |
| Crosshair chips: ink read off the chip's own fill (a dark chip gets white text); the time chip near-square like the price chip, not a rounded pill | `core/pane.ts` |
| Axis tags that would overlap are moved apart, not hidden | `render/axis.ts` (`spreadAxisTags`), `core/pane.ts` |
| A series' `title` in a box of its colour beside its axis tag | `render/axis.ts` (`drawSeriesTitleTag`), `core/pane.ts` |
| Every series draws its own dotted price line in its colour (`priceLineVisible`), not only the pane's first one | `core/pane.ts` |
| A single-colour instrument (a line) keeps its own colour on its tag and price line instead of turning up/down green or red | `core/pane.ts` |
| Crisp rules: a 1 px grid line, price line or crosshair is stroked on whole device pixels (half a pixel in for odd widths, none for even). Upstream stroked 1 px grid lines on a pixel edge, which the browser smears over two pixels at half strength | `helpers/math.ts` (`crispOffset`), `render/grid.ts`, `render/axis.ts`, `render/crosshair.ts` |
| The grid stands on the labels: a horizontal line under every price on the pane's readout axis, a vertical line under every time label, in every pane. Upstream spaced lines every 60 px from the corner | `render/axis.ts` (`timeAxisMarks`, split out of `drawTimeAxis`), `core/pane.ts` |
| Intraday time labels on round clock times (09:30, 10:00, 10:30...): the bar that opens each span is marked, so labels and grid ride with the bars through a pan. Upstream marked every n-th bar from the view's left edge, which re-picked them as the view moved. Daily bars count every n-th bar from the first one | `render/axis.ts` (`clockStep`, `timeAxisMarks`) |
| The vertical grid carries on past the first and last bar at the same rhythm, so a chart panned beyond its data keeps its grid | `render/axis.ts` (`timeAxisMarks().grid`), `core/pane.ts` |
| Each pane rules its horizontal grid off its right scale while that scale shows a series (else its readout scale), so every pane's grid lines up with its right-hand labels; and only where the axis prints the price (`tickFits`), so no grid line hugs a pane's top or foot and doubles the rule between two panes | `core/pane.ts` (`_gridScale`), `render/axis.ts` (`tickFits` exported) |
| TradingView's dotted price line (dots a line width long, two apart) | `render/axis.ts` |
| `SeriesStyle.sessionBreaks`: a line series lifts the pen at each new trading session (read from the bars' overnight gaps), so a session VWAP draws no jump from one day's last value to the next day's first | `render/series-style.ts`, `render/line.ts` |
| Tags, name boxes and crosshair chips with TradingView's slightly rounded corners | `render/axis.ts` (`fillTagBox`), `render/crosshair.ts` |

## Taking a newer upstream release

1. Clone the new tag next to the old one and diff `src/` between the two upstream tags.
2. Apply that diff here; where it touches a `MarketHub fork` change, keep ours.
3. Re-list the files the base entry reaches (a new import may pull in a file not copied yet) and
   copy any new ones.
4. Update the tag and commit above, then run both type-checks and `npm run build`.
