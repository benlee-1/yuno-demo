"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { GlassCard, Button, Input, Badge } from "@/components/ui";

export default function StorePage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  function buyNow() {
    const params = new URLSearchParams();
    params.set("name", name.trim() || "Maria Silva");
    if (email.trim()) params.set("email", email.trim());
    router.push(`/checkout?${params.toString()}`);
  }

  return (
    <div className="flex flex-col items-center gap-8">
      <GlassCard className="w-full p-8 sm:p-12">
        <div className="grid md:grid-cols-2 gap-10 items-center">
          {/* CSS-only product visual */}
          <div className="relative mx-auto w-full max-w-xs aspect-square rounded-3xl bg-gradient-to-br from-primary via-primary-dark to-[#1c2470] shadow-[0_20px_60px_rgba(62,79,224,0.35)] grid place-items-center overflow-hidden">
            <div className="absolute -top-10 -left-10 w-40 h-40 rounded-full bg-primary-light/40 blur-2xl" />
            <div className="absolute -bottom-12 -right-8 w-44 h-44 rounded-full bg-lime/25 blur-2xl" />
            <div className="relative flex flex-col items-center gap-3 text-center px-6">
              <span className="text-6xl" aria-hidden>
                ☕
              </span>
              <div className="text-white font-extrabold text-xl tracking-tight">
                Montmare Reserva
              </div>
              <div className="text-pale text-xs font-medium tracking-[0.2em] uppercase">
                Single Origin · 250g
              </div>
              <span className="mt-1 px-3 py-1 rounded-full bg-lime text-ink text-xs font-bold">
                Torra fresca
              </span>
            </div>
          </div>

          {/* Details + purchase form */}
          <div className="flex flex-col gap-5">
            <Badge tone="pending" className="w-fit">
              Limited harvest
            </Badge>
            <div>
              <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight">
                Montmare Reserva
              </h1>
              <p className="mt-2 text-ink/70 leading-relaxed">
                Single-origin coffee from the Montmare highlands. Notes of dark
                chocolate, orange zest, and panela. Roasted this week, shipped
                whole-bean in a 250g valve bag.
              </p>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-4xl font-extrabold text-primary">
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
              <Button variant="lime" onClick={buyNow} className="w-full">
                Comprar / Buy now
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
