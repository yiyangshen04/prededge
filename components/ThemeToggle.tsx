"use client";

import { useEffect, useSyncExternalStore } from "react";

type Theme = "light" | "dark" | "auto";

const THEME_STORAGE_KEY = "prededge-theme";
const THEME_CHANGE_EVENT = "prededge-theme-change";
const DEFAULT_THEME: Theme = "auto";

function isTheme(value: string | null): value is Theme {
  return value === "light" || value === "dark" || value === "auto";
}

function getStoredTheme(): Theme {
  const storedTheme = localStorage.getItem(THEME_STORAGE_KEY);
  return isTheme(storedTheme) ? storedTheme : DEFAULT_THEME;
}

function subscribeThemeChange(onChange: () => void) {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY) {
      onChange();
    }
  };
  const handleThemeChange = () => onChange();

  window.addEventListener("storage", handleStorage);
  window.addEventListener(THEME_CHANGE_EVENT, handleThemeChange);

  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(THEME_CHANGE_EVENT, handleThemeChange);
  };
}

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
  const theme = useSyncExternalStore(
    subscribeThemeChange,
    getStoredTheme,
    () => DEFAULT_THEME
  );

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
    localStorage.setItem(THEME_STORAGE_KEY, next);
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
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
