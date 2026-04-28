"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark" | "auto";

function getSystemDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyTheme(theme: Theme) {
  const isDark = theme === "auto" ? getSystemDark() : theme === "dark";
  document.documentElement.setAttribute(
    "data-theme",
    isDark ? "dark" : "light"
  );
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === "undefined") return "auto";
    return (localStorage.getItem("prededge-theme") as Theme | null) ?? "auto";
  });

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Listen for system theme changes when in auto mode
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (theme === "auto") applyTheme("auto");
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  const cycle = () => {
    const next: Theme =
      theme === "auto" ? "light" : theme === "light" ? "dark" : "auto";
    setTheme(next);
    localStorage.setItem("prededge-theme", next);
  };

  const icon = theme === "auto" ? "A" : theme === "light" ? "\u2600" : "\u263E";
  const label =
    theme === "auto" ? "Auto" : theme === "light" ? "Light" : "Dark";

  return (
    <button
      onClick={cycle}
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-text-muted hover:text-text-primary bg-bg-card border border-border hover:border-accent-blue/40 transition-colors"
      title={`Theme: ${label} (click to cycle)`}
    >
      <span className="text-sm leading-none">{icon}</span>
      <span>{label}</span>
    </button>
  );
}
