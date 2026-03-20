// ANSI color codes
const RESET = "\x1b[0m";
const BRIGHT = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const GRAY = "\x1b[90m";
const WHITE = "\x1b[37m";
const CYAN = "\x1b[36m";
const BRIGHT_GREEN = "\x1b[92m";

export function colorProfit(profitPct: number, text: string): string {
  if (profitPct > 5) return `${BRIGHT_GREEN}${BRIGHT}${text}${RESET}`;
  if (profitPct >= 1) return `${YELLOW}${text}${RESET}`;
  if (profitPct >= 0.8) return `${DIM}${WHITE}${text}${RESET}`;
  return `${GRAY}${text}${RESET}`;
}

export function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export function formatProfit(profitPerContract: number, profitPct: number): string {
  const cents = Math.round(profitPerContract * 100);
  const sign = cents >= 0 ? "+" : "";
  return `${sign}${cents}¢  (${profitPct.toFixed(0)}%)`;
}

export function formatTrade(polySide: string, kalshiSide: string): string {
  return `P:${polySide} + K:${kalshiSide}`;
}

export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}

export function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

export function header(text: string): string {
  return `${CYAN}${BRIGHT}${text}${RESET}`;
}

export function dim(text: string): string {
  return `${DIM}${text}${RESET}`;
}

export function progressBar(pct: number, width: number = 16): string {
  const filled = Math.round(pct * width);
  const empty = width - filled;
  return `[${GREEN}${"█".repeat(filled)}${GRAY}${"░".repeat(empty)}${RESET}]`;
}
