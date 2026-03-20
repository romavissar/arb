import { config } from "../config.js";
import { TokenBucket } from "../core/rateLimit.js";
import type { PolymarketMarket, NormalizedMarket } from "../types/index.js";
import { createChecksum, createStructureChecksum } from "../core/checksums.js";
import { appendError } from "../core/logging.js";
import { scanLog } from "../core/scanLog.js";

// Use Gamma API — supports active/closed filters, unlike CLOB which paginates from oldest
const BASE_URL = "https://gamma-api.polymarket.com";
const bucket = new TokenBucket(config.polymarketBucketMax, config.polymarketBucketRefillRps);

let polyHttp429 = 0;
let polyBytesIn = 0;

export function resetPolymarketFetchStats(): void {
  polyHttp429 = 0;
  polyBytesIn = 0;
}

export function getPolymarketFetchStats(): { http429: number; bytesIn: number } {
  return { http429: polyHttp429, bytesIn: polyBytesIn };
}

function recordPolyBody(body: unknown): void {
  try {
    polyBytesIn += JSON.stringify(body).length;
  } catch {
    // ignore
  }
}

interface GammaMarket {
  id: string;
  question: string;
  conditionId: string;
  outcomes: string;        // JSON string: '["Yes", "No"]'
  outcomePrices: string;   // JSON string: '["0.55", "0.45"]'
  volume: string;
  volumeNum: number;
  endDate: string;
  active: boolean;
  closed: boolean;
}

function parseGammaMarket(raw: GammaMarket): PolymarketMarket | null {
  let outcomes: string[];
  let prices: string[];
  try {
    outcomes = JSON.parse(raw.outcomes ?? "[]") as string[];
    prices = JSON.parse(raw.outcomePrices ?? "[]") as string[];
  } catch {
    return null;
  }

  if (outcomes.length !== 2 || prices.length !== 2) return null;

  const tokens = outcomes.map((outcome, i) => ({
    token_id: `${raw.conditionId}_${i}`,
    outcome,
    price: parseFloat(prices[i]) || 0,
  }));

  return {
    condition_id: raw.conditionId,
    question: raw.question ?? "",
    tokens,
    volume: raw.volumeNum ?? (parseFloat(raw.volume ?? "0") || 0),
    end_date_iso: raw.endDate ?? "",
    active: raw.active ?? false,
    closed: raw.closed ?? false,
  };
}

export function normalizePolymarket(m: PolymarketMarket): NormalizedMarket | null {
  // Accept "Yes"/"No" outcomes or treat first token as Yes, second as No
  const yesToken = m.tokens.find((t) => t.outcome === "Yes") ?? m.tokens[0];
  const noToken = m.tokens.find((t) => t.outcome === "No") ?? m.tokens[1];
  if (!yesToken || !noToken) return null;
  if (yesToken === noToken) return null;

  const closeTime = new Date(m.end_date_iso);
  const closeMs = closeTime.getTime();
  return {
    id: `poly_${m.condition_id}`,
    source: "polymarket",
    title: m.question,
    normalizedTitle: "",
    tokens: new Set<string>(),
    yesAsk: yesToken.price,
    noAsk: noToken.price,
    volume: m.volume,
    closeTime,
    checksum: createChecksum(yesToken.price, noToken.price, m.volume),
    structureChecksum: createStructureChecksum(m.question, Number.isNaN(closeMs) ? 0 : closeMs),
    raw: m,
  };
}

