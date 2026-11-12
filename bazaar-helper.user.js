// ==UserScript==
// @name         Torn Bazaar Helper
// @namespace    torn-bazaar-helper
// @version      1.1.0
// @description  One-click max quantity and auto-pricing for the bazaar Add Items / Manage Items pages.
// @author       xDevil2 [4501067]
// @license      GPL-3.0-only
// @homepageURL  https://github.com/piotrowski/torn-bazaar-helper
// @supportURL   https://github.com/piotrowski/torn-bazaar-helper/issues
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
    clusterMinUnits: 15, // items needed around one price to call it a cluster
    warnNpc: true, // warn when a price is below what NPC shops pay
    dropWarnPercent: 20, // warn when a new price is this much below the previous one (0 = off)
    cacheMinutes: 30, // how long fetched market prices are reused (0 = always fetch)
    showMvButton: true, // show the "Show above MV" button
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

  // Returns { listings, dataTime }. dataTime is when Torn took the market
  // snapshot (ms). Torn only refreshes it about once an hour, so the data
  // can be old even when it was fetched a second ago.
  async function fetchListings(itemId, forceRefresh = false) {
    const maxAge = settings.cacheMinutes * 60_000;
    const hit = !forceRefresh && cacheGet('priceCache', itemId, maxAge);
    if (hit) {
      // Entries saved by older versions were a bare array of listings.
      return Array.isArray(hit.value) ? { listings: hit.value, dataTime: hit.time } : hit.value;
    }

    const data = await apiGet(`market/${itemId}/itemmarket`);
    const listings = (data.itemmarket?.listings ?? [])
      .map((l) => ({ price: Number(l.price), amount: Number(l.amount) || 1 }))
      .filter((l) => l.price > 0)
      .sort((a, b) => a.price - b.price)
      .slice(0, 50);
    const result = { listings, dataTime: Number(data.itemmarket?.cache_timestamp) * 1000 || Date.now() };
    if (maxAge > 0) cacheSet('priceCache', itemId, result, maxAge);
    return result;
  }

  // Item facts from Torn: what NPC shops pay (sell, 0 if they do not buy it)
  // and the market value (mv). One call can cover many items. Remembered for
  // six hours, since market value only changes daily.
  const INFO_CACHE_MS = 6 * 60 * 60_000;

  // Returns Map<itemId, { sell, mv }>.
  async function fetchItemInfos(ids) {
    const out = new Map();
    const missing = [];
    for (const id of new Set(ids)) {
      const hit = cacheGet('itemInfoCache', id, INFO_CACHE_MS);
      if (hit) out.set(id, hit.value);
      else missing.push(id);
    }
    for (let i = 0; i < missing.length; i += 50) {
      const data = await apiGet(`torn/${missing.slice(i, i + 50).join(',')}/items`);
      const items = Array.isArray(data.items) ? data.items : Object.values(data.items ?? {});
      for (const it of items) {
        const info = { sell: Number(it?.value?.sell_price) || 0, mv: Number(it?.value?.market_price) || 0 };
        cacheSet('itemInfoCache', Number(it.id), info, INFO_CACHE_MS);
        out.set(Number(it.id), info);
      }
    }
    return out;
  }

  const fetchNpcSellPrice = (itemId) => fetchItemInfos([itemId]).then((m) => m.get(itemId)?.sell ?? 0);

  // <pricing> (tests/load-pricing.mjs extracts everything up to </pricing>; keep it self-contained)
  // Returns { base, price, note } or throws.
  function computePrice(listings, s) {
    if (!listings.length) throw new Error('No item market listings for this item');

    let base = listings[0].price;
    let note = 'lowest';

    if (s.mode === 'cluster') {
      const tol = 1 + Math.max(0, Number(s.clusterTolerance)) / 100;
      const needUnits = Math.max(1, Number(s.clusterMinUnits) || 1);
      let found = false;
      // A cluster is the first price where the items for sale within the
      // tolerance of that price add up to at least needUnits.
      for (let i = 0; i < listings.length && !found; i++) {
        const limit = listings[i].price * tol;
        let units = 0;
        for (let j = i; j < listings.length && listings[j].price <= limit; j++) units += listings[j].amount || 1;
        if (units >= needUnits) {
          base = listings[i].price;
          note = `cluster of ${units.toLocaleString('en-US')} items`;
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

  // Field colours. Torn removes rows from the page as you scroll and builds
  // them again later, which would lose a class set on the input. So the
  // colour is remembered per item here and put back by scan().
  const MARK_CLASSES = ['tbh-warn', 'tbh-up', 'tbh-down'];
  const marks = new Map(); // itemId -> one of MARK_CLASSES

  const itemIdOf = (priceInput) => {
    const row = findRow(priceInput);
    return row ? getItemId(row) : null;
  };

  function paintMark(priceInput, mark) {
    for (const c of MARK_CLASSES) priceInput.classList.toggle(c, c === mark);
  }

  function setMark(priceInput, mark) {
    paintMark(priceInput, mark);
    const itemId = itemIdOf(priceInput);
    if (!itemId) return;
    if (mark) marks.set(itemId, mark);
    else marks.delete(itemId);
  }

  // Prices one field. Returns { status, message } where status is
  // 'ok', 'drop' (filled, but far below the previous price), 'npc' (not
  // filled: NPC shops pay more) or 'error'. An 'ok' result also says whether the
  // price went 'up' or 'down'. Throws only on API failures.
  async function priceOne(priceInput, forceRefresh) {
    const row = findRow(priceInput);
    const itemId = row && getItemId(row);
    if (!itemId) return { status: 'error', message: 'Could not work out which item this row is' };

    const { listings, dataTime } = await fetchListings(itemId, forceRefresh);
    const { base, price, note } = computePrice(listings, settings);
    const ageMin = Math.max(0, Math.round((Date.now() - dataTime) / 60_000));
    const age = ` · market data from ${ageMin} min ago`;

    if (settings.warnNpc) {
      const npc = await fetchNpcSellPrice(itemId).catch(() => 0);
      if (price < npc) {
        setMark(priceInput, 'tbh-warn');
        return {
          status: 'npc',
          ageMin,
          message: `Not priced: ${fmt(price)} is below the ${fmt(npc)} NPC shops pay. Sell it to a shop instead.${age}`,
        };
      }
    }

    const previous = parsePrice(priceInput);
    const drop = bigDrop(previous, price);
    setInputValue(priceInput, price);
    if (drop) {
      setMark(priceInput, 'tbh-warn');
      return {
        status: 'drop',
        ageMin,
        message: `Warning: ${fmt(price)} is ${Math.round(drop)}% below the previous ${fmt(previous)}. Check before saving.${age}`,
      };
    }
    // Colour by direction; a big drop has its red outline instead.
    const direction = previous > 0 && price !== previous ? (price > previous ? 'up' : 'down') : null;
    if (direction) setMark(priceInput, direction === 'up' ? 'tbh-up' : 'tbh-down');
    return { status: 'ok', direction, ageMin, message: `${fmt(base)} (${note}) → ${fmt(price)}${age}` };
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
    const count = { ok: 0, drop: 0, npc: 0, error: 0, up: 0, down: 0 };
    let oldestMin = 0;
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
            const r = await priceOne(input, forceRefresh);
            count[r.status]++;
            if (r.status === 'error') lastError = r.message;
            if (r.ageMin > oldestMin) oldestMin = r.ageMin;
            if (r.direction) count[r.direction]++;
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
    if (count.up) parts.push(`${count.up} went up (green)`);
    if (count.down) parts.push(`${count.down} went down (orange)`);
    if (count.drop) parts.push(`${count.drop} dropped ${settings.dropWarnPercent}% or more (red)`);
    if (count.npc) parts.push(`${count.npc} not priced, NPC shops pay more (red)`);
    if (count.error) parts.push(`${count.error} failed (${lastError})`);
    parts.push(`market data up to ${oldestMin} min old`);
    // Stays on screen until clicked.
    toast(parts.join(' · ') + '. Nothing is saved until you press save.', count.drop + count.npc + count.error > 0, 0);
  }

  // ---- "Show above MV": colour prices that are above Torn's market value ----

  const MV_SHOW = 'Show above MV';
  const MV_HIDE = 'Hide above MV';
  let mvShown = false;

  function hideAboveMarketValue(btn) {
    for (const input of document.querySelectorAll(PRICE_INPUT)) {
      input.classList.remove('tbh-mv');
      if (input.title.startsWith('Market value ')) input.title = '';
    }
    mvShown = false;
    btn.textContent = MV_SHOW;
  }

  const mvInfo = new Map(); // itemId -> market value, for rows seen while the blue is showing
  let mvBusy = false;

  // Colours every loaded price field. Called again by scan() while the blue
  // is showing, so rows that appear on scroll get coloured too.
  // Returns { above, total } or null if another run is in progress.
  async function paintAboveMarketValue() {
    if (mvBusy) return null;
    mvBusy = true;
    try {
      const rows = [];
      for (const input of document.querySelectorAll(PRICE_INPUT)) {
        const itemId = itemIdOf(input);
        if (itemId) rows.push({ input, itemId });
      }
      const unknown = [...new Set(rows.map((r) => r.itemId).filter((id) => !mvInfo.has(id)))];
      if (unknown.length) {
        const infos = await fetchItemInfos(unknown);
        for (const id of unknown) mvInfo.set(id, infos.get(id)?.mv || 0);
      }
      let above = 0;
      let total = 0;
      for (const { input, itemId } of rows) {
        const price = parsePrice(input);
        const mv = mvInfo.get(itemId);
        const isAbove = Boolean(price && mv && price > mv);
        input.classList.toggle('tbh-mv', isAbove);
        if (!price || !mv) continue;
        total++;
        if (isAbove) above++;
        const diff = Math.round((price / mv - 1) * 100);
        input.title = `Market value ${fmt(mv)}; this price is ${Math.abs(diff)}% ${diff >= 0 ? 'above' : 'below'} it`;
      }
      return { above, total };
    } finally {
      mvBusy = false;
    }
  }

  async function showAboveMarketValue(btn) {
    if (mvShown) return hideAboveMarketValue(btn);
    if (!requireApiKey()) return;
    btn.disabled = true;
    try {
      const result = await paintAboveMarketValue();
      if (!result) return;
      if (!result.total) return toast('No prices filled in on this page', true);
      mvShown = true;
      btn.textContent = MV_HIDE;
      toast(
        `${result.above} of ${result.total} prices on screen are above market value (shown in blue). Hover a price to see its market value.`,
        false,
        6000
      );
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  // Runs when a price field changes (typed by hand or filled by the script).
  async function checkNpcPrice(priceInput) {
    setMark(priceInput, null);
    priceInput.classList.remove('tbh-mv');
    const price = parsePrice(priceInput);

    // Hand-typed price: compare with what the field held when it got focus.
    if (!scriptFilling) {
      const previous = Number(priceInput.dataset.tbhPrev) || 0;
      const drop = bigDrop(previous, price);
      if (drop) {
        setMark(priceInput, 'tbh-warn');
        toast(`Warning: ${fmt(price)} is ${Math.round(drop)}% below the previous ${fmt(previous)}.`, true);
      }
    }

    if (!settings.warnNpc || !settings.apiKey) return;
    const row = findRow(priceInput);
    const itemId = row && getItemId(row);
    if (!price || !itemId) return;

    const npc = await fetchNpcSellPrice(itemId).catch(() => 0);
    if (price < npc && Number(priceInput.value.replace(/[^\d]/g, '')) === price) {
      setMark(priceInput, 'tbh-warn');
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
    mvBtn.style.display = settings.showMvButton && (onAdd || hash.includes('manage')) ? '' : 'none';
    if (mvShown) paintAboveMarketValue().catch(() => {}); // colour rows that appeared on scroll
    if (!onAdd && !hash.includes('manage')) return;

    for (const priceInput of document.querySelectorAll(PRICE_INPUT)) {
      if (marks.size) paintMark(priceInput, marks.get(itemIdOf(priceInput)) || null);
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
    input.tbh-up { background: #c9efc0 !important; color: #111 !important; }
    input.tbh-down { background: #ffd9a8 !important; color: #111 !important; }
    input.tbh-mv { background: #bcdcff !important; color: #111 !important; }
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
    #tbh-toast.tbh-sticky { pointer-events: auto; cursor: pointer; max-width: min(700px, calc(100vw - 32px)); }
    #tbh-toast.tbh-error { background: #7a2222; border-color: #a33; }

    #tbh-backdrop {
      position: fixed; inset: 0; z-index: 99999; background: rgba(0,0,0,.6);
      display: flex; align-items: center; justify-content: center;
    }
    #tbh-panel {
      width: 352px; max-width: calc(100vw - 32px); box-sizing: border-box; padding: 16px;
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
    #tbh-panel .tbh-advanced { margin-top: 14px; padding-top: 10px; border-top: 1px solid #444; }
    #tbh-panel .tbh-advanced summary { cursor: pointer; color: #ddd; font-weight: bold; user-select: none; }
    #tbh-panel .tbh-credit { margin-top: 12px; padding-top: 10px; border-top: 1px solid #444; font-size: 11px; color: #888; text-align: center; }
    #tbh-panel .tbh-credit a { color: #8fc46a; text-decoration: none; }
    #tbh-panel .tbh-credit a:hover { text-decoration: underline; }
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
  // ms = 0 keeps the message on screen until it is clicked.
  function toast(message, isError = false, ms = isError ? 5000 : 3000) {
    let el = document.getElementById('tbh-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'tbh-toast';
      el.addEventListener('click', () => (el.style.display = 'none'));
      document.body.appendChild(el);
    }
    const sticky = ms === 0;
    el.textContent = sticky ? `${message} (click to close)` : message;
    el.classList.toggle('tbh-error', isError);
    el.classList.toggle('tbh-sticky', sticky);
    el.style.display = '';
    clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(() => (el.style.display = 'none'), ms);
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
          <option value="lowest">Lowest price</option>
          <option value="cluster">Lowest cluster of items</option>
        </select>

        <div id="tbh-cluster">
          <label for="tbh-units">Cluster: at least this many items</label>
          <input id="tbh-units" type="number" min="1" step="1">
          <label for="tbh-tol">Cluster: priced within this % of each other</label>
          <input id="tbh-tol" type="number" min="0" step="any">
        </div>

        <label class="tbh-check"><input id="tbh-npc" type="checkbox"> Warn when a price is below the NPC shop price</label>

        <details class="tbh-advanced">
        <summary>Advanced settings</summary>
        <label for="tbh-drop">Warn when a new price is lower by at least (%)</label>
        <input id="tbh-drop" type="number" min="0" max="100" step="any">
        <div class="tbh-hint">Compared with the price already in the field. 0 turns this off.</div>

        <label for="tbh-cache">Remember fetched prices for (minutes)</label>
        <input id="tbh-cache" type="number" min="0" step="1">
        <div class="tbh-hint">0 fetches every time. Shift+click a $ button to skip remembered prices once.</div>

        <label for="tbh-calls">API calls per minute, at most</label>
        <input id="tbh-calls" type="number" min="1" max="100" step="1">
        <div class="tbh-hint">Torn allows 100 per minute across all your scripts and keys.</div>

        <label class="tbh-check"><input id="tbh-mvbtn" type="checkbox"> Show the "Show above MV" button</label>
        </details>

        <div class="tbh-actions">
          <button type="button" class="tbh-btn tbh-secondary" id="tbh-cancel">Cancel</button>
          <button type="button" class="tbh-btn" id="tbh-save">Save</button>
        </div>
        <div class="tbh-credit">Created by <a href="https://www.torn.com/profiles.php?XID=4501067" target="_blank" rel="noopener">xDevil2 [4501067]</a></div>
      </div>`;
    document.body.appendChild(backdrop);

    const $ = (id) => backdrop.querySelector('#' + id);
    $('tbh-key').value = s.apiKey;
    $('tbh-undercut').value = s.undercut;
    $('tbh-unit').value = s.undercutUnit;
    $('tbh-mode').value = s.mode;
    $('tbh-tol').value = s.clusterTolerance;
    $('tbh-units').value = s.clusterMinUnits;
    $('tbh-npc').checked = s.warnNpc;
    $('tbh-drop').value = s.dropWarnPercent;
    $('tbh-cache').value = s.cacheMinutes;
    $('tbh-calls').value = s.maxCallsPerMinute;
    $('tbh-mvbtn').checked = s.showMvButton;

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
        clusterTolerance: num('tbh-tol', DEFAULTS.clusterTolerance),
        clusterMinUnits: Math.max(1, Math.round(num('tbh-units', DEFAULTS.clusterMinUnits))),
        warnNpc: $('tbh-npc').checked,
        dropWarnPercent: Math.min(100, num('tbh-drop', DEFAULTS.dropWarnPercent)),
        cacheMinutes: Math.round(num('tbh-cache', DEFAULTS.cacheMinutes)),
        showMvButton: $('tbh-mvbtn').checked,
        maxCallsPerMinute: Math.min(100, Math.max(1, Math.round(num('tbh-calls', DEFAULTS.maxCallsPerMinute)))),
      };
      saveSettings(settings);
      if (!settings.showMvButton && mvShown) hideAboveMarketValue(mvBtn);
      queueScan();
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
  const mvBtn = makeButton(MV_SHOW, 'Colour in blue every price that is above the item\'s market value; click again to remove the colour', (b) =>
    showAboveMarketValue(b)
  );
  mvBtn.style.display = 'none';
  dock.append(gear, allBtn, mvBtn);
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
  window.addEventListener('hashchange', () => {
    // A different bazaar page: the remembered colours no longer apply.
    marks.clear();
    if (mvShown) hideAboveMarketValue(mvBtn);
    queueScan();
  });
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
