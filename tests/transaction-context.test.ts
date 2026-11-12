import fs from 'fs';
import os from 'os';
import path from 'path';
import { TransactionEntity } from '@actual-app/core/src/types/models';
import TransactionContextProvider, { MerchantLookupI } from '../src/context/transaction-context';
import MerchantLookupService from '../src/context/merchant-lookup';
import { merchantSimilarity, normalizeMerchantName } from '../src/context/merchant-name';
import PromptGenerator from '../src/prompt-generator';
import GivenActualData from './test-doubles/given/given-actual-data';

const G = GivenActualData;

function tx(
  id: string,
  amount: number,
  importedPayee: string,
  date: string,
  category?: string,
  notes = '',
): TransactionEntity {
  const { ACCOUNT_MAIN: account } = G;
  const args = [notes, undefined, account, date, false, category] as const;
  return G.createTransaction(id, amount, importedPayee, ...args);
}

class StubLookup implements MerchantLookupI {
  public calls: string[] = [];

  async lookup(descriptor: string): Promise<string> {
    this.calls.push(descriptor);
    return Promise.resolve('Blue Bottle Coffee, a coffee shop chain.');
  }
}

describe('normalizeMerchantName', () => {
  it.each([
    ['SQ *BLUE BOTTLE 0123 OAKLAND CA', 'blue bottle oakland'],
    ['TST* Tartine Bakery', 'tartine bakery'],
    ['AMZN Mktp US*2K4LJ81F2', 'amzn mktp us'],
    ['NETFLIX.COM 866-579-7172 CA', 'netflix'],
    ['POS PURCHASE SAFEWAY #1234', 'safeway'],
    ['Walmart200015852668460', 'walmart'],
    ['7-Eleven 34712', 'eleven'],
    ['Möge Tee', 'moge tee'],
    ['', ''],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizeMerchantName(raw)).toBe(expected);
  });

  it('treats a truncated or location-suffixed name as the same merchant', () => {
    expect(merchantSimilarity('blue bottle', 'blue bottle oakland')).toBeGreaterThanOrEqual(0.92);
    expect(merchantSimilarity('safeway', 'netflix')).toBeLessThan(0.92);
  });
});

describe('TransactionContextProvider', () => {
  const categoryGroups = G.createSampleCategoryGroups();
  const payees = G.createSamplePayees();

  it('summarizes similar merchants, amount and a monthly recurrence', async () => {
    const provider = new TransactionContextProvider('#actual-ai', true);
    provider.setHistory([
      tx('h1', -1599, 'NETFLIX.COM 866-579-7172 CA', '2026-07-03', G.CATEGORY_TRAVEL),
      tx('h2', -1599, 'NETFLIX.COM 866-579-7172 CA', '2026-08-03', G.CATEGORY_TRAVEL),
      tx('h3', -1599, 'Netflix.com', '2026-09-02', G.CATEGORY_TRAVEL, '#actual-ai'),
      tx('other', -5000, 'SAFEWAY #1234', '2026-09-05', G.CATEGORY_GROCERIES),
      tx('uncat', -1599, 'NETFLIX.COM', '2026-06-01'),
    ], payees, categoryGroups);

    const { history, merchantInfo } = await provider.getContext(
      tx('new', -1599, 'NETFLIX.COM 866-579-7172 CA', '2026-10-03'),
      payees,
    );

    expect(merchantInfo).toBe('');
    expect(history).toContain('3 previous categorized transaction(s)');
    expect(history).toContain('* 2026-09-02 | Netflix.com | -15.99 | Travel [categorized by AI, not confirmed]');
    expect(history).not.toContain('SAFEWAY');
    expect(history).toContain('This exact amount (15.99) appeared 3 time(s) before, categorized as: Travel.');
    expect(history).toContain('recurring monthly charge of about 15.99');
    expect(history).toContain('Travel 3x (-15.99)');
    expect(history).toContain('this transaction fits that schedule');
  });

  it('flags an unusual amount and shows categories by amount range', async () => {
    const provider = new TransactionContextProvider('#actual-ai', true);
    provider.setHistory([
      tx('a', -4500, 'COSTCO WHSE #0423', '2026-08-01', G.CATEGORY_GROCERIES),
      tx('b', -6200, 'COSTCO WHSE #0423', '2026-08-15', G.CATEGORY_GROCERIES),
      tx('c', -5100, 'COSTCO WHSE #0423', '2026-09-01', G.CATEGORY_GROCERIES),
      tx('d', -89900, 'COSTCO WHSE #0423', '2026-05-01', G.CATEGORY_TRAVEL),
    ], payees, categoryGroups);

    const { history } = await provider.getContext(tx('new', -92000, 'COSTCO WHSE #0423', '2026-10-01'), payees);

    expect(history).toContain('Groceries 3x (-62.00 to -45.00); Travel 1x (-899.00)');
    expect(history).toContain('is unusual for this merchant (typical 56.50); the closest previous amount was 899.00 (Travel)');
  });

  it('compares amounts only against the same direction of money', async () => {
    const provider = new TransactionContextProvider('#actual-ai', true);
    provider.setHistory([
      tx('f1', -2500, 'Interest', '2026-07-01', G.CATEGORY_TRAVEL),
      tx('f2', -3000, 'Interest', '2026-08-01', G.CATEGORY_TRAVEL),
      tx('f3', -5400, 'Interest', '2026-09-01', G.CATEGORY_TRAVEL),
      tx('i1', 61, 'Interest', '2026-07-31', G.CATEGORY_SALARY),
      tx('i2', 58, 'Interest', '2026-08-31', G.CATEGORY_SALARY),
      tx('i3', 66, 'Interest', '2026-09-30', G.CATEGORY_SALARY),
    ], payees, categoryGroups);

    const { history } = await provider.getContext(tx('new', 63, 'Interest', '2026-10-31'), payees);

    expect(history).toContain('Salary 3x (+0.58 to +0.66)');
    expect(history).not.toContain('unusual');
    expect(history).toContain('recurring monthly income of about 0.61');
  });

  it('only looks up merchants with no history', async () => {
    const lookup = new StubLookup();
    const provider = new TransactionContextProvider('#actual-ai', true, lookup);
    provider.setHistory([tx('h', -500, 'SAFEWAY #1', '2026-09-01', G.CATEGORY_GROCERIES)], payees, categoryGroups);

    await provider.getContext(tx('known', -700, 'SAFEWAY #2', '2026-10-01'), payees);
    const unknown = await provider.getContext(tx('new', -650, 'SQ *BLUE BOTTLE 0123', '2026-10-01'), payees);

    expect(lookup.calls).toEqual(['SQ *BLUE BOTTLE 0123']);
    expect(unknown.merchantInfo).toBe('Blue Bottle Coffee, a coffee shop chain.');
  });

  it('renders context into the default prompt', () => {
    const template = fs.readFileSync('./src/templates/prompt.hbs', 'utf8');
    const prompt = new PromptGenerator(template).generate(
      categoryGroups,
      tx('new', -1599, 'NETFLIX.COM', '2026-10-03'),
      payees,
      [],
      { history: 'Netflix & co history', merchantInfo: 'A streaming service.' },
    );
    expect(prompt).toContain('* Amount: 15.99');
    expect(prompt).toContain('A streaming service.');
    expect(prompt).toContain('Netflix & co history');
  });
});

