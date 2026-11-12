// Prints what the script would set for every saved fixture.
// Settings come from the environment (the Makefile passes them):
//   CLUSTER_UNITS (default 15), CLUSTER_PCT (default 5), UNDERCUT (default 1), UNDERCUT_UNIT ($ or %, default $)
import { readdirSync, readFileSync } from 'node:fs';
import { computePrice } from './load-pricing.mjs';

const pct = Number(process.env.CLUSTER_PCT || 5);
const units = Number(process.env.CLUSTER_UNITS || 15);
const undercut = Number(process.env.UNDERCUT || 1);
const unit = process.env.UNDERCUT_UNIT === '%' ? '%' : '$';
const base = { undercut, undercutUnit: unit, clusterMinUnits: units, clusterTolerance: pct };

const dir = new URL('./fixtures/', import.meta.url);
const fixtures = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8')))
  .sort((a, b) => a.item.name.localeCompare(b.item.name));

const num = (n) => n.toLocaleString('en-US');
const clusterHead = 'Cluster';
const rule = `at least ${num(units)} items within ${pct}%`;

const rows = fixtures.map((fx) => {
  const lowest = computePrice(fx.listings, { ...base, mode: 'lowest' });
  const cluster = computePrice(fx.listings, { ...base, mode: 'cluster' });
  return [
    fx.item.name,
    fx.listings.slice(0, 5).map((l) => (l.amount > 1 ? `${num(l.price)} (x${num(l.amount)})` : num(l.price))).join(' · '),
    num(lowest.price),
    num(cluster.price),
    cluster.price === lowest.price ? (cluster.note.startsWith('no cluster') ? 'no cluster' : '') : cluster.note,
  ];
});

const head = ['Item', 'Cheapest prices (items for sale)', 'Lowest', clusterHead, 'Note'];
const rightAligned = [false, false, true, true, false];
const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const line = (cells) =>
  cells.map((c, i) => (rightAligned[i] ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  ').trimEnd();

console.log(`\nPrices the script would set, ${fixtures.length} items`);
console.log(`Cluster rule: ${rule}. Undercut: ${unit === '$' ? '$' + num(undercut) : undercut + '%'}.\n`);
console.log(line(head));
console.log(widths.map((w) => '-'.repeat(w)).join('  '));
for (const r of rows) console.log(line(r));

const differ = rows.filter((r) => r[2] !== r[3]).length;
console.log(`\nCluster price differs from lowest for ${differ} of ${rows.length} items.`);
