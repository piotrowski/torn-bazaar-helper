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

  // cluster mode: enough items for sale around one price (default 15 items within 2%)
  ['cluster skips a thin cheap offer', [{ price: 800, amount: 12 }, { price: 990, amount: 253 }, 994], { mode: 'cluster' }, 989],
  ['one big offer is a cluster on its own', [{ price: 5000, amount: 18 }, { price: 5850, amount: 114 }], { mode: 'cluster' }, 4999],
  ['items are summed across nearby prices', [{ price: 100, amount: 8 }, { price: 101, amount: 8 }, { price: 500, amount: 99 }], { mode: 'cluster' }, 99],
  ['prices outside the tolerance are not summed', [{ price: 100, amount: 8 }, { price: 110, amount: 8 }, { price: 500, amount: 99 }], { mode: 'cluster' }, 499],
  ['a wider tolerance joins nearby prices', [{ price: 100, amount: 8 }, { price: 104, amount: 8 }, { price: 200, amount: 99 }], { mode: 'cluster', clusterTolerance: 5 }, 99],
  ['a narrow tolerance keeps them apart', [{ price: 100, amount: 8 }, { price: 104, amount: 8 }, { price: 200, amount: 99 }], { mode: 'cluster', clusterTolerance: 2 }, 199],
  ['cluster size is configurable', [{ price: 100, amount: 20 }, { price: 500, amount: 60 }], { mode: 'cluster', clusterMinUnits: 50 }, 499],
  ['many single items do not make a cluster', [100, 100, 100, { price: 500, amount: 40 }], { mode: 'cluster' }, 499],
  ['no cluster falls back to the lowest price', [100, 200, 300], { mode: 'cluster' }, 99],
];

for (const [name, listings, settings, expected] of CASES) {
  test(name, () => assert.equal(price(listings, settings), expected));
}

test('no listings is an error', () => {
  assert.throws(() => computePrice([], DEFAULT_SETTINGS), /No item market listings/);
});

test('Stingray Plushie snapshot: the 18 items at $5,000 are a cluster', () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/618-stingray-plushie.json', import.meta.url), 'utf8'));
  assert.equal(price(fx.listings, { mode: 'cluster', clusterMinUnits: 15, clusterTolerance: 5 }), 4999);
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
