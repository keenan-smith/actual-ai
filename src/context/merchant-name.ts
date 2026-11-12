import { JaroWinklerDistance } from 'natural/lib/natural/distance';

const US_STATES = new Set(('al ak az ar ca co ct de fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy dc').split(' '));

const NOISE_WORDS = new Set(['pos', 'purchase', 'debit', 'credit', 'card', 'checkcard', 'ach', 'recurring', 'www', 'com', 'http', 'https', 'inc', 'llc', 'ltd', 'co']);

/**
 * Reduces a bank descriptor to the merchant's name so the same merchant matches across
 * statements: "SQ *BLUE BOTTLE 0123 OAKLAND CA" -> "blue bottle oakland".
 */
export function normalizeMerchantName(raw: string | null | undefined): string {
  let s = (raw ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim();

  // Processors put their short code before the "*" (SQ *, TST*, PAYPAL *), merchants with
  // their own billing put a reference after it (AMZN Mktp US*2K4LJ), so keep the longer side.
  const star = s.indexOf('*');
  if (star >= 0) {
    const before = s.slice(0, star).trim();
    const after = s.slice(star + 1).trim();
    s = before.length > 0 && !/\s/.test(before) && before.length <= 7 ? after : before || after;
  }

  const tokens = s
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    // Long digit runs are store numbers and references, even glued to a name
    // ("walmart200015852668460"); short ones can be part of it ("7eleven").
    .map((t) => t.replace(/\d{4,}/g, ''))
    .filter((t) => t && (t.match(/\d/g) ?? []).length * 2 < t.length && !NOISE_WORDS.has(t));

  if (tokens.length > 1 && US_STATES.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  return tokens.join(' ');
}

export function merchantSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  // Statements often truncate or append the location: "blue bottle" vs "blue bottle oakland".
  if (longer.startsWith(`${shorter} `)) return 0.95;
  return JaroWinklerDistance(a, b);
}
