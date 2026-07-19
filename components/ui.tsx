import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
} from "react";

function cx(...parts: Array<string | undefined | false>) {
  return parts.filter(Boolean).join(" ");
}

export function GlassCard({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cx(
        "bg-white/60 backdrop-blur-xl border border-white/40 rounded-3xl shadow-glass",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "lime" | "ghost";
};

export function Button({
  className,
  variant = "primary",
  children,
  ...props
}: ButtonProps) {
  const variants = {
    primary:
      "bg-primary text-white hover:bg-primary-dark shadow-[0_4px_16px_rgba(62,79,224,0.35)]",
    lime: "bg-lime text-ink hover:brightness-95 shadow-[0_4px_16px_rgba(199,233,86,0.45)]",
    ghost:
      "bg-white/50 text-primary border border-primary/20 hover:bg-white/80",
  } as const;
  return (
    <button
      className={cx(
        "inline-flex items-center justify-center gap-2 px-6 py-3 rounded-btn font-semibold",
        "transition-all duration-200 active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none cursor-pointer",
        variants[variant],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function Input({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cx(
        "w-full px-4 py-3 rounded-btn bg-white/70 border border-white/60 text-ink",
        "placeholder:text-neutral-400 outline-none transition-all duration-200",
        "focus:border-primary-light focus:ring-2 focus:ring-primary-light/30 focus:bg-white/90",
        className,
      )}
      {...props}
    />
  );
}

type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: "success" | "error" | "pending" | "neutral";
};

export function Badge({
  className,
  tone = "neutral",
  children,
  ...props
}: BadgeProps) {
  const tones = {
    success: "bg-lime/60 text-ink border-lime",
    error: "bg-red-100 text-red-700 border-red-200",
    pending: "bg-pale text-primary-dark border-primary-light/40",
    neutral: "bg-white/60 text-neutral-500 border-neutral-300",
  } as const;
  return (
    <span
      className={cx(
        "inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold border tracking-wide uppercase",
        tones[tone],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
