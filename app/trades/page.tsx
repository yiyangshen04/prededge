"use client";

import { useState, useEffect, useCallback } from "react";
import type { PaperTrade } from "@/lib/types";
import { TradeStats } from "@/components/TradeStats";
import { PnlChart } from "@/components/PnlChart";
import { TradeTable } from "@/components/TradeTable";

export default function TradesPage() {
  const [trades, setTrades] = useState<PaperTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const fetchTrades = useCallback(async () => {
    try {
      const res = await fetch("/api/trades?status=all");
      if (!res.ok) throw new Error((await res.json()).error ?? "Fetch failed");
      const json = await res.json();
      setTrades(json.trades);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTrades();
  }, [fetchTrades]);

  const runRefresh = async () => {
    setRefreshing(true);
    setStatusMsg(null);
    setError(null);
    try {
      const res = await fetch("/api/trades/refresh", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Refresh failed");
      const failedNote =
        typeof json.failed === "number" && json.failed > 0
          ? ` (${json.failed} update${json.failed === 1 ? "" : "s"} failed — check server logs)`
          : "";
      setStatusMsg(
        json.resolved > 0
          ? `Checked ${json.checked} open trades, resolved ${json.resolved}.${failedNote}`
          : json.message ?? `Checked ${json.checked} open trades, no new resolutions.${failedNote}`
      );
      await fetchTrades();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-6 py-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">
            Paper Trading
          </h1>
          <p className="text-sm text-text-muted mt-1">
            Simulate buying into opportunities and track how the scanner&apos;s picks actually play out.
          </p>
        </div>
        <button
          onClick={runRefresh}
          disabled={refreshing}
          className="px-4 py-2 bg-accent-blue text-white text-sm font-medium rounded-lg hover:bg-accent-blue/90 disabled:opacity-50 transition-colors"
        >
          {refreshing ? "Refreshing…" : "Refresh Resolutions"}
        </button>
      </div>

      {/* Status / error */}
      {statusMsg && (
        <div className="bg-accent-blue/10 border border-accent-blue/30 rounded-lg px-4 py-2 text-sm text-accent-blue">
          {statusMsg}
        </div>
      )}
      {error && (
        <div className="bg-accent-red-dim/30 border border-accent-red/30 rounded-lg px-4 py-3 text-sm text-accent-red">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-center py-20 text-text-muted animate-pulse">
          Loading trades…
        </div>
      ) : (
        <>
          <TradeStats trades={trades} />
          <PnlChart trades={trades} />
          <TradeTable trades={trades} />
        </>
      )}
    </div>
  );
}
