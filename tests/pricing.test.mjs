// Run with:  node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { computePrice, DEFAULT_SETTINGS, toListings } from './load-pricing.mjs';

const price = (prices, settings) => computePrice(toListings(prices), { ...DEFAULT_SETTINGS, ...settings }).price;

// ---- hand-written cases: [name, listings, settings, expected price] ----
const CASES = [
  ['lowest listing, $1 undercut', [839000, 839500, 845000], {}, 838999],
  ['lowest listing, no undercut', [839000, 839500], { undercut: 0 }, 839000],
  ['lowest listing, 5% undercut', [1000, 1200], { undercut: 5, undercutUnit: '%' }, 950],
  ['percent undercut rounds down', [999], { undercut: 1, undercutUnit: '%' }, 989],
  ['never goes below $1', [1, 5], { undercut: 10 }, 1],
  ['unsorted input is handled', [845000, 839000, 839500], {}, 838999],

  ['cluster skips a lone cheap listing', [11800, 12950, 12990, 13000, 13000], { mode: 'cluster' }, 12949],
  ['cluster at the very bottom is used', [100, 101, 102, 500], { mode: 'cluster' }, 99],
  ['cluster needs the configured number of listings', [100, 101, 500, 501, 502, 503], { mode: 'cluster', clusterMinListings: 4 }, 499],
  ['cluster tolerance is measured from its lowest listing', [100, 104, 108, 200], { mode: 'cluster', clusterTolerance: 5 }, 99],
  ['no cluster falls back to the lowest listing', [100, 200, 300], { mode: 'cluster' }, 99],
  [
    'reported case: no 3 listings within 5%, falls back to lowest',
    [14021, 15340, 15345, 1630, 16300, 16369],
    { mode: 'cluster', clusterTolerance: 5, clusterMinListings: 3 },
    1629,
  ],

  // item-count rule: enough items in total also makes a cluster
  ['one big offer counts as a cluster', [{ price: 5000, amount: 18 }, 5850, 5850, 5850], { mode: 'cluster', clusterMinUnits: 15 }, 4999],
  ['a thin lone offer is still skipped', [{ price: 800, amount: 12 }, 990, 990, 994], { mode: 'cluster', clusterMinUnits: 15 }, 989],
  [
    'items are summed across offers within the tolerance',
    [{ price: 100, amount: 8 }, { price: 101, amount: 8 }, 500, 501, 502],
    { mode: 'cluster', clusterMinUnits: 15 },
    99,
  ],
  ['item count of 0 means listings only', [{ price: 5000, amount: 999 }, 5850, 5850, 5850], { mode: 'cluster', clusterMinUnits: 0 }, 5849],
];

for (const [name, listings, settings, expected] of CASES) {
  test(name, () => assert.equal(price(listings, settings), expected));
}

test('no listings is an error', () => {
  assert.throws(() => computePrice([], DEFAULT_SETTINGS), /No item market listings/);
});

test('Stingray Plushie snapshot: the 18 items at $5,000 count as a cluster', () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/618-stingray-plushie.json', import.meta.url), 'utf8'));
  const s = { mode: 'cluster', clusterMinListings: 3, clusterMinUnits: 15, clusterTolerance: 5 };
  assert.equal(price(fx.listings, s), 4999);
});

// ---- real item market snapshots saved by tests/fetch-market.mjs ----
const fixtureDir = new URL('./fixtures/', import.meta.url);
let files = [];
try {
  files = readdirSync(fixtureDir).filter((f) => f.endsWith('.json'));
} catch {
  // no fixtures yet
}

for (const file of files) {
  const fx = JSON.parse(readFileSync(new URL(file, fixtureDir), 'utf8'));
  for (const c of fx.cases) {
    test(`${fx.item.name} (${file}): ${c.name}`, () => {
      assert.equal(price(fx.listings, c.settings), c.expected);
    });
  }
}
