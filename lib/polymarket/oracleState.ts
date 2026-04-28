import type { Opportunity, OracleResolutionState } from "../types";

interface QuestionData {
  requestTimestamp: bigint;
  manualResolutionTimestamp: bigint;
  resolved: boolean;
  paused: boolean;
  reset: boolean;
  ancillaryDataHex: string;
}

interface OptimisticOracleRequest {
  proposer: string;
  disputer: string;
  settled: boolean;
  expirationTime: bigint;
}

export interface OracleStateInspection {
  state: OracleResolutionState;
  details: string;
}

const DEFAULT_POLYGON_RPCS = [
  "https://polygon-bor-rpc.publicnode.com",
  "https://polygon.drpc.org",
  "https://1rpc.io/matic",
];

const GET_QUESTION_SELECTOR = "0x58c039cd";
const READY_SELECTOR = "0xfcac49a2";
const OPTIMISTIC_ORACLE_SELECTOR = "0x22302922";
const GET_REQUEST_SELECTOR = "0xa9904f9b";
const HAS_PRICE_SELECTOR = "0xbc58ccaa";
const YES_OR_NO_IDENTIFIER = "YES_OR_NO_QUERY";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const BIG_ZERO = BigInt(0);
const BIG_ONE = BigInt(1);
const TWO_255 = BIG_ONE << BigInt(255);
const TWO_256 = BIG_ONE << BigInt(256);

function rpcUrls(): string[] {
  const configured = process.env.POLYGON_RPC_URL?.trim();
  return [
    ...(configured ? [configured] : []),
    ...DEFAULT_POLYGON_RPCS,
  ];
}

function isHex(value: string | null | undefined, bytes: number): value is string {
  return (
    typeof value === "string" &&
    new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value)
  );
}

function normalizeAddress(address: string): string {
  return `0x${address.toLowerCase().replace(/^0x/, "")}`;
}

function isZeroAddress(address: string): boolean {
  return normalizeAddress(address) === ZERO_ADDRESS;
}

function wordAt(hex: string, byteOffset: number): string {
  return hex.slice(2 + byteOffset * 2, 2 + byteOffset * 2 + 64);
}

function uintWord(word: string): bigint {
  return BigInt(`0x${word}`);
}

function intWord(word: string): bigint {
  const unsigned = uintWord(word);
  return unsigned >= TWO_255 ? unsigned - TWO_256 : unsigned;
}

function boolWord(word: string): boolean {
  return uintWord(word) !== BIG_ZERO;
}

function addressWord(word: string): string {
  return `0x${word.slice(24)}`;
}

function uintArg(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function addressArg(address: string): string {
  return address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function bytes32Ascii(value: string): string {
  return Buffer.from(value, "utf8").toString("hex").padEnd(64, "0");
}

async function ethCall(to: string, data: string): Promise<string> {
  let lastError: Error | null = null;

  for (const rpc of rpcUrls()) {
    try {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [{ to, data }, "latest"],
        }),
      });
      const json = (await res.json()) as {
        result?: string;
        error?: { message?: string };
      };
      if (json.error || !json.result) {
        throw new Error(json.error?.message ?? "empty eth_call result");
      }
      return json.result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError ?? new Error("all Polygon RPC calls failed");
}

function decodeQuestion(result: string): QuestionData | null {
  if (!result || result === "0x") return null;
  const tupleOffset = Number(uintWord(wordAt(result, 0)));
  const word = (index: number) => wordAt(result, tupleOffset + index * 32);
  const ancillaryOffset = Number(uintWord(word(11)));
  const ancillaryLength = Number(
    uintWord(wordAt(result, tupleOffset + ancillaryOffset))
  );
  const ancillaryData = result.slice(
    2 + (tupleOffset + ancillaryOffset + 32) * 2,
    2 + (tupleOffset + ancillaryOffset + 32 + ancillaryLength) * 2
  );

  if (ancillaryLength === 0) return null;

  return {
    requestTimestamp: uintWord(word(0)),
    manualResolutionTimestamp: uintWord(word(4)),
    resolved: boolWord(word(5)),
    paused: boolWord(word(6)),
    reset: boolWord(word(7)),
    ancillaryDataHex: `0x${ancillaryData}`,
  };
}

function encodeOracleRequestCall(
  selector: string,
  adapter: string,
  requestTimestamp: bigint,
  ancillaryDataHex: string
): string {
  const bytes = ancillaryDataHex.replace(/^0x/, "");
  const byteLength = bytes.length / 2;
  const paddedLength = Math.ceil(byteLength / 32) * 64;
  const paddedBytes = bytes.padEnd(paddedLength, "0");

  return [
    selector,
    addressArg(adapter),
    bytes32Ascii(YES_OR_NO_IDENTIFIER),
    uintArg(requestTimestamp),
    uintArg(BigInt(128)),
    uintArg(BigInt(byteLength)),
    paddedBytes,
  ].join("");
}

