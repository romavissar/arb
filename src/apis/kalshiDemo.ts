import type { KalshiMarket } from "../types/index.js";

// Realistic Kalshi-style markets that overlap with common Polymarket topics.
// Prices jitter slightly each call to simulate live movement.

const DEMO_MARKETS: Array<{
  ticker: string;
  title: string;
  baseYes: number; // cents
  baseNo: number;
  volume: number;
  closeDate: string; // ISO date
  event_ticker: string;
}> = [
  // Titles mirror actual Polymarket wording closely for demo matching
  { ticker: "PRES-2028-TRUMP", title: "Will Donald Trump win the 2028 US Presidential Election?", baseYes: 24, baseNo: 78, volume: 58000, closeDate: "2028-11-07", event_ticker: "PRES-2028" },
  { ticker: "FED-RATE-CUT-APR26", title: "Federal Reserve interest rate cut in April 2026?", baseYes: 45, baseNo: 58, volume: 22000, closeDate: "2026-04-30", event_ticker: "FED-RATES" },
  { ticker: "BTC-100K-2026", title: "Will Bitcoin be above $100,000 on December 31, 2026?", baseYes: 62, baseNo: 41, volume: 45000, closeDate: "2026-12-31", event_ticker: "BTC-PRICE" },
  { ticker: "RECESSION-2026", title: "Will the US enter a recession in 2026?", baseYes: 38, baseNo: 65, volume: 31000, closeDate: "2026-12-31", event_ticker: "MACRO" },
  { ticker: "TIKTOK-BAN-2026", title: "Will TikTok be banned in the United States in 2026?", baseYes: 25, baseNo: 78, volume: 18000, closeDate: "2026-12-31", event_ticker: "TECH-REG" },
  { ticker: "ETH-5K-2026", title: "Will Ethereum be above $5,000 on December 31, 2026?", baseYes: 30, baseNo: 73, volume: 12000, closeDate: "2026-12-31", event_ticker: "ETH-PRICE" },
  { ticker: "TRUMP-IMPEACH-2026", title: "Will Donald Trump be impeached in 2026?", baseYes: 8, baseNo: 94, volume: 9000, closeDate: "2026-12-31", event_ticker: "POLITICS" },
  { ticker: "SP500-6000-JUN26", title: "Will the S&P 500 be above 6,000 on June 30, 2026?", baseYes: 55, baseNo: 48, volume: 27000, closeDate: "2026-06-30", event_ticker: "MARKETS" },
  { ticker: "UKRAINE-CEASEFIRE-2026", title: "Russia-Ukraine ceasefire in 2026?", baseYes: 42, baseNo: 61, volume: 15000, closeDate: "2026-12-31", event_ticker: "GEOPOLITICS" },
  { ticker: "FED-RATE-CUT-MAR26", title: "Will the Fed cut interest rates in March 2026?", baseYes: 52, baseNo: 51, volume: 35000, closeDate: "2026-03-31", event_ticker: "FED-RATES" },
  { ticker: "AI-REGULATION-2026", title: "Will the US pass federal AI regulation in 2026?", baseYes: 20, baseNo: 82, volume: 8000, closeDate: "2026-12-31", event_ticker: "TECH-REG" },
  { ticker: "CHINA-TAIWAN-2026", title: "Will China invade Taiwan in 2026?", baseYes: 5, baseNo: 96, volume: 11000, closeDate: "2026-12-31", event_ticker: "GEOPOLITICS" },
  { ticker: "MUSK-TWITTER-CEO", title: "Will Elon Musk still be CEO of X/Twitter at end of 2026?", baseYes: 70, baseNo: 33, volume: 6000, closeDate: "2026-12-31", event_ticker: "TECH" },
  { ticker: "GDP-GROWTH-Q2-26", title: "Will US GDP growth exceed 2% in Q2 2026?", baseYes: 60, baseNo: 43, volume: 14000, closeDate: "2026-06-30", event_ticker: "MACRO" },
  { ticker: "SUPREME-COURT-RETIRE", title: "Will a Supreme Court justice retire in 2026?", baseYes: 30, baseNo: 73, volume: 7000, closeDate: "2026-12-31", event_ticker: "POLITICS" },
  { ticker: "NFLSB-CHIEFS-2027", title: "Will the Kansas City Chiefs win Super Bowl 2027?", baseYes: 12, baseNo: 90, volume: 20000, closeDate: "2027-02-14", event_ticker: "SPORTS" },
  { ticker: "BTC-150K-2026", title: "Will Bitcoin reach $150,000 in 2026?", baseYes: 25, baseNo: 78, volume: 30000, closeDate: "2026-12-31", event_ticker: "BTC-PRICE" },
  { ticker: "US-DEBT-CEILING", title: "Will the US hit the debt ceiling before July 2026?", baseYes: 72, baseNo: 31, volume: 13000, closeDate: "2026-07-01", event_ticker: "MACRO" },
  { ticker: "NEWSOM-PRES-2028", title: "Will Gavin Newsom win the 2028 US Presidential Election?", baseYes: 5, baseNo: 97, volume: 5000, closeDate: "2028-11-07", event_ticker: "PRES-2028" },
  { ticker: "OPENAI-IPO-2026", title: "Will OpenAI IPO in 2026?", baseYes: 40, baseNo: 63, volume: 16000, closeDate: "2026-12-31", event_ticker: "TECH" },
];

function jitter(base: number, range: number): number {
  const val = base + Math.round((Math.random() - 0.5) * range * 2);
  return Math.max(1, Math.min(99, val));
}

export function generateDemoKalshiMarkets(): KalshiMarket[] {
  return DEMO_MARKETS.map((m) => {
    const yesAsk = jitter(m.baseYes, 3);
    const noAsk = jitter(m.baseNo, 3);
    return {
      ticker: m.ticker,
      title: m.title,
      yes_ask: yesAsk,
      no_ask: noAsk,
      volume: m.volume + Math.round((Math.random() - 0.5) * 2000),
      close_time: new Date(m.closeDate).toISOString(),
      status: "open",
      event_ticker: m.event_ticker,
    };
  });
}
