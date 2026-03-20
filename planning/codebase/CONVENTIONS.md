# Coding Conventions

**Analysis Date:** 2026-03-20

## Naming Patterns

**Files:**
- Module files: lowercase with hyphens for multi-word names (e.g., `rateLimit.ts`, `scanLog.ts`)
- API modules: `[service].ts` pattern (e.g., `polymarket.ts`, `kalshi.ts`, `kalshiDemo.ts`)
- Domain modules in `core/`: descriptive names matching their single responsibility (e.g., `arbitrage.ts`, `matcher.ts`, `persistence.ts`)
- Export-heavy modules use plural or descriptive names: `types/index.ts`, `display/formatter.ts`, `display/renderer.ts`

**Functions:**
- camelCase for all functions (public and private): `pairPassesQuotePrefilter()`, `computeArb()`, `normalizePolymarket()`
- Helper functions prefixed with purpose when private: `hoursUntil()`, `envStr()`, `staleIndicator()`
- Getter functions use `get` prefix for methods: `getPolymarketFetchStats()`, `getKalshiFee()`, `getMatchCacheSize()`
- Reset/update functions: `resetPolymarketFetchStats()`, `updateTrackedOpportunities()`, `appendError()`
- Boolean check functions start with `passes`, `is`, or `has`: `pairPassesQuotePrefilter()`, `yearsCompatible()`

**Variables:**
- camelCase for all variables: `trackedOpportunities`, `matchedPairs`, `profitPctAfterFees`
- Short names acceptable in loops/temporary contexts: `a`, `b`, `m`, `list`, `id`, `key`
- Constants use UPPER_SNAKE_CASE: `STALE_EXPIRY_CYCLES`, `MAX_BUFFER`, `BASE_URL`, `RESET` (ANSI codes)
- Private class fields use `private` keyword with `#` or `private readonly`: `private tokens: number`, `private readonly map`
- Descriptive abbreviations: `poly` (polymarket), `kalshi`, `arb` (arbitrage), `opp` (opportunity), `ms` (milliseconds)

**Types:**
- Interface names are PascalCase: `ArbOpportunity`, `MatchedPair`, `NormalizedMarket`, `ScanLogEntry`
- Interfaces for external API responses: `PolymarketMarket`, `KalshiMarket`, `PolymarketResponse`
- Generic types: simple single-letter (e.g., `K`, `V` in `LRUCache<K, V>`)
- Type imports use `import type { ... }` syntax: `import type { ArbOpportunity, MatchedPair } from "../types/index.js"`
- Discriminated union types: `type ScanLogLevel = "info" | "warn" | "error" | "success" | "debug"`

## Code Style

**Formatting:**
- No explicit formatter (Prettier/ESLint) configured — code follows implicit conventions
- Line length: ~100-120 characters (soft limit, observed in practice)
- 2-space indentation
- Semicolons present on all statements
- Single quotes for strings: `'polymarket'`, `"Yes"`, `'../../types/index.js'`
- Template literals for interpolation: `` `${value}` ``
- Trailing commas in multi-line objects/arrays

**Linting:**
- No explicit linting configuration found (no `.eslintrc`, `biome.json`, etc.)
- TypeScript strict mode enabled in `tsconfig.json` (strict: true)
- No linting enforced at commit time; relies on author discipline

**TypeScript Config:**
- Target: ES2022
- Module: NodeNext
- Strict mode enabled
- Declaration files generated
- Source maps included for debugging

## Import Organization

**Order:**
1. Built-in Node.js modules (`import { ... } from "node:fs"`, `from "node:path"`)
2. Third-party packages (`import Table from "cli-table3"`, `import { config as dotenvConfig }`)
3. Relative project imports using `.js` extension (`from "../config.js"`, `from "./types/index.js"`)
4. Type imports (can be interleaved but typically after regular imports)

Example from `src/apis/polymarket.ts`:
```typescript
import { config } from "../config.js";              // Project config
import { TokenBucket } from "../core/rateLimit.js"; // Project module
import type { PolymarketMarket, NormalizedMarket } from "../types/index.js"; // Type import
```

**Path Aliases:**
- No path aliases configured (no `baseUrl` or `paths` in `tsconfig.json`)
- All imports use relative paths with `../` notation
- `.js` extension required on all relative imports (ESM compliance)

**Barrel Files:**
- `src/types/index.ts` exports all types centrally; imports use `from "../types/index.js"`
- Single responsibility modules typically export directly (e.g., `from "./arbitrage.js"`)

## Error Handling

**Patterns:**
- Silent catch blocks: `catch { /* ignore */ }` or `catch { /* never crash */ }` used when error is acceptable/expected
- Logging errors to file instead of throwing: `appendError(message: string): void` in `src/core/logging.ts`
- Functions validate input and return `null` for invalid state rather than throwing:
  ```typescript
  export function normalizePolymarket(m: PolymarketMarket): NormalizedMarket | null {
    if (!yesToken || !noToken) return null;
    if (yesToken === noToken) return null;
    // ...
  }
  ```
- Network/IO errors logged but poll loop continues (defensive loop design)
- Async operations wrapped in try-catch at top level; errors appended via `appendError()`

## Logging

**Framework:** Console and custom `scanLog()` function (no external logging library)

**Structured Logging:**
- `scanLog(level, category, message, detail?)` in `src/core/scanLog.ts` emits structured entries
- Levels: `"info"`, `"warn"`, `"error"`, `"success"`, `"debug"`
- Categories: `"fetch-poly"`, `"fetch-kalshi"`, `"normalize"`, `"match"`, `"arb"`, `"cycle"`, `"system"`

