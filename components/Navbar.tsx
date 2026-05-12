"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ThemeToggle } from "./ThemeToggle";

export function Navbar() {
  const pathname = usePathname();

  const linkClass = (path: string) => {
    const active = pathname === path;
    return `text-xs font-medium transition-colors ${
      active
        ? "text-text-primary"
        : "text-text-muted hover:text-text-secondary"
    }`;
  };

  return (
    <nav className="border-b border-border px-6 py-3 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <Link
          href="/"
          className="text-lg font-semibold tracking-tight text-text-primary hover:text-accent-blue transition-colors"
        >
          PredEdge
        </Link>
        <span className="text-xs text-text-muted font-mono bg-bg-card px-2 py-0.5 rounded">
          Tail Scanner
        </span>
      </div>
      <div className="flex items-center gap-4">
        <Link href="/" className={linkClass("/")}>
          Scanner
        </Link>
        <Link href="/trades" className={linkClass("/trades")}>
          Paper Trading
        </Link>
        <Link href="/mstr" className={linkClass("/mstr")}>
          MSTR Report
        </Link>
        <ThemeToggle />
        <a
          href="https://polymarket.com"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-text-muted hover:text-text-secondary transition-colors"
        >
          Polymarket &rarr;
        </a>
      </div>
    </nav>
  );
}
