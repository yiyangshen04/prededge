import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "MSTR Weekly BTC Strategy Analysis — PredEdge",
  description:
    "Polymarket × Saylor strict-signal strategy backtest review + 2026-05-12 live verification",
};

type StrategyRow = {
  code: string;
  desc: string;
  trades: string;
  winRate: string;
  expected: string;
  highlight?: "star" | "user" | "hybrid";
};

const strategies: StrategyRow[] = [
  { code: "F", desc: "All-YES baseline (ignore signals)", trades: "78", winRate: "79.5%", expected: "+11.5%" },
  { code: "A", desc: "Buy YES on any BUY hint", trades: "50", winRate: "80.0%", expected: "+11.9%" },
  { code: "B", desc: "BUY + skip holiday weeks", trades: "40", winRate: "85.0%", expected: "+16.7%" },
  { code: "C", desc: "Buy NO on any NOBUY hint", trades: "14", winRate: "57.1%", expected: "+24.9%" },
  { code: "D", desc: "Combo (NOBUY→NO, BUY+non-holiday→YES)", trades: "48", winRate: "81.2%", expected: "+23.8%" },
  {
    code: "E ★",
    desc: "Strict combo (also skip mixed-signal weeks)",
    trades: "41",
    winRate: "87.8%",
    expected: "+25.6%",
    highlight: "star",
  },
  {
    code: "G",
    desc: "Calendar-only filter + all YES (ignore Saylor)",
    trades: "~56",
    winRate: "~90%",
    expected: "~+15%",
    highlight: "user",
  },
  {
    code: "H ✦",
    desc: "Hybrid: G base + selective NO on pure NOBUY",
    trades: "~62",
    winRate: "~88%",
    expected: "~+22%",
    highlight: "hybrid",
  },
];

const failureTypes = [
  {
    title: "Type A · False BUY during earnings blackout",
    count: "2 cases",
    pct: "33%",
    tone: "amber" as const,
    mechanism:
      "Saylor's personal tweets are not bound by MNPI rules, but the company's 8-K filings are. He keeps posting orange dots during the quiet period, but ATM financing pauses → no actual purchase.",
    examples: [
      {
        week: "2025-03-31 → 04-07",
        signal: '3/30 "Needs even more Orange"',
        why: "4 weeks before Q1 2025 earnings on 5/1; entered quiet period",
      },
      {
        week: "2025-07-21 → 07-29",
        signal: '7/22 "72 orange dots. $72 billion."',
        why: "Pre-Q2 2025 earnings on 7/31 + the number was retrospective, not forward-looking",
      },
    ],
    fix: 'Strictly skip any BUY signal within 4 weeks of earnings',
  },
  {
    title: "Type B · Lure BUY before a capital event",
    count: "1 case",
    pct: "17%",
    tone: "amber" as const,
    mechanism:
      "Saylor hypes a BUY before a major financing/ATM announcement, but the new ATM needs paperwork first → actual purchase delayed 1-2 weeks.",
    examples: [
      {
        week: "2026-03-23 → 03-31",
        signal: '3/22 "The Orange March Continues"',
        why: "Same day 3/23 announced the $42B ATM restructuring; 13-week buying streak broke",
      },
    ],
    fix: 'Monitor 8-K/S-3 filings; add a "recent ATM/financing announcement → skip" filter',
  },
  {
    title: "Type C · NOBUY misalignment / next-week reversal",
    count: "3 cases (incl. #80)",
    pct: "50%",
    tone: "red" as const,
    mechanism:
      "The NOBUY tweet's time window doesn't match the PM market title, or Saylor pauses one week and resumes the next.",
    examples: [
      {
        week: "2025-02-04 → 02-10",
        signal: '2/3 "Last week MSTR did not purchase..."',
        why: "Tweet refers to the prior week, but got captured by PM #13 current-week window → MSTR did buy that week",
      },
      {
        week: "2025-11-24 → 12-02",
        signal: '11/22 "Did you HODL this week?"',
        why: "Next week posted a GREEN dot → PM resolved YES",
      },
      {
        week: "2026-05-04 → 05-12",
        signal: '5/3 "No buys this week. Back to work next week."',
        why: "NOBUY tweet embeds next-week resume notice + Q1 quiet period ended → 5/11 bought 535 BTC",
      },
    ],
    fix:
      'If a NOBUY tweet also contains "next week" / "back to work" / "next purchase", skip rather than betting NO',
  },
];

