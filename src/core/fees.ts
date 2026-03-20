import { config } from "../config.js";

/**
 * Volume-tier fee schedules for Polymarket and Kalshi.
 * Each tier defines a max volume threshold and the corresponding fee in basis points.
 * Tiers are checked in order; the first matching tier is used.
 */

interface FeeTier {
  maxVolume: number; // USD — up to this combined volume
  feeBps: number;    // basis points
}

// Polymarket fee tiers (based on public fee schedule):
// Higher volume traders get lower fees.
const POLY_FEE_TIERS: FeeTier[] = [
  { maxVolume: 10_000, feeBps: 50 },     // $0–$10K: 0.50%
  { maxVolume: 100_000, feeBps: 40 },     // $10K–$100K: 0.40%
  { maxVolume: 500_000, feeBps: 30 },     // $100K–$500K: 0.30%
  { maxVolume: Infinity, feeBps: 20 },     // $500K+: 0.20%
];

// Kalshi fee tiers:
const KALSHI_FEE_TIERS: FeeTier[] = [
  { maxVolume: 5_000, feeBps: 30 },       // $0–$5K: 0.30%
  { maxVolume: 50_000, feeBps: 25 },       // $5K–$50K: 0.25%
  { maxVolume: 250_000, feeBps: 20 },      // $50K–$250K: 0.20%
  { maxVolume: Infinity, feeBps: 15 },      // $250K+: 0.15%
];

function lookupFee(tiers: FeeTier[], volume: number): number {
  for (const tier of tiers) {
    if (volume <= tier.maxVolume) return tier.feeBps / 10_000;
  }
  return tiers[tiers.length - 1]!.feeBps / 10_000;
}

/**
 * Returns fee fraction for a Polymarket leg, considering the market's volume.
 * Falls back to the flat config value if USE_TIERED_FEES is false.
 */
export function getPolymarketFee(marketVolume: number): number {
  if (!config.useTieredFees) return config.polymarketTakerFeeFraction;
  return lookupFee(POLY_FEE_TIERS, marketVolume);
}

/**
 * Returns fee fraction for a Kalshi leg, considering the market's volume.
 * Falls back to the flat config value if USE_TIERED_FEES is false.
 */
export function getKalshiFee(marketVolume: number): number {
  if (!config.useTieredFees) return config.kalshiTakerFeeFraction;
  return lookupFee(KALSHI_FEE_TIERS, marketVolume);
}
