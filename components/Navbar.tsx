"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ThemeToggle } from "./ThemeToggle";

export function Navbar() {
  const pathname = usePathname();

  const linkClass = (path: string) => {
    const active = pathname === path;
    return `text-xs font-medium px-2.5 py-1.5 rounded-md transition-colors ${
      active
        ? "text-text-primary bg-bg-card border border-border"
        : "text-text-muted hover:text-text-primary hover:bg-bg-card/60"
    }`;
  };

  return (
    <nav className="sticky top-0 z-40 border-b border-border bg-bg-primary/85 backdrop-blur-md px-4 sm:px-6 py-2.5 flex items-center justify-between gap-3 flex-wrap">
      <div className="flex items-center gap-3">
        <Link
          href="/"
          className="flex items-center gap-2 text-lg font-semibold tracking-tight text-text-primary hover:text-accent-blue transition-colors"
        >
          <span
            aria-hidden
            className="w-2 h-2 rounded-full bg-accent-green shadow-[0_0_8px_var(--accent-green)]"
          />
          PredEdge
        </Link>
        <span className="text-[10px] text-text-muted font-mono uppercase tracking-[0.1em] bg-bg-card border border-border px-2 py-0.5 rounded-md">
          Tail Scanner
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <Link href="/" className={linkClass("/")}>
          Scanner
        </Link>
        <Link href="/trades" className={linkClass("/trades")}>
          Paper Trading
        </Link>
        <Link href="/mstr" className={linkClass("/mstr")}>
          MSTR Report
        </Link>
        <Link href="/saylor" className={linkClass("/saylor")}>
          Saylor
        </Link>
        <span className="w-px h-4 bg-border mx-1.5 hidden sm:block" aria-hidden />
        <ThemeToggle />
        <a
          href="https://polymarket.com"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-text-muted hover:text-text-secondary transition-colors px-2 py-1.5"
        >
          Polymarket &rarr;
        </a>
      </div>
    </nav>
  );
}
