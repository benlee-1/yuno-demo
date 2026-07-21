"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { GlassCard, Button, Input, Badge } from "@/components/ui";
import { Marquee } from "@/components/marquee";

const TICKER = [
  "SUPERCHARGE YOUR MIND",
  "SANDBOX CERTIFIED",
  "R$ 89",
  "AGENT APPROVED",
  "10X YOUR MORNING",
  "NO REAL CHARGES",
  "DROP 001",
];

export default function StorePage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  function buyNow() {
    const params = new URLSearchParams();
    params.set("name", name.trim() || "Maria Silva");
    // Optional field — forward only email-shaped input (server drops the rest
    // too; this just keeps a stray value out of the order summary).
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
      params.set("email", email.trim());
    router.push(`/checkout?${params.toString()}`);
  }

  return (
    <div className="flex flex-col items-center gap-10">
      {/* Ticker band — full-bleed, slightly tilted */}
      {/* Width set inline: this Tailwind build drops `w-[110vw]`, letting the
          band shrink to its text width and cut off on wide screens. No manual
          centering — the items-center flex parent centers the overflow, and
          adding left-1/2/-translate-x-1/2 on top double-shifts the band left. */}
      <div className="relative -rotate-1" style={{ width: "110vw" }}>
        <Marquee
          items={TICKER}
          className="bg-primary text-lime font-display text-sm sm:text-base py-2.5 shadow-[0_8px_32px_rgba(62,79,224,0.25)]"
        />
      </div>

      {/* SHOUT hero */}
      <header className="text-center px-2">
        <Badge tone="pending" className="sticker mb-4 [--tilt:-2deg]">
          Limited harvest — Drop 001
        </Badge>
        <h1 className="font-display uppercase leading-[0.88] tracking-tight text-ink text-5xl sm:text-7xl lg:text-[6.5rem]">
          10X <span className="text-primary">Coffee</span>
        </h1>
        <p className="mt-4 font-display uppercase tracking-wide text-ink/80 text-lg sm:text-2xl">
          Makes you a 10X developer<span className="text-primary">*</span>
        </p>
        <p className="mt-1 text-xs text-neutral-400 font-medium">
          *results may vary. Refunds don&apos;t — our agent handles those.
        </p>
      </header>

      <GlassCard className="w-full p-8 sm:p-12 overflow-hidden">
        <div className="grid md:grid-cols-2 gap-12 items-center">
          {/* CSS-only product visual — tilted bag + floating stickers */}
          <div className="relative mx-auto w-full max-w-xs">
            <div className="relative -rotate-3 aspect-square rounded-3xl bg-gradient-to-br from-primary via-primary-dark to-[#1c2470] shadow-[0_20px_60px_rgba(62,79,224,0.35)] grid place-items-center overflow-hidden transition-transform duration-300 hover:rotate-0">
              <div className="absolute -top-10 -left-10 w-40 h-40 rounded-full bg-primary-light/40 blur-2xl" />
              <div className="absolute -bottom-12 -right-8 w-44 h-44 rounded-full bg-lime/25 blur-2xl" />
              <div className="relative flex flex-col items-center gap-3 text-center px-6">
                <span className="text-6xl" aria-hidden>
                  ☕
                </span>
                <div className="text-white font-display uppercase text-xl tracking-tight leading-tight">
                  10X Blend
                </div>
                <div className="text-pale text-xs font-medium tracking-[0.2em] uppercase">
                  Dev Fuel · 250g
                </div>
                <span className="sticker mt-1 px-3 py-1 rounded-full bg-lime text-ink text-xs font-bold [--tilt:2deg]">
                  Supercharge your mind
                </span>
              </div>
            </div>

            {/* Floating sticker badges */}
            <span
              className="sticker absolute -top-4 -left-3 px-3 py-1.5 rounded-full bg-ink text-lime font-display text-[11px] uppercase tracking-wider shadow-lg [--tilt:-6deg]"
              aria-hidden
            >
              Drop 001
            </span>
            <div
              className="stamp-round absolute -top-8 -right-6 w-24 h-24 sm:w-28 sm:h-28 bg-white/70 backdrop-blur-md text-primary-dark shadow-glass [--tilt:10deg]"
              aria-hidden
            >
              <span className="px-3 font-display text-[9px] leading-[1.35] tracking-wider">
                Sandbox only · no real beans harmed
              </span>
            </div>
            <span
              className="sticker absolute -bottom-6 -right-2 px-4 py-2 rounded-2xl bg-lime text-ink font-display text-2xl shadow-[0_8px_24px_rgba(199,233,86,0.5)] [--tilt:3deg]"
              aria-hidden
            >
              R$ 89
            </span>
          </div>

          {/* Details + purchase form */}
          <div className="flex flex-col gap-5">
            <div>
              <h2 className="font-display uppercase tracking-tight text-2xl text-ink">
                The bag
              </h2>
              <p className="mt-2 text-ink/70 leading-relaxed">
                Single-origin beans for developers who ship. Notes of dark
                chocolate, orange zest, and unreasonable productivity — one cup
                is worth roughly ten standups. Roasted this week, shipped
                whole-bean in a 250g valve bag.
              </p>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="font-display text-4xl text-primary">
                R$ 89,00
              </span>
              <span className="text-sm text-neutral-400 font-medium">BRL</span>
            </div>
            <div className="flex flex-col gap-3">
              <Input
                placeholder="Maria Silva"
                aria-label="Customer name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <Input
                type="email"
                placeholder="Email (optional)"
                aria-label="Customer email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Button
                variant="lime"
                onClick={buyNow}
                className="w-full font-display text-base tracking-wide py-4"
              >
                BUY NOW — R$ 89
              </Button>
            </div>
          </div>
        </div>
      </GlassCard>

      <p className="text-xs text-neutral-400 font-medium">
        Yuno sandbox demo — no real charges
      </p>
    </div>
  );
}