const noWeeksCalendar = [
  { range: "2025-01-13 → 01-20", reason: "Inauguration Day", predictable: true },
  { range: "2025-01-28 → 02-03", reason: "Pre-Q4'24 earnings (2/5)", predictable: true },
  { range: "2025-02-04 → 02-05", reason: "Q4'24 earnings week", predictable: true },
  { range: "2025-02-10 → 02-17", reason: "Post-earnings + Strategy rebrand", predictable: true },
  { range: "2025-02-24 → 03-03", reason: "Pure Saylor NOBUY", predictable: false },
  { range: "2025-03-03 → 03-10", reason: "Pure Saylor NOBUY", predictable: false },
  { range: "2025-03-31 → 04-07", reason: "Pre-Q1'25 earnings (5/1)", predictable: true },
  { range: "2025-06-30 → 07-07", reason: "4 weeks before Q2'25 earnings (7/31)", predictable: true },
  { range: "2025-07-21 → 07-29", reason: "1 week before Q2'25 earnings (7/31)", predictable: true },
  { range: "2025-08-25 → 09-02", reason: "Labor Day 9/1 settlement misalign", predictable: true },
  { range: "2025-09-29 → 10-07", reason: "Mixed signal", predictable: false },
  { range: "2025-11-17 → 11-25", reason: "Mixed signal", predictable: false },
  { range: "2025-12-15 → 12-23", reason: "Mixed signal", predictable: false },
  { range: "2026-01-12 → 01-20", reason: "MLK Day 1/19", predictable: true },
  { range: "2026-02-09 → 02-17", reason: "Presidents Day 2/16", predictable: true },
  { range: "2026-03-23 → 03-31", reason: "$42B ATM announcement day", predictable: true },
];

const sources = [
  {
    title: "Strategy buys 535 BTC for $43M (CoinDesk, 5/11)",
    url: "https://www.coindesk.com/markets/2026/05/11/strategy-buys-535-bitcoin-for-usd43-million-days-after-signaling-potential-btc-sales",
  },
  {
    title: 'Saylor "Back to Work" Signal (Bitcoin News, 5/10)',
    url: "https://news.bitcoin.com/saylor-posts-back-to-work-signal-as-strategy-eyes-more-bitcoin-after-one-week-pause/",
  },
  {
    title: "Strategy weighs selling BTC to fund dividends (CoinDesk, 5/5)",
    url: "https://www.coindesk.com/business/2026/05/05/michael-saylor-s-strategy-signals-potential-bitcoin-sale-to-fund-dividends-obligations",
  },
  {
    title: "Saylor: remarks intended to jam short-sellers (Fortune, 5/8)",
    url: "https://fortune.com/2026/05/08/michael-saylor-mstr-strategy-microstrategy-bitcoin-sales-short-sellers-haters/",
  },
  {
    title: "Strategy Q1 2026 Earnings Transcript (Motley Fool, 5/5)",
    url: "https://www.fool.com/earnings/call-transcripts/2026/05/05/strategy-mstr-q1-2026-earnings-transcript/",
  },
  {
    title: "Strategy $42B ATM Program (Strategy.com, 3/23)",
    url: "https://www.strategy.com/press/strategy-announces-21-billion-strc-atm-program-and-21-billion-mstr-atm-program_03-23-2026",
  },
  {
    title: "Polymarket MicroStrategy markets",
    url: "https://polymarket.com/crypto/microstrategy",
  },
];

export default function MstrReportPage() {
  return (
    <div className="max-w-6xl mx-auto px-6 py-6 space-y-8">
      <Header />
      <RegimeChangeBanner />
      <Section
        title="1. Strategy Win-Rate Comparison"
        subtitle="Original 6 strategies + newly added G and Hybrid estimates"
      >
        <StrategyTable />
      </Section>
      <Section
        title="2. Live Verification — Weeks #79 & #80"
        subtitle="Both were OPEN when the original report was generated on 5/5; now resolved"
      >
        <RecentWeeksVerification />
      </Section>
      <Section
        title="3. Strategy E Failure Mechanism Breakdown"
        subtitle="5 documented losses + 1 new (#80), grouped into 3 failure types"
      >
        <FailureBreakdown />
      </Section>
      <Section
        title="4. Strategy G — Calendar-only filter (ignore Saylor)"
        subtitle="Rule: skip earnings quiet periods, federal holidays, capital events; otherwise always buy YES"
      >
        <StrategyGBreakdown />
      </Section>
      <Section
        title="5. Recommended Hybrid"
        subtitle="G as the base + selective reverse NO bets on pure NOBUY signals"
      >
        <HybridRecommendation />
      </Section>
      <Section title="6. Risk Notes" subtitle="As of 2026-05-12">
        <Risks />
      </Section>
      <Sources />
    </div>
  );
}

