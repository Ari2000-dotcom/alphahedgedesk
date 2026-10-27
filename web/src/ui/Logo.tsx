/**
 * MarketHub's mark: a straddle's payoff, the V, over a level line (the
 * premium the desk watches). Drawn in the brand gold straight on the title
 * bar, no tile behind it.
 */
export function Logo({ size = 20 }: Readonly<{ size?: number }>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path d="M3.5 4.5 L12 18.5 L20.5 4.5" fill="none" stroke="var(--mh-brand)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.5 12 H21.5" fill="none" stroke="var(--mh-brand)" strokeOpacity="0.55" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