function decodeRequest(result: string): OptimisticOracleRequest {
  const word = (index: number) => wordAt(result, index * 32);
  // Read proposed/resolved prices even though classification currently only
  // needs existence fields; this catches malformed return data early.
  intWord(word(11));
  intWord(word(12));
  return {
    proposer: addressWord(word(0)),
    disputer: addressWord(word(1)),
    settled: boolWord(word(3)),
    expirationTime: uintWord(word(13)),
  };
}

function classifyOracleState(
  question: QuestionData,
  request: OptimisticOracleRequest,
  ready: boolean,
  hasPrice: boolean
): OracleStateInspection {
  const proposerActive = !isZeroAddress(request.proposer);
  const disputerActive = !isZeroAddress(request.disputer);

  if (question.resolved || request.settled) {
    return { state: "resolved", details: "adapter/request is already settled" };
  }
  if (question.paused || question.manualResolutionTimestamp > BIG_ZERO) {
    return {
      state: "manual_review",
      details: "adapter question is paused or flagged for manual resolution",
    };
  }
  if (ready || hasPrice) {
    return {
      state: "ready",
      details: "UMA price is available; market can be resolved by a caller",
    };
  }
  if (question.reset && disputerActive) {
    return {
      state: "second_dispute",
      details: "post-reset request is disputed again; likely waiting on UMA/DVM",
    };
  }
  if (question.reset && !proposerActive && !disputerActive) {
    return {
      state: "reset_stalled",
      details:
        "first dispute reset the adapter question, but the current UMA request has no active proposal and no price",
    };
  }
  if (proposerActive && !disputerActive) {
    return {
      state: "active_proposal",
    details: request.expirationTime > BIG_ZERO
        ? "UMA proposal is live and waiting for liveness to expire"
        : "UMA proposal is live",
    };
  }
  return {
    state: "requested",
    details: "UMA request exists, but no active proposal or price is available",
  };
}

async function inspectOracleResolutionState(
  adapter: string,
  questionID: string
): Promise<OracleStateInspection | null> {
  if (!isHex(adapter, 20) || !isHex(questionID, 32)) return null;

  try {
    const questionResult = await ethCall(
      adapter,
      `${GET_QUESTION_SELECTOR}${questionID.slice(2)}`
    );
    const question = decodeQuestion(questionResult);
    if (!question) return null;

    const optimisticOracle = addressWord(
      (await ethCall(adapter, OPTIMISTIC_ORACLE_SELECTOR)).slice(-64)
    );
    const ready = boolWord(
      (await ethCall(adapter, `${READY_SELECTOR}${questionID.slice(2)}`)).slice(
        -64
      )
    );
    const requestCall = encodeOracleRequestCall(
      GET_REQUEST_SELECTOR,
      adapter,
      question.requestTimestamp,
      question.ancillaryDataHex
    );
    const hasPriceCall = encodeOracleRequestCall(
      HAS_PRICE_SELECTOR,
      adapter,
      question.requestTimestamp,
      question.ancillaryDataHex
    );
    const [requestResult, hasPriceResult] = await Promise.all([
      ethCall(optimisticOracle, requestCall),
      ethCall(optimisticOracle, hasPriceCall),
    ]);

    return classifyOracleState(
      question,
      decodeRequest(requestResult),
      ready,
      boolWord(hasPriceResult.slice(-64))
    );
  } catch {
    return {
      state: "unknown",
      details: "could not inspect UMA adapter state from public Polygon RPC",
    };
  }
}

export async function inspectOracleResolutionStates(
  opportunities: Opportunity[],
  concurrency = 4
): Promise<Map<string, OracleStateInspection>> {
  const unique = new Map<string, { adapter: string; questionID: string }>();
  for (const opp of opportunities) {
    if (!isHex(opp.resolvedBy, 20) || !isHex(opp.questionID, 32)) continue;
    unique.set(`${opp.resolvedBy.toLowerCase()}:${opp.questionID}`, {
      adapter: opp.resolvedBy,
      questionID: opp.questionID,
    });
  }

  const entries = [...unique.entries()];
  const result = new Map<string, OracleStateInspection>();

  for (let i = 0; i < entries.length; i += concurrency) {
    const batch = entries.slice(i, i + concurrency);
    const inspected = await Promise.all(
      batch.map(async ([key, input]) => ({
        key,
        state: await inspectOracleResolutionState(input.adapter, input.questionID),
      }))
    );
    for (const { key, state } of inspected) {
      if (state) result.set(key, state);
    }
  }

  return result;
}
