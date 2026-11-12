// Saves real item market listings as test fixtures.
//
//   TORN_API_KEY=yourPublicKey node tests/fetch-market.mjs 206 367 180
//
// Each item becomes tests/fixtures/<id>-<name>.json holding the listings and a
// few cases. "expected" is filled in with what the script computes TODAY, so
// read the printed table and correct any expected value that looks wrong:
// the tests then fail until the pricing logic is fixed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { computePrice, DEFAULT_SETTINGS } from './load-pricing.mjs';

const key = process.env.TORN_API_KEY;
const ids = process.argv.slice(2).map(Number).filter(Boolean);
if (!key || !ids.length) {
  console.error('Usage: TORN_API_KEY=yourPublicKey node tests/fetch-market.mjs <itemId> [itemId...]');
  process.exit(1);
}

const CASE_SETTINGS = [
  ['lowest, $1 under', { mode: 'lowest' }],
  ['cluster 3 within 2%, $1 under', { mode: 'cluster', clusterMinListings: 3, clusterTolerance: 2 }],
  ['cluster 3 within 5%, $1 under', { mode: 'cluster', clusterMinListings: 3, clusterTolerance: 5 }],
  ['cluster 3 or 15 items within 5%, $1 under', { mode: 'cluster', clusterMinListings: 3, clusterMinUnits: 15, clusterTolerance: 5 }],
];

const fmt = (n) => '$' + n.toLocaleString('en-US');
const dir = new URL('./fixtures/', import.meta.url);
mkdirSync(dir, { recursive: true });

for (const id of ids) {
  const res = await fetch(`https://api.torn.com/v2/market/${id}/itemmarket?key=${key}&comment=BazaarHelperTests`);
  const data = await res.json();
  if (data.error) {
    console.error(`Item ${id}: API error: ${data.error.error}`);
    continue;
  }
  // Same clean-up the userscript does.
  const listings = (data.itemmarket?.listings ?? [])
    .map((l) => ({ price: Number(l.price), amount: Number(l.amount) || 1 }))
    .filter((l) => l.price > 0)
    .sort((a, b) => a.price - b.price)
    .slice(0, 50);
  if (!listings.length) {
    console.error(`Item ${id}: no listings in the response (keys: ${Object.keys(data.itemmarket ?? data).join(', ')})`);
    continue;
  }

  const name = data.itemmarket?.item?.name ?? `Item ${id}`;
  const cases = CASE_SETTINGS.map(([caseName, s]) => {
    const settings = { ...DEFAULT_SETTINGS, ...s };
    const { price, note } = computePrice(listings, settings);
    return { name: caseName, settings, expected: price, note };
  });

  const file = `${id}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`;
  writeFileSync(
    new URL(file, dir),
    JSON.stringify({ item: { id, name }, fetchedAt: new Date().toISOString(), listings, cases }, null, 2) + '\n'
  );

  console.log(`\n${name} (#${id}) -> tests/fixtures/${file}`);
  console.log('  cheapest listings: ' + listings.slice(0, 12).map((l) => `${fmt(l.price)} x${l.amount}`).join(', '));
  for (const c of cases) console.log(`  ${c.name.padEnd(32)} ${fmt(c.expected).padStart(14)}  (${c.note})`);

  await new Promise((r) => setTimeout(r, 700)); // stay well under the API limit
}
