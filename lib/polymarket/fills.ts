import type { OrderBook, FillResult } from "../types";

/**
 * Walk the asks of an order book to fill a USD amount.
 *
 * - Asks are sorted low→high; we eat the cheapest first.
 * - If the top-of-book size × price is less than remaining USD, we keep walking
 *   upward to the next level until the amount is filled or the book is drained.
 * - If the book can't absorb the full amount, `remainingUsd` > 0 tells the caller.
 */
export function fillOrder(book: OrderBook, usdAmount: number): FillResult {
  const asks = (book.asks ?? [])
    .map((a) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
    .filter((a) => a.price > 0 && a.size > 0 && a.price <= 1)
    .sort((a, b) => a.price - b.price);

  const fills: FillResult["fills"] = [];
  let remaining = usdAmount;
  let totalShares = 0;
  let totalCost = 0;

  for (const ask of asks) {
    if (remaining <= 0) break;
    const levelCost = ask.price * ask.size;
    if (remaining >= levelCost) {
      // Consume entire level
      fills.push({ price: ask.price, size: ask.size, cost: levelCost });
      totalShares += ask.size;
      totalCost += levelCost;
      remaining -= levelCost;
    } else {
      // Partially consume this level
      const partialShares = remaining / ask.price;
      fills.push({ price: ask.price, size: partialShares, cost: remaining });
      totalShares += partialShares;
      totalCost += remaining;
      remaining = 0;
    }
  }

  return {
    shares: totalShares,
    avgFillPrice: totalShares > 0 ? totalCost / totalShares : 0,
    worstFillPrice: fills.length > 0 ? fills[fills.length - 1].price : 0,
    fills,
    remainingUsd: remaining,
  };
}
