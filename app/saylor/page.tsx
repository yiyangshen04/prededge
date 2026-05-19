"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DecisionBadge } from "@/components/DecisionBadge";
import { ProbabilityGauge } from "@/components/ProbabilityGauge";
import {
  ProbabilityChart,
  type ProbabilityPoint,
} from "@/components/ProbabilityChart";
import { ScanButton } from "@/components/ScanButton";
import type {
  BacktestStat,
  CapitalActionFlag,
  CurrentMarket,
  Recommendation,
  SaylorTweet,
  SignalHit,
  WeekPrediction,
  WeekRecord,
} from "@/lib/saylor/types";

interface CurrentApiResponse {
  prediction: WeekPrediction | null;
  market: CurrentMarket | null;
  tweets: SaylorTweet[];
  signals: SignalHit[];
  capitalAction: CapitalActionFlag | null;
  weekStart: string;
  weekEnd: string;
  fetchedCount?: number;
  errors?: string[];
}

const RECOMMENDATION_TO_DECISION: Record<
  Recommendation,
  "actionable" | "observe" | "rejected"
> = {
  BUY_YES: "actionable",
  HOLD: "observe",
  BUY_NO: "rejected",
};

export default function SaylorPage() {
  const [data, setData] = useState<CurrentApiResponse | null>(null);
  const [history, setHistory] = useState<WeekRecord[]>([]);
  const [backtest, setBacktest] = useState<BacktestStat | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualText, setManualText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const fetchCurrent = useCallback(async () => {
    const res = await fetch("/api/saylor/current");
    if (!res.ok) throw new Error((await res.json()).error ?? "current failed");
    return (await res.json()) as CurrentApiResponse;
  }, []);

  const fetchHistory = useCallback(async () => {
    const res = await fetch("/api/saylor/history?limit=200");
    if (!res.ok) throw new Error((await res.json()).error ?? "history failed");
    const json = (await res.json()) as { weeks: WeekRecord[]; total: number };
    return json.weeks;
  }, []);

  const fetchBacktest = useCallback(async () => {
    const res = await fetch("/api/saylor/backtest");
    if (!res.ok) return null;
    return (await res.json()) as BacktestStat;
  }, []);

  const loadAll = useCallback(async () => {
    setError(null);
    try {
      const [cur, hist, bt] = await Promise.all([
        fetchCurrent(),
        fetchHistory(),
        fetchBacktest(),
      ]);
      setData(cur);
      setHistory(hist);
      setBacktest(bt);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [fetchCurrent, fetchHistory, fetchBacktest]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const onRefresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const res = await fetch("/api/saylor/refresh", { method: "POST" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `refresh failed (${res.status})`);
      }
      const json = (await res.json()) as CurrentApiResponse;
      setData(json);
      if (json.errors && json.errors.length > 0) {
        setStatus(
          `Refreshed with partial errors — ${json.errors.join("; ")}`
        );
      } else {
        setStatus(`Refreshed (${json.fetchedCount ?? 0} tweets pulled)`);
      }
      // refresh history + backtest too, in case import happened earlier
      const [hist, bt] = await Promise.all([fetchHistory(), fetchBacktest()]);
      setHistory(hist);
      setBacktest(bt);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [fetchHistory, fetchBacktest]);

  const onImportCsv = useCallback(async () => {
    setImporting(true);
    setError(null);
    setStatus(null);
    try {
      const res = await fetch("/api/saylor/admin/import-csv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `import failed (${res.status})`);
      }
      const json = (await res.json()) as {
        results: Array<{ path: string; inserted: number; shape: string }>;
      };
      const total = json.results.reduce((s, r) => s + r.inserted, 0);
      setStatus(`Imported ${total} rows from ${json.results.length} CSV file(s).`);
      const hist = await fetchHistory();
      setHistory(hist);
      const bt = await fetchBacktest();
      setBacktest(bt);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setImporting(false);
    }
  }, [fetchHistory, fetchBacktest]);

  const onManualSubmit = useCallback(async () => {
    if (manualText.trim().length === 0) return;
    setError(null);
    setStatus(null);
    try {
      const res = await fetch("/api/saylor/tweets/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rawText: manualText }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `manual failed (${res.status})`);
      }
      const json = (await res.json()) as {
        inserted: number;
        signals: Array<{ matchedPhrase: string; type: string }>;
      };
      setStatus(
        `Saved ${json.inserted} tweet(s), ${json.signals.length} signal(s) hit.`
      );
      setManualText("");
      setManualOpen(false);
      // re-run a refresh so the predictor picks up the new signals
      await onRefresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [manualText, onRefresh]);

  const toggleCapitalAction = useCallback(async () => {
    if (!data) return;
    const next = !(data.capitalAction?.flagged === true);
    try {
      const res = await fetch("/api/saylor/capital-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          weekStart: data.weekStart,
          flagged: next,
          note: next ? "Flagged via UI" : undefined,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `toggle failed (${res.status})`);
      }
      await onRefresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [data, onRefresh]);

  const probabilityPoints: ProbabilityPoint[] = useMemo(() => {
    // For now we only have the current-week prediction + historical outcomes.
    // Merge: every historical week becomes a point with `marketYes` from
    // close_price; the current week (if predicted) replaces/extends.
    const pts: ProbabilityPoint[] = history
      .slice()
      .sort((a, b) => a.startDate.localeCompare(b.startDate))
      .map((w) => ({
        weekStart: w.startDate,
        // For the historical "our prob" we don't have a real predictor
        // output — use the base rate (avg_price) as a passable proxy so the
        // chart line isn't dead-flat for backfilled weeks.
        probability: w.avgPrice ?? w.openPrice ?? 0.5,
        marketYes: w.closePrice ?? null,
        outcome: w.outcome,
      }));
    if (data?.prediction) {
      // overwrite or append the current-week row
      const idx = pts.findIndex((p) => p.weekStart === data.prediction!.weekStart);
      const point: ProbabilityPoint = {
        weekStart: data.prediction.weekStart,
        probability: data.prediction.probability,
        marketYes: data.market?.yesPrice ?? null,
        outcome: "OPEN",
      };
      if (idx >= 0) pts[idx] = point;
      else pts.push(point);
    }
    return pts;
  }, [history, data]);

  const buyHits = data?.signals.filter((s) => s.type === "BUY") ?? [];
  const nobuyHits = data?.signals.filter((s) => s.type === "NOBUY") ?? [];
  const greenHits = data?.signals.filter((s) => s.type === "GREEN") ?? [];
  const flags = data?.prediction?.flags;

  return (
    <div className="px-6 py-6 max-w-6xl mx-auto space-y-6">
      {/* ── Header ── */}
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
            Saylor BTC Signal
          </h1>
          <p className="text-xs text-text-muted mt-1">
            @saylor 推特暗语 + 财报日历 + 联邦假日 + 资本动作 → 下周 MSTR 买 BTC 概率
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onImportCsv}
            disabled={importing}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-bg-card border border-border text-text-secondary hover:bg-bg-card-hover transition-colors disabled:opacity-50"
          >
            {importing ? "Importing…" : "Import history CSV"}
          </button>
          <ScanButton loading={loading} onClick={onRefresh} />
        </div>
      </div>

      {/* ── Status / error ── */}
      {error && (
        <div className="bg-accent-red-dim text-accent-red text-xs px-3 py-2 rounded">
          {error}
        </div>
      )}
      {status && !error && (
        <div className="bg-bg-card border border-border text-xs px-3 py-2 rounded text-text-secondary">
          {status}
        </div>
      )}

      {/* ── Current week prediction card ── */}
      <div className="bg-bg-card border border-border rounded-lg p-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-center">
          <div className="flex justify-center">
            <ProbabilityGauge
              probability={data?.prediction?.probability ?? 0.5}
              size={220}
            />
          </div>
          <div className="md:col-span-2 space-y-3">
            <div className="flex items-baseline gap-3">
              <h2 className="text-lg font-medium text-text-primary">
                This week:{" "}
                <span className="font-mono">{data?.weekStart ?? "—"}</span> →{" "}
                <span className="font-mono">{data?.weekEnd ?? "—"}</span>
              </h2>
              {data?.prediction && (
                <DecisionBadge
                  decision={
                    RECOMMENDATION_TO_DECISION[data.prediction.recommendation]
                  }
                />
              )}
            </div>
            <div className="text-xs text-text-muted font-mono">
              Reason:{" "}
              <span className="text-text-secondary">
                {data?.prediction?.reason ?? "no_prediction_yet"}
              </span>
            </div>

            {/* Polymarket live strip */}
            <div className="bg-bg-input border border-border rounded p-3">
              <div className="text-xs text-text-muted mb-1">
                Polymarket — {data?.market?.question ?? "live market not loaded"}
              </div>
              {data?.market ? (
                <div className="flex items-baseline gap-4">
                  <div>
                    <div className="text-xs text-text-muted">YES</div>
                    <div className="font-mono text-lg text-accent-green">
                      {data.market.yesPrice == null
                        ? "—"
                        : `${(data.market.yesPrice * 100).toFixed(1)}¢`}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-text-muted">NO</div>
                    <div className="font-mono text-lg text-accent-red">
                      {data.market.noPrice == null
                        ? "—"
                        : `${(data.market.noPrice * 100).toFixed(1)}¢`}
                    </div>
                  </div>
                  {data.prediction && data.market.yesPrice != null && (
                    <div>
                      <div className="text-xs text-text-muted">Edge</div>
                      <div
                        className={`font-mono text-lg ${
                          data.prediction.probability > data.market.yesPrice
                            ? "text-accent-green"
                            : "text-accent-red"
                        }`}
                      >
                        {(
                          (data.prediction.probability - data.market.yesPrice) *
                          100
                        ).toFixed(1)}
                        pp
                      </div>
                    </div>
                  )}
                  <a
                    href={data.market.marketUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-auto text-xs text-accent-blue hover:underline"
                  >
                    Market →
                  </a>
                </div>
              ) : (
                <div className="text-xs text-text-muted">
                  Click Refresh to bind the live Polymarket market.
                </div>
              )}
            </div>

            {/* Capital-action toggle */}
            <div className="flex items-center gap-2 text-xs">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={data?.capitalAction?.flagged === true}
                  onChange={toggleCapitalAction}
                  className="rounded"
                />
                <span className="text-text-secondary">
                  Major capital action this week (ATM, restructure, rename)
                </span>
              </label>
              {data?.capitalAction?.flagged && (
                <span className="text-accent-amber font-mono">⚠ blocked</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Signal checklist ── */}
      <div className="bg-bg-card border border-border rounded-lg p-4">
        <h3 className="text-sm font-medium text-text-primary mb-3">
          Signal checklist
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          <SignalRow
            label="BUY暗语命中"
            value={
              buyHits.length === 0
                ? "—"
                : buyHits.map((h) => h.matchedPhrase).join(" · ")
            }
            tone={buyHits.length > 0 ? "green" : "neutral"}
          />
          <SignalRow
            label="NOBUY 暗语命中"
            value={
              nobuyHits.length === 0
                ? "—"
                : nobuyHits.map((h) => h.matchedPhrase).join(" · ")
            }
            tone={nobuyHits.length > 0 ? "red" : "neutral"}
          />
          <SignalRow
            label="GREEN dot"
            value={
              greenHits.length === 0
                ? "—"
                : greenHits.map((h) => h.matchedPhrase).join(" · ")
            }
            tone={greenHits.length > 0 ? "amber" : "neutral"}
          />
          <SignalRow
            label="Monday is federal holiday"
            value={flags?.holidayMonday ? "Yes" : "No"}
            tone={flags?.holidayMonday ? "red" : "neutral"}
          />
          <SignalRow
            label="MSTR earnings blackout (±14d)"
            value={flags?.earningsBlackout ? "Yes" : "No"}
            tone={flags?.earningsBlackout ? "red" : "neutral"}
          />
          <SignalRow
            label="Mixed signal week"
            value={flags?.mixedSignal ? "Yes" : "No"}
            tone={flags?.mixedSignal ? "amber" : "neutral"}
          />
          <SignalRow
            label="Capital action flagged"
            value={flags?.capitalAction ? "Yes" : "No"}
            tone={flags?.capitalAction ? "red" : "neutral"}
          />
          <SignalRow
            label="Prev week NOBUY (pivot setup)"
            value={flags?.prevWeekNobuy ? "Yes" : "No"}
            tone={flags?.prevWeekNobuy ? "green" : "neutral"}
          />
        </div>
      </div>

      {/* ── Recent tweets timeline ── */}
      <div className="bg-bg-card border border-border rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-text-primary">
            Recent @saylor tweets ({data?.tweets.length ?? 0})
          </h3>
          <button
            onClick={() => setManualOpen((v) => !v)}
            className="text-xs text-text-muted hover:text-text-secondary"
          >
            {manualOpen ? "Cancel" : "Paste manually"}
          </button>
        </div>

        {manualOpen && (
          <div className="bg-bg-input border border-border rounded p-3 mb-3 space-y-2">
            <p className="text-xs text-text-muted">
              One tweet per line. Useful when X Syndication is unavailable.
            </p>
            <textarea
              value={manualText}
              onChange={(e) => setManualText(e.target.value)}
              rows={4}
              className="w-full bg-bg-card border border-border rounded p-2 text-xs font-mono text-text-primary"
              placeholder="Big Orange Bag.&#10;Back to work. BTC"
            />
            <button
              onClick={onManualSubmit}
              className="px-3 py-1.5 rounded text-xs bg-accent-blue text-white hover:bg-accent-blue/80"
            >
              Save & classify
            </button>
          </div>
        )}

        <div className="space-y-2 max-h-96 overflow-y-auto">
          {data?.tweets.length === 0 && (
            <div className="text-xs text-text-muted py-4 text-center">
              No tweets yet. Refresh to pull from X Syndication.
            </div>
          )}
          {data?.tweets.map((t) => (
            <TweetRow key={t.id} tweet={t} />
          ))}
        </div>
      </div>

      {/* ── Probability chart ── */}
      <ProbabilityChart points={probabilityPoints} />

      {/* ── Backtest ── */}
      {backtest && (
        <div className="bg-bg-card border border-border rounded-lg p-4">
          <div className="flex items-baseline justify-between">
            <h3 className="text-sm font-medium text-text-primary">
              Baseline backtest — {backtest.strategy}
            </h3>
            <div className="text-xs text-text-muted">
              {backtest.weeksEvaluated} weeks
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4 mt-3">
            <Stat
              label="Win rate"
              value={`${(backtest.winRate * 100).toFixed(1)}%`}
              tone={backtest.winRate >= 0.6 ? "green" : "neutral"}
            />
            <Stat
              label="Avg return / $1"
              value={`${(backtest.totalReturn * 100).toFixed(1)}%`}
              tone={backtest.totalReturn > 0 ? "green" : "red"}
            />
            <Stat
              label="W / L"
              value={`${backtest.wins} / ${backtest.losses}`}
              tone="neutral"
            />
          </div>
          <p className="text-xs text-text-muted mt-3">
            Baseline = always BUY_YES. Strategy E (BUY hint + skip holidays +
            skip blackouts + skip mixed) targets ~87.8% in the report once a
            tweet archive is loaded against historical weeks.
          </p>
        </div>
      )}

      {/* ── Interactive Polymarket × Saylor timeline (embedded ECharts report) ── */}
      <TimelineReport />

      {/* ── 80-week history timeline ── */}
      <div className="bg-bg-card border border-border rounded-lg p-4">
        <h3 className="text-sm font-medium text-text-primary mb-3">
          Historical timeline ({history.length} weeks)
        </h3>
        {history.length === 0 ? (
          <div className="text-xs text-text-muted text-center py-8">
            No history loaded. Click <span className="font-mono">Import history CSV</span>{" "}
            to seed from <span className="font-mono">data/saylor/*.csv</span>.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-text-muted border-b border-border">
                  <th className="text-left py-1.5 px-2">#</th>
                  <th className="text-left py-1.5 px-2">Window</th>
                  <th className="text-left py-1.5 px-2">Outcome</th>
                  <th className="text-right py-1.5 px-2">Open</th>
                  <th className="text-right py-1.5 px-2">Close</th>
                  <th className="text-right py-1.5 px-2">Volume</th>
                  <th className="text-left py-1.5 px-2">Category</th>
                </tr>
              </thead>
              <tbody>
                {history.map((w) => (
                  <tr
                    key={w.weekIdx}
                    className="border-b border-border/40 hover:bg-bg-card-hover"
                  >
                    <td className="py-1 px-2 font-mono text-text-muted">
                      {w.weekIdx}
                    </td>
                    <td className="py-1 px-2 font-mono">
                      {w.startDate} → {w.endDate}
                    </td>
                    <td className="py-1 px-2">
                      <OutcomeBadge outcome={w.outcome} />
                    </td>
                    <td className="py-1 px-2 text-right font-mono">
                      {fmtPrice(w.openPrice)}
                    </td>
                    <td className="py-1 px-2 text-right font-mono">
                      {fmtPrice(w.closePrice)}
                    </td>
                    <td className="py-1 px-2 text-right font-mono text-text-muted">
                      {fmtVol(w.volumeUsd)}
                    </td>
                    <td className="py-1 px-2 text-text-muted">
                      {w.category ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────

function TimelineReport() {
  // Static report lives in /public/mstr-timeline/. Embed via iframe so we
  // don't have to rewrite its 1.4MB ECharts/JSON payload into React.
  // Lazy-load so it doesn't block the rest of the page on first paint.
  const src = "/mstr-timeline/index.html";
  return (
    <div className="bg-bg-card border border-border rounded-lg p-4 space-y-3">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-medium text-text-primary">
            Polymarket × Saylor timeline — full history (78 markets)
          </h3>
          <p className="text-xs text-text-muted mt-1">
            1,414 verified Saylor tweets · ECharts/SVG · filter & zoom to
            minute-level detail. Click <span className="font-mono">Has Saylor signal</span> or{" "}
            <span className="font-mono">Losing BUYs</span> to drill in.
          </p>
        </div>
        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 text-xs text-accent-blue hover:underline font-mono"
        >
          Open in full window →
        </a>
      </div>
      <div className="border border-border rounded overflow-hidden bg-white">
        <iframe
          src={src}
          title="Polymarket × Saylor timeline"
          className="block w-full"
          style={{ height: "900px", border: 0 }}
          loading="lazy"
        />
      </div>
    </div>
  );
}

function SignalRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "green" | "red" | "amber" | "neutral";
}) {
  const toneClass =
    tone === "green"
      ? "text-accent-green"
      : tone === "red"
      ? "text-accent-red"
      : tone === "amber"
      ? "text-accent-amber"
      : "text-text-secondary";
  const dotClass =
    tone === "green"
      ? "bg-accent-green"
      : tone === "red"
      ? "bg-accent-red"
      : tone === "amber"
      ? "bg-accent-amber"
      : "bg-text-muted";
  return (
    <div className="flex items-center justify-between bg-bg-input rounded px-3 py-2">
      <span className="text-text-muted flex items-center gap-2">
        <span className={`inline-block w-2 h-2 rounded-full ${dotClass}`} />
        {label}
      </span>
      <span className={`font-mono ${toneClass}`}>{value}</span>
    </div>
  );
}

function TweetRow({ tweet }: { tweet: SaylorTweet }) {
  const date = new Date(tweet.postedAt);
  return (
    <div className="bg-bg-input border border-border/60 rounded p-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-xs text-text-muted font-mono">
          {date.toLocaleString(undefined, {
            year: "2-digit",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
          {tweet.source === "manual" && (
            <span className="ml-2 px-1.5 py-0.5 rounded bg-bg-card text-text-muted text-[10px]">
              manual
            </span>
          )}
        </div>
        {tweet.url && (
          <a
            href={tweet.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-accent-blue hover:underline"
          >
            view
          </a>
        )}
      </div>
      <div className="text-sm text-text-primary mt-1 whitespace-pre-wrap break-words">
        {tweet.text}
      </div>
    </div>
  );
}

function OutcomeBadge({ outcome }: { outcome: "YES" | "NO" | "OPEN" }) {
  const cls =
    outcome === "YES"
      ? "bg-accent-green-dim text-accent-green"
      : outcome === "NO"
      ? "bg-accent-red-dim text-accent-red"
      : "bg-bg-card text-text-muted";
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider ${cls}`}
    >
      {outcome}
    </span>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "green" | "red" | "neutral";
}) {
  const c =
    tone === "green"
      ? "text-accent-green"
      : tone === "red"
      ? "text-accent-red"
      : "text-text-primary";
  return (
    <div>
      <div className="text-xs text-text-muted">{label}</div>
      <div className={`text-lg font-mono font-semibold ${c}`}>{value}</div>
    </div>
  );
}

function fmtPrice(p: number | null): string {
  if (p == null) return "—";
  return p.toFixed(3);
}

function fmtVol(v: number | null): string {
  if (v == null) return "—";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v}`;
}
