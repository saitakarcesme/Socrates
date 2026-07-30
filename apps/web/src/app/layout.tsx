import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell";

import "./globals.css";

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-sans",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: {
    default: "Socrates",
    template: "%s · Socrates",
  },
  description:
    "An autoresearch platform for measurable, iterative optimization.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html className={`${geist.variable} ${geistMono.variable}`} lang="en">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