function Header() {
  return (
    <div className="space-y-1">
      <h1 className="text-2xl font-semibold text-text-primary">
        MSTR Weekly BTC Strategy Analysis
      </h1>
      <p className="text-sm text-text-muted">
        Polymarket × Saylor strict-signal strategies — backtest review &amp; live verification
      </p>
      <div className="flex flex-wrap gap-2 pt-2">
        <Pill label="Original report" value="2026-05-05" />
        <Pill label="Page last verified" value="2026-05-12" tone="blue" />
        <Pill label="Sample range" value="80 weeks (2024-11 → 2026-05)" />
        <Pill label="Resolved" value="78 (62 YES / 16 NO)" />
      </div>
    </div>
  );
}

function Pill({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "blue" | "amber" | "red";
}) {
  const toneClass =
    tone === "blue"
      ? "border-accent-blue/40 text-accent-blue bg-accent-blue/10"
      : tone === "amber"
        ? "border-accent-amber/40 text-accent-amber bg-accent-amber/10"
        : tone === "red"
          ? "border-accent-red/40 text-accent-red bg-accent-red/10"
          : "border-border text-text-secondary bg-bg-card";
  return (
    <span
      className={`text-[11px] font-mono px-2 py-1 rounded border ${toneClass}`}
    >
      <span className="text-text-muted mr-1">{label}</span>
      {value}
    </span>
  );
}

function RegimeChangeBanner() {
  return (
    <div className="border border-accent-amber/40 bg-accent-amber/10 rounded-lg p-4 space-y-2">
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-mono uppercase tracking-wider text-accent-amber">
          Regime Change Warning
        </span>
        <span className="text-xs text-text-muted">2026-05-05</span>
      </div>
      <p className="text-sm text-text-primary leading-relaxed">
        On the Q1 2026 earnings call, Saylor for the first time broke the &quot;never sell&quot; vow:
        <em className="text-accent-amber not-italic">
          {' "We will probably sell some bitcoin to pay a dividend just to inoculate the market." '}
        </em>
        STRC&apos;s 11.5% preferred dividend implies ~$1.5B/year in cash obligations, introducing a new
        <strong> tactical sell</strong> signal type that the original BUY/NOBUY dichotomy does not capture.
        Saylor walked it back in Fortune on 5/8 (&quot;just to jam short-sellers&quot;), tweeted
        &quot;Back to work. BTC&quot; on 5/10, and the 5/11 8-K confirmed a 535 BTC ($43M) purchase.
        Polymarket has spun up a &quot;Will Strategy sell BTC in 2026?&quot; market, currently 82% YES.
      </p>
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold text-text-primary">{title}</h2>
        {subtitle && (
          <p className="text-xs text-text-muted mt-0.5">{subtitle}</p>
        )}
      </div>
      {children}
    </section>
  );
}

