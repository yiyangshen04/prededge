/**
 * Minimal pure-TS keccak256 (the pre-NIST Keccak padding Ethereum uses — NOT
 * SHA3-256, whose domain byte differs). Exists so chain-watch can derive a
 * CTF conditionId from (adapter, questionID) without pulling ethers/viem into
 * a repo that otherwise has no chain SDK. BigInt lanes: ~µs per call on the
 * 84-byte conditionId input, speed is irrelevant here.
 *
 * conditionId = keccak256(oracle ‖ questionId ‖ uint256(outcomeSlotCount)) —
 * ConditionalTokens.getConditionId with the UMA CTF adapter as oracle and
 * outcomeSlotCount=2. Validated against 2,508 known (adapter,qid)→conditionId
 * pairs from the 2026-07 backtest mapping (95% Gamma hit rate).
 */

const MASK64 = (1n << 64n) - 1n;

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

// Rotation offsets, flat-indexed as x + 5y.
const RHO = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];

function rotl(x: bigint, n: number): bigint {
  if (n === 0) return x;
  const bn = BigInt(n);
  return ((x << bn) | (x >> (64n - bn))) & MASK64;
}

function keccakF(A: bigint[]): void {
  for (let round = 0; round < 24; round += 1) {
    // θ
    const C = [
      A[0] ^ A[5] ^ A[10] ^ A[15] ^ A[20],
      A[1] ^ A[6] ^ A[11] ^ A[16] ^ A[21],
      A[2] ^ A[7] ^ A[12] ^ A[17] ^ A[22],
      A[3] ^ A[8] ^ A[13] ^ A[18] ^ A[23],
      A[4] ^ A[9] ^ A[14] ^ A[19] ^ A[24],
    ];
    for (let x = 0; x < 5; x += 1) {
      const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) A[x + y] ^= D;
    }
    // ρ + π
    const B = new Array<bigint>(25);
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], RHO[x + 5 * y]);
      }
    }
    // χ
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x += 1) {
        A[x + y] = B[x + y] ^ (~B[((x + 1) % 5) + y] & MASK64 & B[((x + 2) % 5) + y]);
      }
    }
    // ι
    A[0] ^= RC[round];
  }
}

export function keccak256(data: Uint8Array): Uint8Array {
  const RATE = 136; // 1088-bit rate for the 256-bit variant
  // Keccak pad10*1: append 0x01, zero-fill, last byte |= 0x80.
  const padded = new Uint8Array(Math.ceil((data.length + 1) / RATE) * RATE);
  padded.set(data);
  padded[data.length] = 0x01;
  padded[padded.length - 1] |= 0x80;

  const state = new Array<bigint>(25).fill(0n);
  for (let block = 0; block < padded.length; block += RATE) {
    for (let lane = 0; lane < RATE / 8; lane += 1) {
      let v = 0n;
      for (let b = 7; b >= 0; b -= 1) {
        v = (v << 8n) | BigInt(padded[block + lane * 8 + b]); // little-endian lanes
      }
      state[lane] ^= v;
    }
    keccakF(state);
  }

  const out = new Uint8Array(32);
  for (let lane = 0; lane < 4; lane += 1) {
    let v = state[lane];
    for (let b = 0; b < 8; b += 1) {
      out[lane * 8 + b] = Number(v & 0xffn);
      v >>= 8n;
    }
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "0x";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** CTF conditionId for a binary market resolved by `adapter` on `questionId`. */
export function conditionIdFor(adapter: string, questionId: string): string {
  const packed = new Uint8Array(20 + 32 + 32);
  packed.set(hexToBytes(adapter), 0);
  packed.set(hexToBytes(questionId), 20);
  packed[83] = 2; // uint256(2), big-endian
  return bytesToHex(keccak256(packed));
}
