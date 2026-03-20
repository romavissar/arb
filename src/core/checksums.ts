export function createChecksum(yesPrice: number, noPrice: number, volume: number): string {
  return `${yesPrice.toFixed(4)}_${noPrice.toFixed(4)}_${Math.round(volume)}`;
}

/** Detect title / resolution-date changes for match invalidation (not price-only ticks). */
export function createStructureChecksum(title: string, closeTimeMs: number): string {
  const safe = title.replaceAll("|", " ").slice(0, 512);
  return `${safe}|${closeTimeMs}`;
}