function StrategyTable() {
  return (
    <div className="overflow-x-auto border border-border rounded-lg">
      <table className="w-full text-sm">
        <thead className="bg-bg-card">
          <tr className="text-left text-text-muted">
            <th className="px-3 py-2 font-medium text-xs uppercase tracking-wider w-24">
              Strategy
            </th>
            <th className="px-3 py-2 font-medium text-xs uppercase tracking-wider">
              Description
            </th>
            <th className="px-3 py-2 font-medium text-xs uppercase tracking-wider text-right">
              Trades
            </th>
            <th className="px-3 py-2 font-medium text-xs uppercase tracking-wider text-right">
              Win rate
            </th>
            <th className="px-3 py-2 font-medium text-xs uppercase tracking-wider text-right">
              EV / $1
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {strategies.map((s) => {
            const rowClass =
              s.highlight === "star"
                ? "bg-accent-amber/5"
                : s.highlight === "user"
                  ? "bg-accent-blue/5"
                  : s.highlight === "hybrid"
                    ? "bg-accent-green/5"
                    : "";
            const codeColor =
              s.highlight === "star"
                ? "text-accent-amber"
                : s.highlight === "user"
                  ? "text-accent-blue"
                  : s.highlight === "hybrid"
                    ? "text-accent-green"
                    : "text-text-primary";
            return (
              <tr key={s.code} className={rowClass}>
                <td className={`px-3 py-2 font-mono font-semibold ${codeColor}`}>
                  {s.code}
                </td>
                <td className="px-3 py-2 text-text-primary">{s.desc}</td>
                <td className="px-3 py-2 text-right font-mono text-text-secondary">
                  {s.trades}
                </td>
                <td className="px-3 py-2 text-right font-mono text-text-primary">
                  {s.winRate}
                </td>
                <td className="px-3 py-2 text-right font-mono text-accent-green">
                  {s.expected}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="px-3 py-2 bg-bg-card border-t border-border text-[11px] text-text-muted space-y-0.5">
        <div>
          <span className="text-accent-amber">★</span> Original-report best ·
          <span className="text-accent-blue ml-2">blue</span> Our calendar-only variant (G) ·
          <span className="text-accent-green ml-2">✦</span> Recommended hybrid (H)
        </div>
        <div>
          G &amp; H numbers are projected from the 16-NO-week classification, not a strict backtest —
          rerun against the raw PM price series to calibrate.
        </div>
      </div>
    </div>
  );
}

function RecentWeeksVerification() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <WeekCard
        weekNo="#79"
        range="2026-04-27 → 05-05"
        outcome="NO"
        outcomeColor="red"
        signals={[
          { type: "BUY", date: "Fri 4/24", text: '"The Future is Orange"' },
          { type: "NOBUY", date: "Sun 5/3", text: '"No buys this week. Back to work next week."' },
        ]}
        eDecision="Skip (mixed signal)"
        eResult="✅ Correct skip"
        eResultColor="green"
        explanation="Pre-Q1 2026 earnings quiet period (5/5); no purchase that week."
      />
      <WeekCard
        weekNo="#80"
        range="2026-05-04 → 05-12"
        outcome="YES"
        outcomeColor="green"
        signals={[
          {
            type: "NOBUY",
            date: "Sun 5/3",
            text: '"No buys this week. Back to work next week."',
          },
          { type: "BUY", date: "Sun 5/10", text: '"Back to work. BTC"' },
        ]}
        eDecision="Bet NO"
        eResult="❌ Loss"
        eResultColor="red"
        explanation="5/11 8-K disclosed 535 BTC ($43M). The NOBUY tweet embedded a next-week resume notice — Strategy E&apos;s known Type-C gap."
      />
    </div>
  );
}

function WeekCard({
  weekNo,
  range,
  outcome,
  outcomeColor,
  signals,
  eDecision,
  eResult,
  eResultColor,
  explanation,
}: {
  weekNo: string;
  range: string;
  outcome: string;
  outcomeColor: "green" | "red";
  signals: Array<{ type: "BUY" | "NOBUY"; date: string; text: string }>;
  eDecision: string;
  eResult: string;
  eResultColor: "green" | "red";
  explanation: string;
}) {
  const outcomeClass =
    outcomeColor === "green"
      ? "border-accent-green/40 bg-accent-green/10 text-accent-green"
      : "border-accent-red/40 bg-accent-red/10 text-accent-red";
  const eResultClass =
    eResultColor === "green" ? "text-accent-green" : "text-accent-red";

  return (
    <div className="border border-border bg-bg-card rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-mono font-semibold text-text-primary">
            {weekNo}
          </div>
          <div className="text-xs text-text-muted">{range}</div>
        </div>
        <span
          className={`text-xs font-mono font-semibold px-2 py-1 rounded border ${outcomeClass}`}
        >
          Actual {outcome}
        </span>
      </div>
      <div className="space-y-1">
        {signals.map((sig, i) => (
          <div key={i} className="text-xs flex items-baseline gap-2">
            <span
              className={`font-mono font-semibold ${
                sig.type === "BUY" ? "text-accent-green" : "text-accent-red"
              }`}
            >
              {sig.type}
            </span>
            <span className="text-text-muted font-mono">{sig.date}</span>
            <span className="text-text-secondary">{sig.text}</span>
          </div>
        ))}
      </div>
      <div className="text-xs border-t border-border pt-2 flex items-center justify-between">
        <span className="text-text-muted">Strategy E: {eDecision}</span>
        <span className={`font-mono ${eResultClass}`}>{eResult}</span>
      </div>
      <p className="text-xs text-text-secondary leading-relaxed">
        {explanation}
      </p>
    </div>
  );
}

function FailureBreakdown() {
  return (
    <div className="space-y-3">
      {failureTypes.map((t) => (
        <div
          key={t.title}
          className={`border rounded-lg p-4 space-y-3 ${
            t.tone === "red"
              ? "border-accent-red/30 bg-accent-red/5"
              : "border-accent-amber/30 bg-accent-amber/5"
          }`}
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-text-primary">
              {t.title}
            </h3>
            <span className="text-xs font-mono text-text-muted">
              {t.count} · {t.pct}
            </span>
          </div>
          <p className="text-xs text-text-secondary leading-relaxed">
            {t.mechanism}
          </p>
          <div className="space-y-1.5">
            {t.examples.map((ex, i) => (
              <div
                key={i}
                className="text-xs bg-bg-card border border-border rounded px-2 py-1.5"
              >
                <div className="font-mono text-text-primary">{ex.week}</div>
                <div className="text-text-secondary">
                  <span className="text-text-muted">Signal: </span>
                  {ex.signal}
                </div>
                <div className="text-text-secondary">
                  <span className="text-text-muted">Cause: </span>
                  {ex.why}
                </div>
              </div>
            ))}
          </div>
          <div className="text-xs flex items-baseline gap-2">
            <span className="text-text-muted font-mono uppercase tracking-wider">
              Fix
            </span>
            <span className="text-accent-blue">{t.fix}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function StrategyGBreakdown() {
  const predictable = noWeeksCalendar.filter((w) => w.predictable);
  const notPredictable = noWeeksCalendar.filter((w) => !w.predictable);

  return (
    <div className="space-y-4">
      <div className="border border-border bg-bg-card rounded-lg p-4">
        <h3 className="text-sm font-semibold text-text-primary mb-2">
          Rules
        </h3>
        <ol className="text-xs text-text-secondary leading-relaxed space-y-1 list-decimal list-inside">
          <li>Default: buy YES every week</li>
          <li>Skip weeks containing a US federal-holiday Monday (MLK / Presidents / Memorial / Labor / Inauguration / Columbus)</li>
          <li>Skip the 2-4 week quiet period before each MSTR earnings release</li>
          <li>Skip weeks that include an announced ATM / S-3 / capital event</li>
          <li>Completely ignore Saylor&apos;s tweet hints</li>
        </ol>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="border border-accent-green/30 bg-accent-green/5 rounded-lg p-3">
          <div className="text-xs font-mono uppercase tracking-wider text-accent-green mb-2">
            Calendar-predictable · {predictable.length} weeks
          </div>
          <ul className="text-xs text-text-secondary space-y-1">
            {predictable.map((w) => (
              <li key={w.range} className="flex justify-between gap-2">
                <span className="font-mono">{w.range}</span>
                <span className="text-text-muted">{w.reason}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="border border-accent-red/30 bg-accent-red/5 rounded-lg p-3">
          <div className="text-xs font-mono uppercase tracking-wider text-accent-red mb-2">
            Unpredictable · {notPredictable.length} weeks (these will lose)
          </div>
          <ul className="text-xs text-text-secondary space-y-1">
            {notPredictable.map((w) => (
              <li key={w.range} className="flex justify-between gap-2">
                <span className="font-mono">{w.range}</span>
                <span className="text-text-muted">{w.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <MetricCard label="Trades" value="~56" />
        <MetricCard label="Win rate" value="~90%" tone="green" />
        <MetricCard label="Losses" value="~6" />
        <MetricCard label="EV / $1" value="~+15%" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
        <div className="border border-accent-green/30 bg-accent-green/5 rounded-lg p-3 space-y-1">
          <div className="font-mono uppercase tracking-wider text-accent-green">
            Pros
          </div>
          <ul className="list-disc list-inside text-text-secondary space-y-1">
            <li>Win rate edges out E (~90% vs 87.8%)</li>
            <li>Larger sample (~56 vs 41), lower statistical noise</li>
            <li>Trivial rules, fully automatable</li>
            <li>No reliance on Saylor&apos;s dictionary → resilient to the 5/5 tactical-sell shift</li>
          </ul>
        </div>
        <div className="border border-accent-amber/30 bg-accent-amber/5 rounded-lg p-3 space-y-1">
          <div className="font-mono uppercase tracking-wider text-accent-amber">
            Cons
          </div>
          <ul className="list-disc list-inside text-text-secondary space-y-1">
            <li>EV/$1 well below E (~+15% vs +25.6%)</li>
            <li>No reverse NO bets (E&apos;s main EV engine)</li>
            <li>Doesn&apos;t skip mixed-signal high-price weeks (YES open 0.85+ pays little)</li>
            <li>Still loses 5-6 YES weeks that Saylor&apos;s NOBUY would have caught</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "green";
}) {
  const valueClass =
    tone === "green" ? "text-accent-green" : "text-text-primary";
  return (
    <div className="border border-border bg-bg-card rounded-lg p-3">
      <div className="text-[10px] text-text-muted uppercase tracking-wider">
        {label}
      </div>
      <div className={`text-lg font-mono font-semibold mt-0.5 ${valueClass}`}>
        {value}
      </div>
    </div>
  );
}

function HybridRecommendation() {
  return (
    <div className="border border-accent-green/40 bg-accent-green/5 rounded-lg p-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-accent-green text-lg">✦</span>
        <h3 className="text-sm font-semibold text-text-primary">
          Recommended Hybrid (H) — G base + selective NO
        </h3>
      </div>
      <p className="text-sm text-text-secondary leading-relaxed">
        Use Strategy G as the base (steady weekly YES with calendar filtering), and overlay a NO bet
        <strong className="text-accent-green"> only when Saylor posts a clean NOBUY signal with no next-week transition phrase</strong>.
        That keeps G&apos;s high-win-rate core while capturing E&apos;s high-EV reverse NO leg,
        avoiding the brittle BUY dictionary parsing and the NOBUY-reversal trap.
      </p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <MetricCard label="Trades" value="~62" />
        <MetricCard label="Win rate" value="~88%" tone="green" />
        <MetricCard label="EV / $1" value="~+22%" tone="green" />
        <MetricCard label="Rules" value="4" />
      </div>
      <div className="text-xs text-text-secondary border-t border-accent-green/20 pt-3 space-y-1">
        <div className="font-mono uppercase tracking-wider text-text-muted">
          The four rules
        </div>
        <ol className="list-decimal list-inside space-y-0.5">
          <li>Base: buy YES every week, position size ≤ $5K</li>
          <li>Skip if the week contains a Monday holiday, the 2-4 weeks before earnings, or an announced capital event</li>
          <li>
            Bet NO additionally only when Saylor tweets &quot;No buys&quot; / &quot;HODL&quot; etc.,
            <strong className="text-accent-red"> and does NOT</strong> include &quot;next week&quot; / &quot;back to work&quot; / &quot;next purchase&quot;
          </li>
          <li>Close YES on Mon 8 AM ET tracker + 8-K release when YES locks at 1.0; close NO mid-week once no announcement is confirmed and NO locks at 0</li>
        </ol>
      </div>
    </div>
  );
}

function Risks() {
  const risks = [
    {
      title: "Sample size",
      text: "Strategy E has only 41 trades; G's projection rests on a 16-NO-week classification. Run at 1/3 size for 4-8 weeks before scaling to target.",
    },
    {
      title: "New regime: tactical sell",
      text: "After Q1 2026 Saylor may run another double-edged narrative. Q2 earnings is imminent (late July/early August) — reduce exposure 3-4 weeks ahead.",
    },
    {
      title: "Polymarket regulatory / liquidity",
      text: "Weekly PM volume is $50K-$2M; large orders move the price. Cap individual bets at ≤ $5K. USDC on/off-ramp has compliance risk.",
    },
    {
      title: "Signal dictionary drift",
      text: 'The original report does not contain "Back to work" / "Unstoppable Orange" / "Orange Century" etc. — keep the vocabulary updated.',
    },
    {
      title: "Black swans",
      text: "MSTR could halt buying due to a frozen capital market, regulatory change, or Saylor's personal situation. Historical precedent: 2026-03-23 $42B ATM restructuring.",
    },
  ];
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {risks.map((r, i) => (
        <div
          key={i}
          className="border border-border bg-bg-card rounded-lg p-3 space-y-1"
        >
          <div className="text-xs font-mono uppercase tracking-wider text-accent-amber">
            {r.title}
          </div>
          <p className="text-xs text-text-secondary leading-relaxed">
            {r.text}
          </p>
        </div>
      ))}
    </div>
  );
}

function Sources() {
  return (
    <section className="space-y-2 border-t border-border pt-6">
      <h2 className="text-xs font-mono uppercase tracking-wider text-text-muted">
        Sources
      </h2>
      <ul className="text-xs space-y-1">
        {sources.map((s) => (
          <li key={s.url}>
            <a
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent-blue hover:underline"
            >
              {s.title} →
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
