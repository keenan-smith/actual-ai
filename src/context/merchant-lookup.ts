import fs from 'fs';
import path from 'path';
import { MerchantLookupI } from './transaction-context';
import { normalizeMerchantName } from './merchant-name';

interface CacheEntry {
  info: string;
  at: number;
}

const DAY_MS = 86_400_000;
const FOUND_TTL_MS = 180 * DAY_MS;
// Unknowns are retried sooner: small businesses get indexed over time.
const UNKNOWN_TTL_MS = 30 * DAY_MS;

/**
 * Asks an OpenRouter model with the web search plugin what business is behind a bank
 * descriptor. Results are cached on disk because each search is billed.
 */
export default class MerchantLookupService implements MerchantLookupI {
  private cache?: Record<string, CacheEntry>;

  private readonly apiKey: string;

  private readonly model: string;

  private readonly baseURL: string;

  private readonly cacheFile: string;

  private readonly timeoutMs: number;

  private readonly fetchFn: typeof fetch;

  constructor(
    apiKey: string,
    model: string,
    baseURL: string,
    cacheFile: string,
    timeoutMs = 60_000,
    fetchFn: typeof fetch = fetch,
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseURL = baseURL;
    this.cacheFile = cacheFile;
    this.timeoutMs = timeoutMs;
    this.fetchFn = fetchFn;
  }

  public async lookup(descriptor: string, payeeName: string): Promise<string> {
    const key = normalizeMerchantName(descriptor) || normalizeMerchantName(payeeName);
    if (!key) return '';

    const cache = this.loadCache();
    const hit = cache[key];
    if (hit && Date.now() - hit.at < (hit.info ? FOUND_TTL_MS : UNKNOWN_TTL_MS)) {
      return hit.info;
    }

    let info: string;
    try {
      info = await this.search(descriptor, payeeName);
    } catch (error) {
      // Not cached, so a transient failure is retried next run.
      console.warn(`Merchant lookup failed for "${descriptor}":`, error instanceof Error ? error.message : error);
      return '';
    }
    console.log(`Merchant lookup for "${descriptor}": ${info || 'unknown'}`);
    cache[key] = { info, at: Date.now() };
    this.saveCache();
    return info;
  }

  private async search(descriptor: string, payeeName: string): Promise<string> {
    const names = payeeName && payeeName !== descriptor
      ? `bank statement text "${descriptor}" (payee name "${payeeName}")`
      : `bank statement text "${descriptor}"`;
    const prompt = `Identify the business behind this card transaction: ${names}. `
      + 'Answer in at most two short sentences: the business name and what kind of business it is / what it sells. '
      + 'If you cannot identify it with reasonable confidence, answer exactly UNKNOWN.';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchFn(`${this.baseURL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'actual-ai',
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          plugins: [{ id: 'web', max_results: 3 }],
          // Reasoning models spend most of this before answering; too low a cap returns no text.
          max_tokens: 2000,
          temperature: 0,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
      }
      const body = await response.json() as {
        choices?: { finish_reason?: string; message?: { content?: string | null } }[];
      };
      const choice = body.choices?.[0];
      const text = (choice?.message?.content ?? '').trim();
      // Thrown rather than returned so a cut-off answer isn't cached as "unknown".
      if (!text || choice?.finish_reason === 'length') {
        throw new Error(`no usable answer (finish_reason: ${choice?.finish_reason ?? 'none'})`);
      }
      return /^unknown\.?$/i.test(text) ? '' : text;
    } finally {
      clearTimeout(timer);
    }
  }

  private loadCache(): Record<string, CacheEntry> {
    if (!this.cache) {
      try {
        this.cache = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8')) as Record<string, CacheEntry>;
      } catch {
        this.cache = {};
      }
    }
    return this.cache;
  }

  private saveCache(): void {
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      const tmp = `${this.cacheFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.cache, null, 2));
      fs.renameSync(tmp, this.cacheFile);
    } catch (error) {
      console.warn(`Could not save merchant cache to ${this.cacheFile}:`, error);
    }
  }
}
