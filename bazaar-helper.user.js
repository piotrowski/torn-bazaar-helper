// ==UserScript==
// @name         Torn Bazaar Helper
// @namespace    torn-bazaar-helper
// @version      1.0.0
// @description  One-click max quantity and auto-pricing for the bazaar Add Items / Manage Items pages.
// @match        https://www.torn.com/bazaar.php*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------- settings

  const DEFAULTS = {
    apiKey: '',
    undercut: 1, // how much below the reference price
    undercutUnit: '$', // '$' or '%'
    mode: 'lowest', // 'lowest' or 'cluster'
    clusterTolerance: 2, // % spread that still counts as "the same price"
    clusterMinListings: 3, // listings needed to call it a cluster...
    clusterMinUnits: 15, // ...or this many items in total (0 = count listings only)
    warnNpc: true, // warn when a price is below what NPC shops pay
    dropWarnPercent: 20, // warn when a new price is this much below the previous one (0 = off)
    cacheMinutes: 30, // how long fetched market prices are reused (0 = always fetch)
    maxCallsPerMinute: 20, // share of Torn's 100 calls/minute this script may use
  };

  const loadSettings = () => ({ ...DEFAULTS, ...GM_getValue('settings', {}) });
  const saveSettings = (s) => GM_setValue('settings', s);
  let settings = loadSettings();

  // ----------------------------------------------------------------- pricing

  // Both the call log and the caches live in Tampermonkey storage, so they
  // survive page reloads and are shared between tabs.

  const WINDOW_MS = 60_000;
  const WARN_AT = 0.8; // show the on-page warning from 80% of the limit

  function recentCalls() {
    const now = Date.now();
    return GM_getValue('calls', []).filter((t) => now - t < WINDOW_MS);
  }

  // Records one API call, or throws if this minute's allowance is used up.
  function reserveCall() {
    const calls = recentCalls();
    const max = settings.maxCallsPerMinute;
    if (calls.length >= max) {
      const wait = Math.ceil((WINDOW_MS - (Date.now() - calls[0])) / 1000);
      updateLimitBanner();
      throw new Error(`API call limit reached (${max} per minute). Try again in ${wait}s.`);
    }
    calls.push(Date.now());
    GM_setValue('calls', calls);
    updateLimitBanner();
  }

  function cacheGet(store, itemId, maxAgeMs) {
    const hit = GM_getValue(store, {})[itemId];
    return hit && Date.now() - hit.time < maxAgeMs ? hit : null;
  }

  function cacheSet(store, itemId, value, maxAgeMs) {
    const now = Date.now();
    const all = GM_getValue(store, {});
    for (const id of Object.keys(all)) if (now - all[id].time >= maxAgeMs) delete all[id];
    all[itemId] = { time: now, value };
    GM_setValue(store, all);
  }

  async function apiGet(path) {
    reserveCall();
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: `https://api.torn.com/v2/${path}?key=${encodeURIComponent(settings.apiKey)}&comment=BazaarHelper`,
        timeout: 15_000,
        onload: (res) => {
          let data;
          try {
            data = JSON.parse(res.responseText);
          } catch {
            return reject(new Error('Bad response from the Torn API'));
          }
          if (data.error) return reject(new Error(`API error: ${data.error.error}`));
          resolve(data);
        },
        onerror: () => reject(new Error('Network error calling the Torn API')),
        ontimeout: () => reject(new Error('Torn API timed out')),
      });
    });
  }

  // Returns { listings, cachedAt } where cachedAt is null for a fresh fetch.
  async function fetchListings(itemId, forceRefresh = false) {
    const maxAge = settings.cacheMinutes * 60_000;
    const hit = !forceRefresh && cacheGet('priceCache', itemId, maxAge);
    if (hit) return { listings: hit.value, cachedAt: hit.time };

    const data = await apiGet(`market/${itemId}/itemmarket`);
    const listings = (data.itemmarket?.listings ?? [])
      .map((l) => ({ price: Number(l.price), amount: Number(l.amount) || 1 }))
      .filter((l) => l.price > 0)
      .sort((a, b) => a.price - b.price)
      .slice(0, 50);
    if (maxAge > 0) cacheSet('priceCache', itemId, listings, maxAge);
    return { listings, cachedAt: null };
  }

  // What NPC shops pay for the item (0 if they do not buy it). These prices
  // do not move, so they are remembered for a day.
  const NPC_CACHE_MS = 24 * 60 * 60_000;
  const npcInFlight = new Map(); // itemId -> Promise<number>

  function fetchNpcSellPrice(itemId) {
    const hit = cacheGet('npcCache', itemId, NPC_CACHE_MS);
    if (hit) return Promise.resolve(hit.value);
    if (!npcInFlight.has(itemId)) {
      const p = apiGet(`torn/${itemId}/items`)
        .then((data) => {
          const items = Array.isArray(data.items) ? data.items : Object.values(data.items ?? {});
          const it = items.find((i) => Number(i.id) === itemId) ?? items[0];
          const price = Number(it?.value?.sell_price ?? it?.sell_price) || 0;
          cacheSet('npcCache', itemId, price, NPC_CACHE_MS);
          return price;
        })
        .finally(() => npcInFlight.delete(itemId));
      npcInFlight.set(itemId, p);
    }
    return npcInFlight.get(itemId);
  }

  // <pricing> (tests/load-pricing.mjs extracts everything up to </pricing>; keep it self-contained)
  // Returns { base, price, note } or throws.
  function computePrice(listings, s) {
    if (!listings.length) throw new Error('No item market listings for this item');

    let base = listings[0].price;
    let note = 'lowest';

    if (s.mode === 'cluster') {
      const tol = 1 + Math.max(0, Number(s.clusterTolerance)) / 100;
      const need = Math.max(2, Number(s.clusterMinListings));
      const needUnits = Math.max(0, Number(s.clusterMinUnits) || 0); // 0 = ignore amounts
      let found = false;
      // A cluster is a group of listings within the tolerance of its cheapest
      // one that has enough listings, or enough items in total.
      for (let i = 0; i < listings.length && !found; i++) {
        const limit = listings[i].price * tol;
        let count = 0;
        let units = 0;
        for (let j = i; j < listings.length && listings[j].price <= limit; j++) {
          count++;
          units += listings[j].amount || 1;
        }
        if (count >= need || (needUnits > 0 && units >= needUnits)) {
          base = listings[i].price;
          note = `cluster of ${count} listing${count === 1 ? '' : 's'}, ${units.toLocaleString('en-US')} items`;
          found = true;
        }
      }
      if (!found) note = 'no cluster, used lowest';
    }

    const cut = Math.max(0, Number(s.undercut) || 0);
    const raw = s.undercutUnit === '%' ? base * (1 - cut / 100) : base - cut;
    return { base, price: Math.max(1, Math.floor(raw)), note };
  }
  // </pricing>

  // --------------------------------------------------------------------- DOM

  const fmt = (n) => '$' + Number(n).toLocaleString('en-US');

  const parsePrice = (input) => Number(input.value.replace(/[^\d]/g, ''));

  // How far newPrice is below oldPrice, in percent, if that reaches the
  // configured threshold; otherwise 0.
  function bigDrop(oldPrice, newPrice) {
    const limit = Number(settings.dropWarnPercent);
    if (!(limit > 0) || !(oldPrice > 0) || !(newPrice > 0) || newPrice >= oldPrice) return 0;
    const pct = (1 - newPrice / oldPrice) * 100;
    return pct >= limit ? pct : 0;
  }

  // Set a value so that both React and Torn's jQuery money input notice it.
  let scriptFilling = false;
  function setInputValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    scriptFilling = true;
    try {
      setter.call(input, String(value));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } finally {
      scriptFilling = false;
    }
  }

  const ITEM_IMG = 'img[src*="/images/items/"], img[srcset*="/images/items/"]';
  const PRICE_INPUT = 'input.input-money:not([type="hidden"])';

  // Walk up from a price input to the item row: the nearest ancestor holding
  // an item image. Bail out if we climb into something holding several price
  // inputs, because then the image could belong to a different item.
  function findRow(priceInput) {
    let el = priceInput.parentElement;
    for (let i = 0; i < 10 && el && el !== document.body; i++, el = el.parentElement) {
      if (el.querySelectorAll(PRICE_INPUT).length > 1) return null;
      if (el.querySelector(ITEM_IMG)) return el;
    }
    return null;
  }

  function getItemId(row) {
    const img = row.querySelector(ITEM_IMG);
    const src = (img?.getAttribute('src') || '') + ' ' + (img?.getAttribute('srcset') || '');
    const m = src.match(/\/images\/items\/(\d+)\//);
    return m ? Number(m[1]) : null;
  }

  // Owned quantity is shown as "Item Name x12"; a single item has no suffix.
  function getOwnedQuantity(row) {
    const nameEl = row.querySelector('.name-wrap, [class*="name"]') || row;
    const m = nameEl.textContent.match(/x\s*([\d,]+)\s*$/) || row.textContent.match(/\bx\s*([\d,]+)/);
    return m ? Number(m[1].replace(/,/g, '')) : 1;
  }

  function findQtyControl(row) {
    const inputs = [...row.querySelectorAll('input')].filter(
      (i) => !i.classList.contains('input-money') && i.type !== 'hidden' && !i.closest('.tbh')
    );
    return {
      text: inputs.find((i) => ['text', 'number', 'tel'].includes(i.type)),
      checkbox: inputs.find((i) => i.type === 'checkbox'),
    };
  }

  function makeButton(label, title, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tbh tbh-btn';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick(b, e);
    });
    return b;
  }

  // Prices one field. Returns { status, message } where status is
  // 'ok', 'drop' (filled, but far below the previous price), 'npc' (not
  // filled: NPC shops pay more) or 'error'. Throws only on API failures.
  async function priceOne(priceInput, forceRefresh) {
    const row = findRow(priceInput);
    const itemId = row && getItemId(row);
    if (!itemId) return { status: 'error', message: 'Could not work out which item this row is' };

    const { listings, cachedAt } = await fetchListings(itemId, forceRefresh);
    const { base, price, note } = computePrice(listings, settings);
    const age = cachedAt ? ` · price from ${Math.max(1, Math.round((Date.now() - cachedAt) / 60_000))} min ago` : '';

    if (settings.warnNpc) {
      const npc = await fetchNpcSellPrice(itemId).catch(() => 0);
      if (price < npc) {
        priceInput.classList.add('tbh-warn');
        return {
          status: 'npc',
          message: `Not priced: ${fmt(price)} is below the ${fmt(npc)} NPC shops pay. Sell it to a shop instead.`,
        };
      }
    }

    const previous = parsePrice(priceInput);
    const drop = bigDrop(previous, price);
    setInputValue(priceInput, price);
    if (drop) {
      priceInput.classList.add('tbh-warn');
      return {
        status: 'drop',
        message: `Warning: ${fmt(price)} is ${Math.round(drop)}% below the previous ${fmt(previous)}. Check before saving.${age}`,
      };
    }
    return { status: 'ok', message: `${fmt(base)} (${note}) → ${fmt(price)}${age}` };
  }

  function requireApiKey() {
    if (settings.apiKey) return true;
    toast('Set your API key first', true);
    openSettings();
    return false;
  }

  async function autoPrice(priceInput, btn, forceRefresh) {
    if (!requireApiKey()) return;
    btn.disabled = true;
    try {
      const { status, message } = await priceOne(priceInput, forceRefresh);
      toast(message, status !== 'ok');
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  // ---- "Update all prices" on Manage Items ----

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ALL_LABEL = 'Update all prices';
  let bulkRunning = false;
  let bulkStop = false;

  // An item can cost two calls (market price + NPC price), so wait until
  // that much of this minute's allowance is free.
  async function waitForApiRoom(btn, progress) {
    const max = settings.maxCallsPerMinute;
    const room = Math.max(0, max - 2);
    while (!bulkStop) {
      const calls = recentCalls();
      if (calls.length === 0 || calls.length <= room) return;
      const wait = Math.ceil((WINDOW_MS - (Date.now() - calls[0])) / 1000);
      btn.textContent = `${progress} · API limit, waiting ${wait}s (click to stop)`;
      await sleep(1000);
    }
  }

  async function updateAllPrices(btn, forceRefresh) {
    if (bulkRunning) {
      bulkStop = true;
      return;
    }
    if (!requireApiKey()) return;
    const inputs = [...document.querySelectorAll(PRICE_INPUT)];
    if (!inputs.length) return toast('No price fields found on this page', true);

    bulkRunning = true;
    bulkStop = false;
    const count = { ok: 0, drop: 0, npc: 0, error: 0 };
    let done = 0;
    let lastError = '';
    try {
      for (const input of inputs) {
        if (bulkStop) break;
        const progress = `Pricing ${done + 1}/${inputs.length}`;
        if (input.isConnected) {
          const itemId = getItemId(findRow(input) || document.createElement('div'));
          const cached = itemId && !forceRefresh && cacheGet('priceCache', itemId, settings.cacheMinutes * 60_000);
          if (!cached) await waitForApiRoom(btn, progress);
          if (bulkStop) break;
          btn.textContent = `${progress} (click to stop)`;
          try {
            const { status, message } = await priceOne(input, forceRefresh);
            count[status]++;
            if (status === 'error') lastError = message;
          } catch (err) {
            count.error++;
            lastError = err.message;
          }
        }
        done++;
      }
    } finally {
      bulkRunning = false;
      btn.textContent = ALL_LABEL;
    }

    const parts = [`${count.ok + count.drop} of ${inputs.length} prices updated`];
    if (bulkStop) parts[0] = `Stopped: ${parts[0]}`;
    if (count.drop) parts.push(`${count.drop} dropped ${settings.dropWarnPercent}% or more`);
    if (count.npc) parts.push(`${count.npc} not priced (NPC shops pay more)`);
    if (count.error) parts.push(`${count.error} failed (${lastError})`);
    const flagged = count.drop + count.npc;
    if (flagged) parts.push('flagged fields are outlined in red');
    toast(parts.join(' · ') + '. Nothing is saved until you press save.', flagged + count.error > 0, 10_000);
  }

  // Runs when a price field changes (typed by hand or filled by the script).
  async function checkNpcPrice(priceInput) {
    priceInput.classList.remove('tbh-warn');
    const price = parsePrice(priceInput);

    // Hand-typed price: compare with what the field held when it got focus.
    if (!scriptFilling) {
      const previous = Number(priceInput.dataset.tbhPrev) || 0;
      const drop = bigDrop(previous, price);
      if (drop) {
        priceInput.classList.add('tbh-warn');
        toast(`Warning: ${fmt(price)} is ${Math.round(drop)}% below the previous ${fmt(previous)}.`, true);
      }
    }

    if (!settings.warnNpc || !settings.apiKey) return;
    const row = findRow(priceInput);
    const itemId = row && getItemId(row);
    if (!price || !itemId) return;

    const npc = await fetchNpcSellPrice(itemId).catch(() => 0);
    if (price < npc && Number(priceInput.value.replace(/[^\d]/g, '')) === price) {
      priceInput.classList.add('tbh-warn');
      toast(`Warning: ${fmt(price)} is below the ${fmt(npc)} NPC shops pay for this item.`, true);
    }
  }

  function fillMaxQuantity(row) {
    const { text, checkbox } = findQtyControl(row);
    if (text) setInputValue(text, getOwnedQuantity(row));
    else if (checkbox && !checkbox.checked) checkbox.click();
    else if (!checkbox) toast('Could not find the quantity field', true);
  }

  function scan() {
    const hash = location.hash;
    const onAdd = hash.includes('add');
    allBtn.style.display = hash.includes('manage') ? '' : 'none';
    if (!onAdd && !hash.includes('manage')) return;

    for (const priceInput of document.querySelectorAll(PRICE_INPUT)) {
      const group = priceInput.closest('.input-money-group');
      const priceHost = group || priceInput.parentElement;
      if (!priceHost.querySelector('.tbh-price')) {
        const btn = makeButton('$', 'Auto price from the item market (Shift+click to ignore remembered prices)', (b, e) =>
          autoPrice(priceInput, b, e.shiftKey)
        );
        btn.classList.add('tbh-price');
        if (group) {
          group.classList.add('tbh-host');
          btn.classList.add('tbh-overlay');
          group.appendChild(btn);
        } else {
          priceInput.insertAdjacentElement('afterend', btn);
        }
      }

      if (!onAdd) continue;
      const row = findRow(priceInput);
      if (!row || row.querySelector('.tbh-qty')) continue;
      const { text, checkbox } = findQtyControl(row);
      const anchor = text || checkbox;
      if (!anchor) continue;
      const btn = makeButton('Max', 'Fill in the maximum quantity', () => fillMaxQuantity(row));
      btn.classList.add('tbh-qty');
      // Checkboxes are usually wrapped in a styled label; sit outside it.
      (text || checkbox.closest('label') || checkbox).insertAdjacentElement('afterend', btn);
    }
  }

  // ---------------------------------------------------------------- UI bits

  GM_addStyle(`
    .tbh-btn {
      font: bold 11px/1 Arial, sans-serif; cursor: pointer;
      height: 20px; min-width: 20px; padding: 0 5px; margin-left: 3px;
      color: #fff; background: #4a7c2f; border: 1px solid #36601f; border-radius: 3px;
      vertical-align: middle;
    }
    .tbh-btn:hover { background: #5a9639; }
    .tbh-btn:disabled { opacity: .5; cursor: wait; }
    .tbh-host { position: relative; }
    .tbh-overlay { position: absolute; right: 3px; top: 50%; transform: translateY(-50%); margin: 0; z-index: 2; }
    input.tbh-warn { outline: 2px solid #d33 !important; outline-offset: -2px; }
    #tbh-panel label.tbh-check { display: flex; align-items: center; gap: 8px; margin-top: 14px; color: #ddd; cursor: pointer; }
    #tbh-panel label.tbh-check input { width: 16px; height: 16px; flex: none; margin: 0; }

    #tbh-dock { position: fixed; left: 10px; bottom: 10px; z-index: 99998; display: flex; gap: 6px; }
    #tbh-dock .tbh-btn { height: 28px; padding: 0 10px; font-size: 12px; margin: 0; }
    #tbh-limit {
      position: fixed; left: 10px; bottom: 44px; z-index: 99998;
      padding: 6px 10px; border-radius: 4px; font: bold 12px Arial, sans-serif;
      color: #1c1c1c; background: #e0a526; border: 1px solid #a87a14;
    }
    #tbh-limit.tbh-full { color: #fff; background: #7a2222; border-color: #a33; }
    #tbh-toast {
      position: fixed; left: 50%; bottom: 50px; transform: translateX(-50%); z-index: 99999;
      padding: 8px 14px; border-radius: 4px; font: 13px Arial, sans-serif;
      color: #fff; background: #2e2e2e; border: 1px solid #555;
      box-shadow: 0 2px 8px rgba(0,0,0,.5); pointer-events: none;
    }
    #tbh-toast.tbh-error { background: #7a2222; border-color: #a33; }

    #tbh-backdrop {
      position: fixed; inset: 0; z-index: 99999; background: rgba(0,0,0,.6);
      display: flex; align-items: center; justify-content: center;
    }
    #tbh-panel {
      width: 320px; max-width: calc(100vw - 32px); box-sizing: border-box; padding: 16px;
      font: 13px Arial, sans-serif; color: #ddd; background: #2e2e2e;
      border: 1px solid #555; border-radius: 6px;
    }
    #tbh-panel h3 { margin: 0 0 12px; font-size: 15px; color: #fff; }
    #tbh-panel label { display: block; margin: 10px 0 4px; color: #aaa; }
    #tbh-panel input, #tbh-panel select {
      box-sizing: border-box; width: 100%; height: 28px; padding: 0 6px;
      color: #eee; background: #1c1c1c; border: 1px solid #555; border-radius: 3px;
    }
    #tbh-panel .tbh-row { display: flex; gap: 6px; }
    #tbh-panel .tbh-row select { width: 70px; flex: none; }
    #tbh-panel .tbh-hint { margin-top: 4px; font-size: 11px; color: #888; }
    #tbh-panel .tbh-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 16px; }
    #tbh-panel .tbh-actions .tbh-btn { height: 28px; padding: 0 12px; font-size: 12px; margin: 0; }
    #tbh-panel .tbh-secondary { background: #555; border-color: #444; }
  `);

  // On-page warning while this script is close to (or at) its API allowance.
  function updateLimitBanner() {
    const used = recentCalls().length;
    const max = settings.maxCallsPerMinute;
    let el = document.getElementById('tbh-limit');
    if (used < Math.max(1, Math.ceil(max * WARN_AT))) {
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.id = 'tbh-limit';
      el.className = 'tbh';
      document.body.appendChild(el);
    }
    const full = used >= max;
    el.classList.toggle('tbh-full', full);
    el.textContent = full
      ? `Bazaar Helper: API limit reached (${used}/${max} this minute). Wait a moment.`
      : `Bazaar Helper: ${used}/${max} API calls used this minute`;
  }

  let toastTimer;
  function toast(message, isError = false, ms = isError ? 5000 : 3000) {
    let el = document.getElementById('tbh-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'tbh-toast';
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.toggle('tbh-error', isError);
    el.style.display = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.style.display = 'none'), ms);
  }

  function openSettings() {
    if (document.getElementById('tbh-backdrop')) return;
    const s = settings;
    const backdrop = document.createElement('div');
    backdrop.id = 'tbh-backdrop';
    backdrop.className = 'tbh';
    backdrop.innerHTML = `
      <div id="tbh-panel">
        <h3>Bazaar Helper</h3>

        <label for="tbh-key">API key</label>
        <input id="tbh-key" type="password" autocomplete="off" spellcheck="false">
        <div class="tbh-hint">A Public access key is enough. Stored only in Tampermonkey.</div>

        <label for="tbh-undercut">Undercut by</label>
        <div class="tbh-row">
          <input id="tbh-undercut" type="number" min="0" step="any">
          <select id="tbh-unit"><option value="$">$</option><option value="%">%</option></select>
        </div>

        <label for="tbh-mode">Reference price</label>
        <select id="tbh-mode">
          <option value="lowest">Lowest listing</option>
          <option value="cluster">Lowest cluster of listings</option>
        </select>

        <div id="tbh-cluster">
          <label for="tbh-min">Cluster: at least this many listings</label>
          <input id="tbh-min" type="number" min="2" step="1">
          <label for="tbh-units">Cluster: or at least this many items in total</label>
          <input id="tbh-units" type="number" min="0" step="1">
          <div class="tbh-hint">A big enough offer counts as a cluster on its own. 0 counts listings only.</div>
          <label for="tbh-tol">Cluster: within this % of each other</label>
          <input id="tbh-tol" type="number" min="0" step="any">
        </div>

        <label class="tbh-check"><input id="tbh-npc" type="checkbox"> Warn when a price is below the NPC shop price</label>

        <label for="tbh-drop">Warn when a new price is lower by at least (%)</label>
        <input id="tbh-drop" type="number" min="0" max="100" step="any">
        <div class="tbh-hint">Compared with the price already in the field. 0 turns this off.</div>

        <label for="tbh-cache">Remember fetched prices for (minutes)</label>
        <input id="tbh-cache" type="number" min="0" step="1">
        <div class="tbh-hint">0 fetches every time. Shift+click a $ button to skip remembered prices once.</div>

        <label for="tbh-calls">API calls per minute, at most</label>
        <input id="tbh-calls" type="number" min="1" max="100" step="1">
        <div class="tbh-hint">Torn allows 100 per minute across all your scripts and keys.</div>

        <div class="tbh-actions">
          <button type="button" class="tbh-btn tbh-secondary" id="tbh-cancel">Cancel</button>
          <button type="button" class="tbh-btn" id="tbh-save">Save</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);

    const $ = (id) => backdrop.querySelector('#' + id);
    $('tbh-key').value = s.apiKey;
    $('tbh-undercut').value = s.undercut;
    $('tbh-unit').value = s.undercutUnit;
    $('tbh-mode').value = s.mode;
    $('tbh-min').value = s.clusterMinListings;
    $('tbh-tol').value = s.clusterTolerance;
    $('tbh-units').value = s.clusterMinUnits;
    $('tbh-npc').checked = s.warnNpc;
    $('tbh-drop').value = s.dropWarnPercent;
    $('tbh-cache').value = s.cacheMinutes;
    $('tbh-calls').value = s.maxCallsPerMinute;

    const syncCluster = () => ($('tbh-cluster').style.display = $('tbh-mode').value === 'cluster' ? '' : 'none');
    $('tbh-mode').addEventListener('change', syncCluster);
    syncCluster();

    const close = () => backdrop.remove();
    backdrop.addEventListener('click', (e) => e.target === backdrop && close());
    $('tbh-cancel').addEventListener('click', close);
    $('tbh-save').addEventListener('click', () => {
      const num = (id, fallback) => {
        const v = parseFloat($(id).value);
        return Number.isFinite(v) && v >= 0 ? v : fallback;
      };
      settings = {
        apiKey: $('tbh-key').value.trim(),
        undercut: num('tbh-undercut', DEFAULTS.undercut),
        undercutUnit: $('tbh-unit').value,
        mode: $('tbh-mode').value,
        clusterMinListings: Math.max(2, Math.round(num('tbh-min', DEFAULTS.clusterMinListings))),
        clusterTolerance: num('tbh-tol', DEFAULTS.clusterTolerance),
        clusterMinUnits: Math.round(num('tbh-units', DEFAULTS.clusterMinUnits)),
        warnNpc: $('tbh-npc').checked,
        dropWarnPercent: Math.min(100, num('tbh-drop', DEFAULTS.dropWarnPercent)),
        cacheMinutes: Math.round(num('tbh-cache', DEFAULTS.cacheMinutes)),
        maxCallsPerMinute: Math.min(100, Math.max(1, Math.round(num('tbh-calls', DEFAULTS.maxCallsPerMinute)))),
      };
      saveSettings(settings);
      updateLimitBanner();
      close();
      toast('Settings saved');
    });
  }

  // -------------------------------------------------------------------- boot

  GM_registerMenuCommand('Bazaar Helper settings', openSettings);

  const dock = document.createElement('div');
  dock.id = 'tbh-dock';
  dock.className = 'tbh';
  const gear = makeButton('⚙ Bazaar Helper', 'Bazaar Helper settings', openSettings);
  const allBtn = makeButton(
    ALL_LABEL,
    'Fill in a new price for every item listed here (Shift+click to ignore remembered prices). You still save yourself.',
    (b, e) => updateAllPrices(b, e.shiftKey)
  );
  allBtn.style.display = 'none';
  dock.append(gear, allBtn);
  document.body.appendChild(dock);

  updateLimitBanner();
  setInterval(updateLimitBanner, 2000); // clears the warning as calls age out

  let queued = false;
  const queueScan = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      scan();
    });
  };
  new MutationObserver(queueScan).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('hashchange', queueScan);
  document.addEventListener('focusin', (e) => {
    if (e.target instanceof HTMLInputElement && e.target.matches(PRICE_INPUT)) e.target.dataset.tbhPrev = parsePrice(e.target);
  });
  document.addEventListener(
    'change',
    (e) => e.target instanceof HTMLInputElement && e.target.matches(PRICE_INPUT) && checkNpcPrice(e.target),
    true
  );
  queueScan();
})();