**File-based Logging:**
- `errors.log`: one timestamped error per line via `appendError()`
- `opportunities.jsonl`: one JSON-per-line via `appendOpportunity()` with timestamp
- `metrics.log`: one JSON-per-line cycle metrics via `appendMetricLine()` with timestamp

**Console Output:**
- ANSI color codes for terminal display (defined in `src/display/formatter.ts`)
- Color function: `colorProfit(profitPct, text)` for dynamic profit highlighting
- Formatted output via: `formatCurrency()`, `formatProfit()`, `formatTime()`, `header()`, `dim()`

Example logging in `src/core/arbitrage.ts`:
```typescript
scanLog("info", "arb", `Evaluating ${pairs.length} matched pairs for arbitrage`);
scanLog("success", "arb", `Found: "${poly.title.slice(0, 40)}" P:${arb.polymarketSide}+K:${arb.kalshiSide} +${arb.profitPct.toFixed(1)}%`, `cost=$${arb.combinedCost.toFixed(2)}...`);
scanLog("debug", "arb", `Rejected: "${poly.title.slice(0, 40)}"...`, `profit=${arb.profitPct.toFixed(1)}%...`);
```

## Comments

**When to Comment:**
- Block headers: `// ─── Session state ───` (visual section dividers using box-drawing characters)
- Non-obvious logic: `// Confidence escalation: for higher-profit opportunities, ...`
- Algorithm explanation: `// Accept "Yes"/"No" outcomes or treat first token as Yes, second as No`
- WARNING level: `/** Cheap gate: if both titles contain explicit years, require at least one in common. */`
- Purpose statements for constants: `/** Max cycles an opportunity can be "not seen" before being removed entirely */`

**JSDoc/TSDoc:**
- Minimal JSDoc usage — only on exported functions with non-obvious behavior
- Prefer comment block above function over param/return tags when purpose is clear from signature
- Example from `src/core/lruCache.ts`:
  ```typescript
  /**
   * Generic LRU cache with max capacity. Evicts least-recently-used entries when full.
   * Uses a Map (insertion order) for O(1) get/set/delete.
   */
  export class LRUCache<K, V> { ... }
  ```
- Example from `src/core/scanLog.ts`:
  ```typescript
  /** Max entries kept in memory for late-joining web clients. */
  const MAX_BUFFER = 500;
  ```

## Function Design

**Size:**
- Small, focused functions typical (10-50 lines)
- Complex logic broken into helper functions (e.g., `computeArb()` calls `hoursUntil()`, fee lookups)
- Main poll loop (`pollCycle()`) in `src/index.ts` can be 200+ lines but segmented logically

**Parameters:**
- Explicit parameter objects for functions with many related arguments:
  ```typescript
  export function persistOpportunity(data: {
    event: string;
    polymarketSide: "YES" | "NO";
    kalshiSide: "YES" | "NO";
    // ... 10+ fields
  }): void
  ```
- Type-safe discriminated unions: `kalshiSide: "YES" | "NO"` (not boolean)
- Optional parameters with defaults: `function progressBar(pct: number, width: number = 16)`

**Return Values:**
- Nullable returns for optional data: `NormalizedMarket | null`, `ArbOpportunity | null`
- Arrays for collections: `ArbOpportunity[]`, `MatchedPair[]`
- Maps/Sets for indexed lookups: `Map<string, TrackedOpportunity>`, `Set<string>`
- Object returns with explicit typing: `{ http429: number; bytesIn: number }`

## Module Design

**Exports:**
- Named exports for public functions: `export function detectArbitrage(...)`
- Named exports for interfaces/types: `export interface ArbOpportunity { ... }`
- Single default export NOT used (all named exports)
- Avoid re-export barrels except `types/index.ts`

**Barrel Files:**
- `src/types/index.ts` is central export point for all domain types
- Other modules export directly (e.g., `from "./arbitrage.js"`)
- Circular dependency avoided by unidirectional imports

**Class Design:**
- Classes used for stateful objects (e.g., `TokenBucket`, `AdaptiveRateLimiter`, `LRUCache`, `RollingCycleLatency`)
- Private fields and methods marked with `private` and/or `private readonly`
- Getter methods: `get rate()`, `get capacity()`, `get available()` (no parentheses when property-like)
- Constructor for initialization; methods for behavior

Example from `src/core/rateLimit.ts`:
```typescript
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number;

  constructor(maxTokens: number, refillRate: number) { ... }

  setRefillRate(tokensPerSecond: number): void { ... }
  async acquire(): Promise<void> { ... }
  get available(): number { ... }
}
```

## Configuration

**Env-based Config:**
- Single `config.ts` module loads all env vars via helper functions
- Helper functions: `envStr()`, `envInt()`, `envFloat()`, `envBool()`, `envBpsAsFraction()`
- Exported as single object: `export const config: Config`
- Used throughout codebase as `import { config } from "../config.js"`
- No dynamic config changes; read once at startup

**Config Patterns:**
```typescript
function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`Invalid integer for ${key}: ${raw}`);
  return parsed;
}

export const config: Config = {
  kalshiApiKey: envStr("KALSHI_API_KEY", ""),
  pollIntervalMs: envInt("POLL_INTERVAL_MS", 3000),
  minProfitPct: envFloat("MIN_PROFIT_PCT", 0.8),
  minVolumeUsd: envInt("MIN_VOLUME_USD", 1000),
  // ... 50+ config fields
};
```

---

*Convention analysis: 2026-03-20*
