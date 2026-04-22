"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { FillResult, Opportunity } from "@/lib/types";
import { DEFAULT_SCAN_CONFIG } from "@/lib/polymarket/config";
import { estimateHoldingDays } from "@/lib/polymarket/scoring";

interface Props {
  opportunity: Opportunity;
  side: "YES" | "NO";
  /** Outcome name like "Yes" / "No" as stored in outcomeTokens */
  outcomeName: string;
  tokenId: string;
  onClose: () => void;
  onConfirmed: () => void;
}

const QUICK_AMOUNTS = [100, 500, 1000, 5000];

export function TradeModal({
  opportunity,
  side,
  outcomeName,
  tokenId,
  onClose,
  onConfirmed,
}: Props) {
  const [usdAmount, setUsdAmount] = useState<number>(100);
  const [fill, setFill] = useState<FillResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  // Auto-preview when amount or side changes
  useEffect(() => {
    if (!Number.isFinite(usdAmount) || usdAmount <= 0) {
      setFill(null);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setPreviewLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/trade/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tokenId, usdAmount }),
          signal: ctrl.signal,
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Preview failed");
        setFill(json.fill as FillResult);
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setError((err as Error).message);
          setFill(null);
        }
      } finally {
        setPreviewLoading(false);
      }
    }, 300);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [usdAmount, tokenId]);

  const handleConfirm = async () => {
    if (!fill || fill.shares <= 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conditionId: opportunity.conditionId,
          tokenId,
          question: opportunity.question,
          outcome: outcomeName,
          marketUrl: opportunity.marketUrl,
          endDate: opportunity.endDate,
          usdAmount,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Trade failed");
      setConfirmed(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const investedUsd = fill ? usdAmount - fill.remainingUsd : 0;
  const payoutIfWin = fill ? fill.shares : 0;
  // Deduct fees + transfer cost to match the scanner's netReturnPct definition.
  // Without this, the scanner would show e.g. 2.55% net while the modal shows
  // 3.09% gross for the same trade — confusing users.
  const feeCost = investedUsd * DEFAULT_SCAN_CONFIG.feePct;
  const transferCost = investedUsd * DEFAULT_SCAN_CONFIG.transferCostPct;
  const grossPnlIfWin = fill ? payoutIfWin - investedUsd : 0;
  const pnlIfWin = fill ? grossPnlIfWin - feeCost - transferCost : 0;

  // Estimate annualized yield using the same holding-days model the scanner
  // uses (ceiling + 3-day settlement floor for past-due markets), so a card
  // showing 1550% annualized doesn't become 2000% inside the modal.
  const holdDays = estimateHoldingDays(opportunity.endDate);
  const annualizedYield =
    investedUsd > 0 ? (pnlIfWin / investedUsd) * (365 / holdDays) * 100 : 0;

  const bookDrained = fill != null && fill.remainingUsd > 0;

  // ── Success state ──
  if (confirmed && fill) {
    const invested = usdAmount - fill.remainingUsd;
    const grossPnlSuccess = fill.shares - invested;
    const feesSuccess =
      invested *
      (DEFAULT_SCAN_CONFIG.feePct + DEFAULT_SCAN_CONFIG.transferCostPct);
    const pnlIfWinSuccess = grossPnlSuccess - feesSuccess;
    return (
      <div
        className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
        onClick={onConfirmed}
      >
        <div
          className="bg-bg-card border border-accent-green/40 rounded-lg p-6 max-w-md w-full"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Success icon */}
          <div className="flex flex-col items-center text-center mb-4">
            <div className="w-14 h-14 rounded-full bg-accent-green/15 flex items-center justify-center mb-3">
              <svg
                viewBox="0 0 24 24"
                width="28"
                height="28"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-accent-green"
              >
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            </div>
            <h3 className="text-lg font-semibold text-text-primary">
              Trade Placed!
            </h3>
            <p className="text-xs text-text-muted mt-1">
              Your paper trade has been recorded.
            </p>
          </div>

          {/* Summary */}
          <div className="bg-bg-input border border-border rounded-lg p-3 mb-4 space-y-2">
            <div className="text-xs text-text-secondary leading-relaxed">
              Bought{" "}
              <span className="font-mono font-semibold text-text-primary">
                {fill.shares.toFixed(2)}
              </span>{" "}
              shares of{" "}
              <span
                className={`font-semibold ${
                  outcomeName.toLowerCase() === "yes"
                    ? "text-accent-green"
                    : outcomeName.toLowerCase() === "no"
                      ? "text-accent-red"
                      : "text-accent-blue"
                }`}
              >
                {outcomeName.toUpperCase()}
              </span>{" "}
              @ avg{" "}
              <span className="font-mono text-text-primary">
                ${fill.avgFillPrice.toFixed(4)}
              </span>
            </div>
            <div className="text-[11px] text-text-muted line-clamp-2">
              {opportunity.question}
            </div>
            <div className="border-t border-border pt-2 grid grid-cols-2 gap-2 text-xs">
              <div>
                <div className="text-[10px] text-text-muted uppercase tracking-wider">
                  Invested
                </div>
                <div className="font-mono text-text-primary">
                  ${invested.toFixed(2)}
                </div>
              </div>
              <div>
                <div className="text-[10px] text-text-muted uppercase tracking-wider">
                  P&amp;L if Win
                </div>
                <div className="font-mono text-accent-green">
                  +${pnlIfWinSuccess.toFixed(2)}
                </div>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-2">
            <button
              onClick={onConfirmed}
              className="flex-1 px-4 py-2 rounded border border-border text-text-secondary hover:text-text-primary transition-colors"
            >
              Close
            </button>
            <Link
              href="/trades"
              className="flex-1 px-4 py-2 rounded bg-accent-blue text-white font-medium hover:bg-accent-blue/90 transition-colors text-center"
            >
              View in Paper Trading →
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-bg-card border border-border rounded-lg p-6 max-w-lg w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <div
              className={`inline-block px-2 py-0.5 rounded text-xs font-semibold mb-2 ${
                side === "YES"
                  ? "bg-accent-green/20 text-accent-green"
                  : "bg-accent-red/20 text-accent-red"
              }`}
            >
              BUY {outcomeName.toUpperCase()}
            </div>
            <h3 className="text-sm font-medium text-text-primary leading-tight">
              {opportunity.question}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary text-xl leading-none"
          >
            ×
          </button>
        </div>

        {/* Amount input */}
        <div className="mb-4">
          <label className="block text-xs text-text-muted mb-1.5">
            USD Amount
          </label>
          <input
            type="number"
            min="1"
            step="1"
            value={usdAmount}
            onChange={(e) => setUsdAmount(parseFloat(e.target.value) || 0)}
            className="w-full bg-bg-input border border-border rounded px-3 py-2 text-lg font-mono text-text-primary focus:outline-none focus:border-accent-blue"
          />
          <div className="flex gap-1.5 mt-2">
            {QUICK_AMOUNTS.map((a) => (
              <button
                key={a}
                onClick={() => setUsdAmount(a)}
                className="px-2 py-1 text-xs rounded border border-border text-text-secondary hover:border-accent-blue hover:text-text-primary transition-colors"
              >
                ${a}
              </button>
            ))}
          </div>
        </div>

        {/* Preview */}
        {previewLoading && (
          <div className="text-center py-6 text-text-muted text-sm animate-pulse">
            Fetching order book…
          </div>
        )}

        {error && (
          <div className="bg-accent-red-dim/30 border border-accent-red/30 rounded-lg px-3 py-2 text-sm text-accent-red mb-3">
            {error}
          </div>
        )}

        {fill && !previewLoading && (
          <div className="bg-bg-input border border-border rounded-lg p-3 mb-4 space-y-2 text-xs">
            <div className="grid grid-cols-2 gap-2">
              <Cell
                label="Shares"
                value={fill.shares.toFixed(2)}
                highlight
              />
              <Cell
                label="Avg Fill"
                value={`$${fill.avgFillPrice.toFixed(4)}`}
              />
              <Cell
                label="Worst Fill"
                value={`$${fill.worstFillPrice.toFixed(4)}`}
              />
              <Cell
                label="Invested"
                value={`$${investedUsd.toFixed(2)}`}
              />
            </div>

            <div className="border-t border-border pt-2 grid grid-cols-2 gap-2">
              <Cell
                label="P&L if Win"
                value={`+$${pnlIfWin.toFixed(2)}`}
                className="text-accent-green"
              />
              <Cell
                label="P&L if Lose"
                value={`-$${investedUsd.toFixed(2)}`}
                className="text-accent-red"
              />
              <Cell
                label="Ann. Yield if Win"
                value={`${annualizedYield.toFixed(1)}%`}
                className="text-accent-amber"
              />
              <Cell
                label="Hold Days"
                value={holdDays.toFixed(1)}
              />
            </div>
            <div className="text-[10px] text-text-muted font-mono leading-relaxed">
              Gross +${grossPnlIfWin.toFixed(2)} · Fees −${feeCost.toFixed(2)} · Transfer −${transferCost.toFixed(2)}
            </div>

            {bookDrained && (
              <div className="text-accent-amber text-[11px] pt-1">
                ⚠ Book drained — ${fill.remainingUsd.toFixed(2)} of ${usdAmount} couldn&apos;t fill.
                Actual invested: ${investedUsd.toFixed(2)}
              </div>
            )}

            <details className="pt-1 text-text-muted">
              <summary className="cursor-pointer text-[11px]">
                Fill breakdown ({fill.fills.length} level{fill.fills.length > 1 ? "s" : ""})
              </summary>
              <div className="mt-1 space-y-0.5 font-mono text-[11px]">
                {fill.fills.map((f, i) => (
                  <div key={i} className="flex justify-between">
                    <span>@ ${f.price.toFixed(4)}</span>
                    <span>{f.size.toFixed(2)} shares</span>
                    <span>${f.cost.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </details>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 rounded border border-border text-text-secondary hover:text-text-primary transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!fill || fill.shares <= 0 || submitting || previewLoading}
            className="flex-1 px-4 py-2 rounded bg-accent-blue text-white font-medium hover:bg-accent-blue/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? "Submitting…" : "Confirm Trade"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Cell({
  label,
  value,
  className = "",
  highlight = false,
}: {
  label: string;
  value: string;
  className?: string;
  highlight?: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] text-text-muted uppercase tracking-wider">
        {label}
      </div>
      <div
        className={`font-mono ${highlight ? "text-sm font-semibold" : ""} ${
          className || "text-text-primary"
        }`}
      >
        {value}
      </div>
    </div>
  );
}
