import type { ReactNode } from "react";

/** The few line icons the page uses, drawn on a 24 grid at a 1.75 stroke. */
function Icon({ size = 16, children }: Readonly<{ size?: number; children: ReactNode }>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

type P = Readonly<{ size?: number }>;

export const SearchIcon = ({ size }: P) => (
  <Icon size={size}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Icon>
);

/** A desk: a tall container beside two stacked ones, the shape of a workspace. */
export const WorkspaceIcon = ({ size }: P) => (
  <Icon size={size}>
    <rect x="3" y="3" width="8" height="18" rx="2" />
    <rect x="14" y="3" width="7" height="8" rx="2" />
    <rect x="14" y="14" width="7" height="7" rx="2" />
  </Icon>
);

export const SaveIcon = ({ size }: P) => (
  <Icon size={size}>
    <path d="M5 3h11l4 4v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
    <path d="M7 3v5h8V3M7 21v-7h10v7" />
  </Icon>
);

export const TrashIcon = ({ size }: P) => (
  <Icon size={size}>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
  </Icon>
);

export const CloseIcon = ({ size }: P) => (
  <Icon size={size}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Icon>
);

export const ChevronDownIcon = ({ size }: P) => (
  <Icon size={size}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);

export const CheckIcon = ({ size }: P) => (
  <Icon size={size}>
    <path d="M20 6 9 17l-5-5" />
  </Icon>
);

export const PaletteIcon = ({ size }: P) => (
  <Icon size={size}>
    <path d="M12 3a9 9 0 0 0 0 18c1.1 0 1.8-.8 1.8-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8Z" />
    <circle cx="7.5" cy="11.5" r="1" />
    <circle cx="10.5" cy="7.5" r="1" />
    <circle cx="15.5" cy="8.5" r="1" />
  </Icon>
);

export const EyeIcon = ({ size }: P) => (
  <Icon size={size}>
    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);

export const EyeOffIcon = ({ size }: P) => (
  <Icon size={size}>
    <path d="M10.7 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-2.2 3.1M6.6 6.6C3.9 8.3 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18" />
  </Icon>
);

export const PlusIcon = ({ size }: P) => (
  <Icon size={size}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

/** A box split down the middle, a new pane on the right. */
export const SplitRightIcon = ({ size }: P) => (
  <Icon size={size}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M12 4v16" />
  </Icon>
);

/** A box split across, a new pane below. */
export const SplitDownIcon = ({ size }: P) => (
  <Icon size={size}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 12h18" />
  </Icon>
);

/** Four panes: the Layout menu. */
export const LayoutIcon = ({ size }: P) => (
  <Icon size={size}>
    <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
    <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
    <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
    <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
  </Icon>
);

/** Four corner marks drawing in from a box's edges: "fill the desk with this one". */
export const MaximizeIcon = ({ size }: P) => (
  <Icon size={size}>
    <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3" />
  </Icon>
);

/** Four corner marks drawing back out: "give the desk back its other containers". */
export const RestoreIcon = ({ size }: P) => (
  <Icon size={size}>
    <path d="M3 8V5a2 2 0 0 1 2-2h3M21 8V5a2 2 0 0 0-2-2h-3M21 16v3a2 2 0 0 1-2 2h-3M3 16v3a2 2 0 0 0 2 2h3" />
  </Icon>
);

/** The whole window, corner to corner: "hide the browser's own chrome". */
export const FullscreenEnterIcon = ({ size }: P) => (
  <Icon size={size}>
    <path d="M4 9V6a2 2 0 0 1 2-2h3M20 9V6a2 2 0 0 0-2-2h-3M4 15v3a2 2 0 0 0 2 2h3M20 15v3a2 2 0 0 1-2 2h-3" />
  </Icon>
);

/** Corners pulled back in: "give the address bar back". */
export const FullscreenExitIcon = ({ size }: P) => (
  <Icon size={size}>
    <path d="M9 4v3a2 2 0 0 1-2 2H4M15 4v3a2 2 0 0 0 2 2h3M9 20v-3a2 2 0 0 0-2-2H4M15 20v-3a2 2 0 0 1 2-2h3" />
  </Icon>
);

export const LatestIcon = ({ size }: P) => (
  <Icon size={size}>
    <path d="m6 17 5-5-5-5M13 17l5-5-5-5" />
  </Icon>
);

export const AlertIcon = ({ size }: P) => (
  <Icon size={size}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v4M12 16h.01" />
  </Icon>
);

export const ChartIcon = ({ size }: P) => (
  <Icon size={size}>
    <path d="M3 3v18h18" />
    <path d="m7 15 4-5 3 3 5-7" />
  </Icon>
);

/* The chart types, as TradingView pictures them. */

export const CandlesIcon = ({ size }: P) => (
  <Icon size={size}>
    <path d="M8 3v3M8 16v4M16 5v4M16 17v3" />
    <rect x="6" y="6" width="4" height="10" rx="1" fill="currentColor" />
    <rect x="14" y="9" width="4" height="8" rx="1" />
  </Icon>
);

export const HollowCandlesIcon = ({ size }: P) => (
  <Icon size={size}>
    <path d="M8 3v3M8 16v4M16 5v4M16 17v3" />
    <rect x="6" y="6" width="4" height="10" rx="1" />
    <rect x="14" y="9" width="4" height="8" rx="1" />
  </Icon>
);

export const OhlcBarsIcon = ({ size }: P) => (
  <Icon size={size}>
    <path d="M8 4v15M5 7h3M8 15h3" />
    <path d="M16 6v14M13 16h3M16 9h3" />
  </Icon>
);

export const LineChartIcon = ({ size }: P) => (
  <Icon size={size}>
    <path d="m3 17 5-6 4 3 4-7 5 5" />
  </Icon>
);

export const AreaChartIcon = ({ size }: P) => (
  <Icon size={size}>
    <path d="m3 15 5-6 4 3 4-7 5 5" />
    <path d="M3 15 8 9l4 3 4-7 5 5v10H3z" fill="currentColor" stroke="none" opacity="0.3" />
  </Icon>
);

export const LineMarkersIcon = ({ size }: P) => (
  <Icon size={size}>
    <path d="m4 17 5-6 4 3 5-7" />
    <circle cx="4" cy="17" r="1.5" fill="currentColor" />
    <circle cx="9" cy="11" r="1.5" fill="currentColor" />
    <circle cx="13" cy="14" r="1.5" fill="currentColor" />
    <circle cx="18" cy="7" r="1.5" fill="currentColor" />
  </Icon>
);

export const StepLineIcon = ({ size }: P) => (
  <Icon size={size}>
    <path d="M3 18h4v-6h5v3h4V6h5" />
  </Icon>
);

export const HlcAreaIcon = ({ size }: P) => (
  <Icon size={size}>
    <path d="m3 11 5-5 4 3 4-5 5 4" />
    <path d="m3 18 5-4 4 2 4-5 5 3" />
    <path d="m3 11 5-5 4 3 4-5 5 4v9l-5-3-4 5-4-2-5 4z" fill="currentColor" stroke="none" opacity="0.25" />
  </Icon>
);

export const BaselineIcon = ({ size }: P) => (
  <Icon size={size}>
    <path d="M3 12h18" strokeDasharray="2 2.5" opacity="0.6" />
    <path d="m3 16 4-7 4 5 4-9 3 8 3 3" />
  </Icon>
);

export const HighLowIcon = ({ size }: P) => (
  <Icon size={size}>
    <rect x="5" y="5" width="4" height="12" rx="1" />
    <rect x="15" y="8" width="4" height="11" rx="1" />
  </Icon>
);

/** TradingView's "fx": the indicators menu. */
export const IndicatorsIcon = ({ size }: P) => (
  <Icon size={size}>
    <path d="M9 20c2 0 2.5-2 3-6l1-6c.5-3 1.5-4 3.5-4" />
    <path d="M7 10h8" />
    <path d="m15 14 5 5m0-5-5 5" />
  </Icon>
);

/*
 * The OI profile's views: filled bars hanging off a right-hand axis, as they draw on the chart
 * (strokes read as lines at 16 px, not bars).
 */
function BarsIcon({ size = 16, children }: Readonly<{ size?: number; children: ReactNode }>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="21" y="3" width="1.5" height="18" rx="0.75" opacity="0.5" />
      {children}
    </svg>
  );
}

/** Total OI faint, today's addition solid at each bar's outer end. */
export const OiBothIcon = ({ size }: P) => (
  <BarsIcon size={size}>
    <rect x="6" y="5" width="14" height="3.5" rx="1" opacity="0.4" />
    <rect x="10" y="10.25" width="10" height="3.5" rx="1" opacity="0.4" />
    <rect x="3" y="15.5" width="17" height="3.5" rx="1" opacity="0.4" />
    <rect x="6" y="5" width="5" height="3.5" rx="1" />
    <rect x="10" y="10.25" width="3.5" height="3.5" rx="1" />
    <rect x="3" y="15.5" width="6" height="3.5" rx="1" />
  </BarsIcon>
);

/** Total OI alone. */
export const OiTotalIcon = ({ size }: P) => (
  <BarsIcon size={size}>
    <rect x="6" y="5" width="14" height="3.5" rx="1" />
    <rect x="10" y="10.25" width="10" height="3.5" rx="1" />
    <rect x="3" y="15.5" width="17" height="3.5" rx="1" />
  </BarsIcon>
);

/** Today's change alone: two strikes added, one shed (an outline). */
export const OiChangeIcon = ({ size }: P) => (
  <BarsIcon size={size}>
    <rect x="13" y="5" width="7" height="3.5" rx="1" />
    <rect x="8.75" y="11" width="10.5" height="2" rx="0.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <rect x="15" y="15.5" width="5" height="3.5" rx="1" />
  </BarsIcon>
);

/** Delta x OI: bars scaled by delta, the calls' full and the puts' reaching less, with a delta mark. */
export const DeltaOiIcon = ({ size }: P) => (
  <BarsIcon size={size}>
    <rect x="9" y="4" width="11" height="3" rx="1" />
    <rect x="13" y="8.5" width="7" height="3" rx="1" opacity="0.55" />
    <path d="M3.5 21 8 12.5 12.5 21z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    <rect x="11" y="14.5" width="9" height="3" rx="1" opacity="0.55" />
  </BarsIcon>
);

export function Spinner({ size = 16 }: P) {
  return (
    <svg className="mh-spin" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M21 12a9 9 0 1 1-6.22-8.56" />
    </svg>
  );
}

export const TableIcon = ({ size }: P) => (
  <Icon size={size}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 10h18M3 15h18M10 4v16" />
  </Icon>
);