describe('MerchantLookupService', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merchant-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function fakeFetch(content: string) {
    return jest.fn(async () => Promise.resolve(new Response(JSON.stringify({
      choices: [{ message: { content } }],
    }), { status: 200 })));
  }

  it('sends a web search request and caches the answer on disk', async () => {
    const fetchFn = fakeFetch('Blue Bottle Coffee, a specialty coffee roaster and cafe.');
    const cacheFile = path.join(dir, 'cache.json');
    const service = new MerchantLookupService('key', 'model', 'https://openrouter.ai/api/v1/', cacheFile, 1000, fetchFn);

    expect(await service.lookup('SQ *BLUE BOTTLE 0123', '')).toContain('coffee');
    expect(await service.lookup('SQ *BLUE BOTTLE 9999', '')).toContain('coffee');
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(JSON.parse(init.body)).toMatchObject({ model: 'model', plugins: [{ id: 'web' }] });

    const reloaded = new MerchantLookupService('key', 'model', 'x', cacheFile, 1000, fakeFetch('other'));
    expect(await reloaded.lookup('SQ *BLUE BOTTLE 0123', '')).toContain('coffee');
  });

  it('caches UNKNOWN as empty and does not cache failures', async () => {
    const cacheFile = path.join(dir, 'cache.json');
    const unknown = new MerchantLookupService('key', 'm', 'x', cacheFile, 1000, fakeFetch('UNKNOWN'));
    expect(await unknown.lookup('XYZ 123', '')).toBe('');

    const failing = jest.fn(async () => Promise.resolve(new Response('boom', { status: 500 })));
    const service = new MerchantLookupService('key', 'm', 'x', cacheFile, 1000, failing);
    expect(await service.lookup('OTHER MERCHANT', '')).toBe('');
    expect(await service.lookup('OTHER MERCHANT', '')).toBe('');
    expect(failing).toHaveBeenCalledTimes(2);

    const truncated = jest.fn(async () => Promise.resolve(new Response(JSON.stringify({
      choices: [{ finish_reason: 'length', message: { content: null } }],
    }), { status: 200 })));
    const cutOff = new MerchantLookupService('key', 'm', 'x', cacheFile, 1000, truncated);
    expect(await cutOff.lookup('THIRD MERCHANT', '')).toBe('');
    expect(await cutOff.lookup('THIRD MERCHANT', '')).toBe('');
    expect(truncated).toHaveBeenCalledTimes(2);
  });
});