export async function fetchAllPolymarketMarkets(): Promise<PolymarketMarket[]> {
  const markets: PolymarketMarket[] = [];
  let offset = 0;

  const pageSize = config.polymarketPageSize;
  for (let page = 0; page < config.polymarketDiscoveryMaxPages; page++) {
    await bucket.acquire();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs + 5000);

    try {
      const url = new URL(`${BASE_URL}/markets`);
      url.searchParams.set("limit", String(pageSize));
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("active", "true");
      url.searchParams.set("closed", "false");

      const res = await fetch(url.toString(), {
        signal: controller.signal,
        headers: { "Accept": "application/json" },
      });

      if (res.status === 429) {
        clearTimeout(timeout);
        polyHttp429++;
        scanLog("warn", "fetch-poly", `HTTP 429 — rate limited, retrying`, `page ${page}`);
        const retryAfter = parseInt(res.headers.get("retry-after") ?? "2", 10);
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }

      if (!res.ok) {
        throw new Error(`Polymarket HTTP ${res.status}: ${res.statusText}`);
      }

      const data = (await res.json()) as GammaMarket[];
      recordPolyBody(data);
      if (!Array.isArray(data) || data.length === 0) {
        scanLog("info", "fetch-poly", `Discovery complete — no more pages`, `${markets.length} markets total`);
        break;
      }

      let pageAccepted = 0;
      for (const raw of data) {
        const parsed = parseGammaMarket(raw);
        if (parsed && parsed.active && !parsed.closed) {
          markets.push(parsed);
          pageAccepted++;
        }
      }

      scanLog("info", "fetch-poly", `Page ${page + 1}: fetched ${data.length} raw, accepted ${pageAccepted}`, `running total: ${markets.length}`);

      offset += data.length;
      if (data.length < pageSize) {
        scanLog("info", "fetch-poly", `Discovery complete — last page reached`, `${markets.length} markets total`);
        break;
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        appendError("Polymarket fetch timeout");
        scanLog("error", "fetch-poly", "Fetch timeout", `page ${page}`);
      } else {
        const cause = err instanceof Error && (err as any).cause ? ` — ${(err as any).cause}` : "";
        appendError(`Polymarket fetch error: ${err instanceof Error ? err.message : String(err)}${cause}`);
        scanLog("error", "fetch-poly", `Fetch error: ${err instanceof Error ? err.message : String(err)}`, cause || undefined);
      }
      break;
    } finally {
      clearTimeout(timeout);
    }
  }

  return markets;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Refresh mode: fetch only the markets for known matched condition IDs.
export async function fetchPolymarketMarketsByConditionIds(
  conditionIds: string[],
): Promise<PolymarketMarket[]> {
  if (conditionIds.length === 0) return [];

  const pageSize = config.polymarketPageSize;
  const batchSize = config.polymarketConditionIdsBatchSize;
  const allMarkets: PolymarketMarket[] = [];

  for (const batch of chunk(conditionIds, batchSize)) {
    let attempt = 0;
    while (attempt < 2) {
      attempt++;
      await bucket.acquire();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs + 5000);

      try {
        const url = new URL(`${BASE_URL}/markets`);
        url.searchParams.set("limit", String(pageSize));
        url.searchParams.set("active", "true");
        url.searchParams.set("closed", "false");

        // Gamma accepts condition_ids as an array query param.
        // We append multiple times to form a list.
        for (const id of batch) url.searchParams.append("condition_ids", id);

        const res = await fetch(url.toString(), {
          signal: controller.signal,
          headers: { "Accept": "application/json" },
        });

        if (res.status === 429) {
          polyHttp429++;
          const retryAfter = parseInt(res.headers.get("retry-after") ?? "2", 10);
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
          continue;
        }

        if (!res.ok) {
          throw new Error(`Polymarket condition_ids HTTP ${res.status}: ${res.statusText}`);
        }

        const data = (await res.json()) as GammaMarket[];
        recordPolyBody(data);
        if (!Array.isArray(data)) break;

        for (const raw of data) {
          const parsed = parseGammaMarket(raw);
          if (parsed && parsed.active && !parsed.closed) allMarkets.push(parsed);
        }
        break; // success
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          appendError("Polymarket refresh fetch timeout");
        } else {
          appendError(`Polymarket refresh fetch error: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  return allMarkets;
}
