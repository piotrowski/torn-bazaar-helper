// Loads computePrice straight out of the userscript, so the tests always run
// the code that ships (no second copy to keep in sync).
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../bazaar-helper.user.js', import.meta.url), 'utf8');
const match = source.match(/\/\/ <pricing>[^\n]*\n([\s\S]*?)\/\/ <\/pricing>/);
if (!match) throw new Error('Could not find the <pricing> block in bazaar-helper.user.js');

export const computePrice = new Function(`${match[1]}; return computePrice;`)();

export const DEFAULT_SETTINGS = {
  undercut: 1,
  undercutUnit: '$',
  mode: 'lowest',
  clusterTolerance: 2,
  clusterMinUnits: 15,
};

// Accepts plain prices or { price, amount } and returns sorted listings.
export const toListings = (prices) =>
  prices.map((p) => (typeof p === 'number' ? { price: p, amount: 1 } : p)).sort((a, b) => a.price - b.price);
