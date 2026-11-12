import type { TransactionEntity } from '@actual-app/core/src/types/models';
import type { APIPayeeEntity } from '@actual-app/core/src/server/api-models';
import type { APICategoryGroupEntity } from '../types';
import { merchantSimilarity, normalizeMerchantName } from './merchant-name';

export interface TransactionContext {
  history: string;
  merchantInfo: string;
}

export interface MerchantLookupI {
  lookup(descriptor: string, payeeName: string): Promise<string>;
}

interface HistoryEntry {
  transaction: TransactionEntity;
  payeeName: string;
  categoryName: string;
}

const MATCH_THRESHOLD = 0.92;
const MAX_EXAMPLES = 10;
const DAY_MS = 86_400_000;

const PERIODS: { name: string; min: number; max: number }[] = [
  { name: 'weekly', min: 6, max: 8 },
  { name: 'every two weeks', min: 13, max: 16 },
  { name: 'monthly', min: 26, max: 35 },
  { name: 'quarterly', min: 84, max: 97 },
  { name: 'yearly', min: 350, max: 380 },
];

export function formatAmount(amount: number): string {
  // Actual stores amounts as integer cents.
  return (amount / 100).toFixed(2);
}

function formatSigned(amount: number): string {
  return amount < 0 ? `-${formatAmount(-amount)}` : `+${formatAmount(amount)}`;
}

function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);
}

function amountsClose(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(100, Math.abs(b) * 0.1);
}

export default class TransactionContextProvider {
  private readonly guessedTag: string;

  private readonly merchantLookup?: MerchantLookupI;

  private readonly historyEnabled: boolean;

  // Grouped by normalized merchant name so each lookup compares against unique names, not
  // every transaction in the budget.
  private historyByMerchant = new Map<string, HistoryEntry[]>();

  constructor(guessedTag: string, historyEnabled: boolean, merchantLookup?: MerchantLookupI) {
    this.guessedTag = guessedTag;
    this.historyEnabled = historyEnabled;
    this.merchantLookup = merchantLookup;
  }

  public setHistory(
    transactions: TransactionEntity[],
    payees: APIPayeeEntity[],
    categoryGroups: APICategoryGroupEntity[],
  ): void {
    const payeeNames = new Map(payees.map((p) => [p.id, p.name]));
    const categoryNames = new Map<string, string>();
    categoryGroups.forEach((group) => {
      (group.categories ?? []).forEach((c) => categoryNames.set(c.id, c.name));
    });

    this.historyByMerchant = new Map();
    transactions.forEach((t) => {
      const categoryName = t.category ? categoryNames.get(t.category) : undefined;
      if (!categoryName || t.is_parent || t.transfer_id) return;
      const payeeName = (t.payee && payeeNames.get(t.payee)) ?? '';
      const entry = { transaction: t, payeeName, categoryName };
      new Set([normalizeMerchantName(payeeName), normalizeMerchantName(t.imported_payee)])
        .forEach((key) => {
          if (!key) return;
          const list = this.historyByMerchant.get(key) ?? [];
          list.push(entry);
          this.historyByMerchant.set(key, list);
        });
    });
  }

  public async getContext(
    transaction: TransactionEntity,
    payees: APIPayeeEntity[],
  ): Promise<TransactionContext> {
    const payeeName = payees.find((p) => p.id === transaction.payee)?.name ?? '';
    const matches = this.historyEnabled ? this.findSimilar(transaction, payeeName) : [];
    const history = matches.length ? this.describeHistory(transaction, matches) : '';

    let merchantInfo = '';
    // Known merchants are already explained by their history, so only pay for a web search
    // when there is nothing to go on.
    if (this.merchantLookup && matches.length === 0) {
      merchantInfo = await this.merchantLookup.lookup(
        transaction.imported_payee ?? payeeName,
        payeeName,
      );
    }
    return { history, merchantInfo };
  }

  private findSimilar(transaction: TransactionEntity, payeeName: string): HistoryEntry[] {
    const keys = [payeeName, transaction.imported_payee].map(normalizeMerchantName).filter(Boolean);
    if (!keys.length) return [];

    const found = new Map<string, HistoryEntry>();
    this.historyByMerchant.forEach((entries, merchant) => {
      if (!keys.some((k) => merchantSimilarity(k, merchant) >= MATCH_THRESHOLD)) return;
      entries.forEach((e) => {
        if (e.transaction.id !== transaction.id) found.set(e.transaction.id, e);
      });
    });
    return [...found.values()].sort((a, b) => b.transaction.date.localeCompare(a.transaction.date));
  }

