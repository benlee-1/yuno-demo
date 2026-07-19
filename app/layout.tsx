import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import Nav from "@/components/nav";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

export const metadata: Metadata = {
  title: "Montmare Store — Yuno Sandbox Demo",
  description:
    "One-product demo storefront powered by Yuno's financial infrastructure platform (sandbox).",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} h-full antialiased`}>
      <body className="min-h-screen flex flex-col">
        <div className="bg-mesh" aria-hidden>
          <div className="blob-lime" />
        </div>
        <Nav />
        <main className="flex-1 w-full max-w-5xl mx-auto px-4 sm:px-6 pt-24 pb-16">
          {children}
        </main>
      </body>
    </html>
  );
}
