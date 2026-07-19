import Link from "next/link";

const links = [
  { href: "/", label: "Store" },
  { href: "/events", label: "Events" },
  { href: "/ops", label: "Ops Agent" },
];

export default function Nav() {
  return (
    <header className="fixed top-4 inset-x-0 z-50 px-4">
      <nav className="max-w-5xl mx-auto flex items-center justify-between bg-white/60 backdrop-blur-xl border border-white/40 rounded-full shadow-glass px-5 py-2.5">
        <Link href="/" className="flex items-center gap-2">
          <span className="w-7 h-7 rounded-full bg-primary text-white grid place-items-center text-sm font-extrabold">
            M
          </span>
          <span className="font-extrabold tracking-tight text-ink">
            Montmare<span className="text-primary"> Store</span>
          </span>
        </Link>
        <div className="flex items-center gap-1">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="px-4 py-1.5 rounded-full text-sm font-medium text-ink/70 hover:text-primary hover:bg-white/70 transition-colors"
            >
              {l.label}
            </Link>
          ))}
        </div>
      </nav>
    </header>
  );
}