  private describeHistory(transaction: TransactionEntity, matches: HistoryEntry[]): string {
    const lines: string[] = [];
    lines.push(`${matches.length} previous categorized transaction(s) from this or a similarly named merchant (most recent first):`);
    matches.slice(0, MAX_EXAMPLES).forEach(({ transaction: t, payeeName, categoryName }) => {
      const bank = payeeName && t.imported_payee && t.imported_payee !== payeeName ? ` (bank text: "${t.imported_payee}")` : '';
      const byAi = t.notes?.includes(this.guessedTag) ? ' [categorized by AI, not confirmed]' : '';
      lines.push(`* ${t.date} | ${payeeName || t.imported_payee}${bank} | ${formatSigned(t.amount)} | ${categoryName}${byAi}`);
    });

    lines.push(...this.describeCategories(matches));
    lines.push(...this.describeAmount(transaction, matches));
    lines.push(...this.describeRecurrence(transaction, matches));
    return lines.join('\n');
  }

  private describeCategories(matches: HistoryEntry[]): string[] {
    const byCategory = new Map<string, number[]>();
    matches.forEach(({ categoryName, transaction: t }) => {
      byCategory.set(categoryName, [...(byCategory.get(categoryName) ?? []), t.amount]);
    });
    const parts = [...byCategory.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([name, amounts]) => {
        const lo = formatSigned(Math.min(...amounts));
        const hi = formatSigned(Math.max(...amounts));
        return `${name} ${amounts.length}x (${lo === hi ? lo : `${lo} to ${hi}`})`;
      });
    const legend = 'count, amount range; - is money out, + is money in';
    return [`Categories used for this merchant (${legend}): ${parts.join('; ')}`];
  }

  private describeAmount(transaction: TransactionEntity, matches: HistoryEntry[]): string[] {
    const { amount } = transaction;
    const same = matches.filter((m) => m.transaction.amount === amount);
    if (same.length) {
      const cats = [...new Set(same.map((m) => m.categoryName))].join(', ');
      return [`This exact amount (${formatAmount(Math.abs(amount))}) appeared ${same.length} time(s) before, categorized as: ${cats}.`];
    }
    // Same-named merchants can both charge and pay (interest charged vs earned), so only compare
    // like with like.
    const sameDirection = matches
      .filter((m) => Math.sign(m.transaction.amount) === Math.sign(amount));
    if (sameDirection.length < 3) return [];

    const typical = median(sameDirection.map((m) => Math.abs(m.transaction.amount)));
    const ratio = Math.abs(amount) / typical;
    if (ratio > 2 || ratio < 0.5) {
      const nearest = [...sameDirection].sort((a, b) => Math.abs(a.transaction.amount - amount)
        - Math.abs(b.transaction.amount - amount))[0];
      return [`This amount (${formatAmount(Math.abs(amount))}) is unusual for this merchant (typical ${formatAmount(typical)}); the closest previous amount was ${formatAmount(Math.abs(nearest.transaction.amount))} (${nearest.categoryName}).`];
    }
    return [];
  }

  private describeRecurrence(transaction: TransactionEntity, matches: HistoryEntry[]): string[] {
    const series = matches
      .filter((m) => Math.sign(m.transaction.amount) === Math.sign(transaction.amount)
        && amountsClose(m.transaction.amount, transaction.amount))
      .map((m) => m.transaction)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (series.length < 2) return [];

    const gaps = series.slice(1).map((t, i) => daysBetween(series[i].date, t.date));
    const typicalGap = median(gaps);
    const period = PERIODS.find((p) => typicalGap >= p.min && typicalGap <= p.max);
    const regular = gaps.filter((g) => Math.abs(g - typicalGap) <= typicalGap * 0.25).length;
    if (!period || regular < Math.max(1, Math.ceil(gaps.length * 0.66))) return [];

    const last = series[series.length - 1];
    const sinceLast = daysBetween(last.date, transaction.date);
    const fits = Math.abs(sinceLast - typicalGap) <= Math.max(3, typicalGap * 0.25);
    const cats = [...new Set(series.map((t) => matches.find((m) => m.transaction === t)?.categoryName))].join(', ');
    const kind = transaction.amount < 0 ? 'charge' : 'income';
    return [`Looks like recurring ${period.name} ${kind} of about ${formatAmount(Math.abs(median(series.map((t) => t.amount))))} (${series.length} times, last on ${last.date}, categorized as: ${cats}); this transaction ${fits ? 'fits' : 'does not fit'} that schedule.`];
  }
}
