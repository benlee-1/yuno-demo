function cx(...parts: Array<string | undefined | false>) {
  return parts.filter(Boolean).join(" ");
}

/**
 * CSS-only infinite ticker band. Two identical halves + translateX(-50%)
 * keyframes = seamless loop; animation pauses under prefers-reduced-motion
 * (see .marquee rules in globals.css). Decorative — hidden from AT.
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
  const line = items.map((item) => `${item} ${glyph} `).join("");
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
