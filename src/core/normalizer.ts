// ─── Abbreviation expansions ───

const ABBREVIATIONS: Record<string, string> = {
  "us": "united states",
  "usa": "united states",
  "u.s.": "united states",
  "u.s": "united states",
  "uk": "united kingdom",
  "fed": "federal reserve",
  "eoy": "end of year",
  "eod": "end of day",
  "gdp": "gross domestic product",
  "cpi": "consumer price index",
  "btc": "bitcoin",
  "eth": "ethereum",
  "gop": "republican",
  "dem": "democrat",
  "potus": "president",
  "scotus": "supreme court",
  "nfl": "national football league",
  "nba": "national basketball association",
  "mlb": "major league baseball",
  "nyc": "new york city",
  "la": "los angeles",
  "sf": "san francisco",
  "dc": "washington dc",
};

// ─── Name normalization (surname only) ───

const NAME_MAP: Record<string, string> = {
  "donald trump": "trump",
  "donald j trump": "trump",
  "joe biden": "biden",
  "joseph biden": "biden",
  "kamala harris": "harris",
  "ron desantis": "desantis",
  "gavin newsom": "newsom",
  "nikki haley": "haley",
  "vivek ramaswamy": "ramaswamy",
  "elon musk": "musk",
  "jerome powell": "powell",
  "jay powell": "powell",
  "vladimir putin": "putin",
  "volodymyr zelensky": "zelensky",
  "xi jinping": "xi",
  "benjamin netanyahu": "netanyahu",
};

// ─── Stop words ───

const STOP_WORDS = new Set([
  "will", "the", "a", "an", "by", "in", "on", "at", "be", "to",
  "of", "for", "is", "it", "that", "this", "with", "as", "or",
  "and", "if", "do", "does", "did", "has", "have", "had", "was",
  "were", "been", "being", "are", "not", "but", "its", "their",
  "they", "them", "from", "than", "which", "who", "whom",
]);

// ─── Month map for date normalization ───

const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04",
  may: "05", june: "06", july: "07", august: "08",
  september: "09", october: "10", november: "11", december: "12",
  jan: "01", feb: "02", mar: "03", apr: "04",
  jun: "06", jul: "07", aug: "08", sep: "09",
  oct: "10", nov: "11", dec: "12",
};

// ─── Date normalization ───

function normalizeDates(text: string): string {
  // "December 31, 2025" or "Dec 31, 2025"
  text = text.replace(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})\b/gi,
    (_match, month: string, day: string, year: string) => {
      const m = MONTHS[month.toLowerCase()];
      return m ? `${year}-${m}-${day.padStart(2, "0")}` : _match;
    }
  );

  // "Dec 31" (no year — assume current year)
  const currentYear = new Date().getFullYear();
  text = text.replace(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi,
    (_match, month: string, day: string) => {
      const m = MONTHS[month.toLowerCase()];
      return m ? `${currentYear}-${m}-${day.padStart(2, "0")}` : _match;
    }
  );

  // "end of 2025" → "2025-12-31"
  text = text.replace(/\bend of (\d{4})\b/gi, "$1-12-31");

  // "Q1 2025" → "2025-03-31", etc.
  text = text.replace(/\bq([1-4])\s*(\d{4})\b/gi, (_match, q: string, year: string) => {
    const endMonth = ["03", "06", "09", "12"][parseInt(q) - 1];
    const endDay = ["31", "30", "30", "31"][parseInt(q) - 1];
    return `${year}-${endMonth}-${endDay}`;
  });

  return text;
}

// ─── Extract dates from normalized string ───

export function extractDates(text: string): Date[] {
  const dates: Date[] = [];
  const regex = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const d = new Date(`${match[1]}-${match[2]}-${match[3]}`);
    if (!isNaN(d.getTime())) dates.push(d);
  }
  return dates;
}

// ─── Main normalization pipeline ───

export function normalize(text: string): { normalized: string; tokens: Set<string> } {
  // Step 1: lowercase
  let s = text.toLowerCase();

  // Step 2: normalize dates before stripping punctuation
  s = normalizeDates(s);

  // Step 3: expand names (do before tokenizing)
  for (const [full, short] of Object.entries(NAME_MAP)) {
    if (s.includes(full)) {
      s = s.replaceAll(full, short);
    }
  }

  // Step 4: strip punctuation except hyphens between words and date separators
  s = s.replace(/[^\w\s-]/g, " ");
  // Collapse multiple spaces
  s = s.replace(/\s+/g, " ").trim();

  // Step 5: expand abbreviations
  const words = s.split(/\s+/);
  const expanded = words.map((w) => ABBREVIATIONS[w] ?? w);

  // Step 6: re-split after expansion (abbreviations may produce multi-word strings)
  const allWords = expanded.join(" ").split(/\s+/);

  // Step 7: remove stop words and junk tokens (single chars, bare punctuation)
  const filtered = allWords.filter((w) => !STOP_WORDS.has(w) && w.length > 1 && !/^[\-_]+$/.test(w));

  const normalized = filtered.join(" ");
  const tokens = new Set(filtered);

  return { normalized, tokens };
}

// ─── Bigram computation ───

export function bigrams(str: string): Set<string> {
  const result = new Set<string>();
  for (let i = 0; i < str.length - 1; i++) {
    result.add(str.slice(i, i + 2));
  }
  return result;
}
