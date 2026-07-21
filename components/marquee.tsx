function cx(...parts: Array<string | undefined | false>) {
  return parts.filter(Boolean).join(" ");
}

/**
 * CSS-only infinite ticker band. Two identical halves + translateX(-50%)
 * keyframes = seamless loop; animation pauses under prefers-reduced-motion
 * (see .marquee rules in globals.css). Decorative — hidden from AT.
 *
 * Each half repeats the line 5× so one half outspans even ultra-wide
 * viewports — a half narrower than the container leaves a bare-background
 * gap cycling through the band. Keep the -50% shift a whole multiple of
 * the line width or the loop visibly jumps.
 */
export function Marquee({
  items,
  glyph = "✦",
  thin = false,
  className,
}: {
  items: string[];
  glyph?: string;
  thin?: boolean;
  className?: string;
}) {
  const line = items.map((item) => `${item} ${glyph} `).join("").repeat(5);
  return (
    <div
      aria-hidden
      className={cx("marquee", thin && "marquee-thin", className)}
    >
      <div className="marquee-track">
        <span>{line}</span>
        <span>{line}</span>
      </div>
    </div>
  );
}
