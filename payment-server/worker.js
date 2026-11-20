// Videsi Bar & Grill — online payment server (Cloudflare Worker)
// Prices every cart from the website's menu.json (customers can't change prices),
// then opens a Clover Hosted Checkout page so the money goes to Videsi's Clover account.
// Pay-in-person orders (mode 'inperson') are created as open Clover orders and printed in the kitchen.
//
// Settings (Cloudflare → Worker → Settings → Variables):
//   CLOVER_TOKEN   (Secret)  Clover Ecommerce API *private* token — never put this in the website
//   MERCHANT_ID              GVS3J6RNJM581
//   CLOVER_API               https://api.clover.com   (use https://apisandbox.dev.clover.com to test)
//   SITE                     https://videsibarandgrill.com
//   CLOVER_REST_TOKEN (Secret) Clover REST API token with Orders read+write and Payments read (for kitchen printing)
//   WEBHOOK_SECRET    (Secret) Hosted Checkout webhook "Signing Secret" from the Clover Dashboard
//
// Kitchen printing: in Clover's Hosted Checkout settings, set the webhook URL to  <this worker URL>/webhook .
// When a payment is approved, the worker finds the Clover order and sends it to the order printer.

const HST = 1300000; // 13% in Clover's rate format (10% = 1000000)

export default {
  async fetch(req, env, ctx) {
    const site = env.SITE || 'https://videsibarandgrill.com';
    const cors = {
      'Access-Control-Allow-Origin': site,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    const reply = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (new URL(req.url).pathname === '/webhook') return webhook(req, env);
    if (req.method !== 'POST') return reply({ error: 'POST only' }, 405);

    let body;
    try { body = await req.json(); } catch { return reply({ error: 'Bad request' }, 400); }
    if (body.mode === 'call') return callServer(body, env, ctx, reply);

    const menu = await (await fetch(site + '/menu.json', { cf: { cacheTtl: 300 } })).json();
    const items = Array.isArray(body.items) ? body.items.slice(0, 60) : [];
    const c = body.customer || {};
    const name = String(c.name || '').trim().slice(0, 60);
    const email = String(c.email || '').trim().slice(0, 120);
    const phone = String(c.phone || '').replace(/\D/g, '').slice(-10);
    if (!items.length) return reply({ error: 'Cart is empty' }, 400);
    const inPerson = body.mode === 'inperson';
    if (!name || phone.length !== 10 || (!inPerson && !/^\S+@\S+\.\S+$/.test(email))) return reply({ error: inPerson ? 'Name and phone are required' : 'Name, email and phone are required' }, 400);

    const pickup = String(c.pickup || 'ASAP').slice(0, 40);
    const notes = String(c.notes || '').slice(0, 200);
    let subtotal = 0;
    const lineItems = [];
    for (const it of items) {
      const price = menu[it.name];
      const qty = Math.max(1, Math.min(50, parseInt(it.q, 10) || 0));
      if (!price) return reply({ error: 'Unknown item: ' + it.name }, 400);
      subtotal += price * qty;
      lineItems.push({ name: it.name, price, unitQty: qty, note: '', taxRates: [{ name: 'HST', rate: HST }] });
    }
    // Pickup details on the first line so the kitchen sees them
    lineItems[0].note = ('PICKUP ' + pickup + ' · ' + name + ' ' + phone + (notes ? ' · ' + notes : '')).slice(0, 255);

    const tipPct = [0, 10, 12, 15, 18].includes(Number(body.tipPct)) ? Number(body.tipPct) : 0;
    const tip = Math.round(subtotal * tipPct / 100);
    if (tip > 0) lineItems.push({ name: 'Tip for the kitchen (' + tipPct + '%)', price: tip, unitQty: 1, note: 'Tip' });

    // Link each line to the real Clover inventory item (printer labels: kitchen / drinks, and item taxes)
    const inv = await cloverItems(env);
    for (const li of lineItems) { const id = li.note === 'Tip' ? null : inv[norm(li.name)]; if (id) li.itemId = id; }

    // ---------- Pay in person (card or cash at pickup): open order in Clover + print in kitchen ----------
    if (inPerson) {
      const how = String(body.payWith || '').toLowerCase().includes('cash') ? 'CASH' : 'CARD';
      const ref = String(body.ref || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 10);
      const api = (env.CLOVER_API || 'https://api.clover.com') + '/v3/merchants/' + env.MERCHANT_ID;
      const auth = { Authorization: 'Bearer ' + env.CLOVER_REST_TOKEN, 'Content-Type': 'application/json' };
      const rates = await (await fetch(api + '/tax_rates', { headers: auth })).json().catch(() => ({}));
      let tax = (rates.elements || []).filter((x) => x.isDefault).map((x) => ({ id: x.id, name: x.name, rate: x.rate }));
      if (!tax.length) tax = (rates.elements || []).filter((x) => /hst/i.test(x.name || '')).map((x) => ({ id: x.id, name: x.name, rate: x.rate }));
      // Dine-in table orders from table QR codes (?table=F3) use the same titles as Clover's floor plan
      const AREAS = { F: 'Front Royal', M: 'Main Shahi Booth', DUO: 'Main Shahi Booth', B: 'Premium Bar', VIP: 'VIP Lounge' };
      const tm = String(body.table || '').toUpperCase().replace(/[^A-Z0-9]/g, '').match(/^(VIP|DUO|F|M|B)(\d{1,2})$/);
      const tableTitle = tm ? (tm[1].length > 1 ? tm[1] + ' ' + tm[2] : tm[1] + tm[2]) + ' - ' + AREAS[tm[1]] : '';
      const head = (tableTitle
        ? 'TABLE ' + tableTitle + ' · DINE-IN · PAY AT TABLE · WEB #' + ref + ' · ' + name + ' ' + phone + (c.offers ? ' · OFFERS OK' : '') + (notes ? ' · ' + notes : '')
        : body.preorder
          ? 'PRE-ORDER · DINE-IN · ARRIVING ' + pickup + ' · PARTY OF ' + (parseInt(body.party, 10) || 2) + ' · PAY ON ARRIVAL · WEB #' + ref + ' · ' + name + ' ' + phone + (c.offers ? ' · OFFERS OK' : '') + (notes ? ' · ' + notes : '')
          : 'WEB #' + ref + ' · PAY IN PERSON (' + how + ') · PICKUP ' + pickup + ' · ' + name + ' ' + phone + (c.offers ? ' · OFFERS OK' : '') + (notes ? ' · ' + notes : '')).slice(0, 255);

      // Save the guest to Clover Customers (find by phone first so repeat guests are not duplicated)
      let custId = null;
      try {
        const found = await (await fetch(api + '/customers?filter=' + encodeURIComponent('phoneNumber=' + phone) + '&limit=1', { headers: auth })).json();
        custId = found && found.elements && found.elements[0] ? found.elements[0].id : null;
        if (!custId) {
          const parts = name.split(/\s+/);
          const okEmail = /^\S+@\S+\.\S+$/.test(email);
          const cr = await fetch(api + '/customers', { method: 'POST', headers: auth, body: JSON.stringify({ firstName: parts[0], lastName: parts.slice(1).join(' '), phoneNumbers: [{ phoneNumber: phone }], emailAddresses: okEmail ? [{ emailAddress: email }] : [], marketingAllowed: !!c.offers }) });
          const cj = await cr.json().catch(() => ({}));
          custId = cj.id || null;
        }
      } catch (e) {}
      // Same table, still open and unpaid in the last 6 hours -> add to that bill (one bill per table)
      let order = null;
      let isNew = false;
      if (tableTitle) {
        try {
          const since = Date.now() - 6 * 3600 * 1000;
          const ol = await (await fetch(api + '/orders?filter=' + encodeURIComponent('createdTime>' + since) + '&limit=100&expand=payments', { headers: auth })).json();
          order = (ol.elements || []).find((o) => o.title === tableTitle && o.state === 'open' && !(o.payments && o.payments.elements && o.payments.elements.length)) || null;
          if (order) await fetch(api + '/orders/' + order.id, { method: 'POST', headers: auth, body: JSON.stringify({ note: ((order.note ? order.note + ' | ' : '') + 'ADDED: ' + head).slice(0, 2000) }) }).catch(() => {});
        } catch (e) {
          order = null;
        }
      }
      if (!order) {
        const or = await fetch(api + '/orders', { method: 'POST', headers: auth, body: JSON.stringify({ state: 'open', title: tableTitle || ((body.preorder ? 'PRE-ORDER ' : 'WEB ') + name).slice(0, 60), note: head, customers: custId ? [{ id: custId }] : undefined }) });
        order = await or.json().catch(() => ({}));
        if (!or.ok || !order.id) return reply({ error: 'Clover order error ' + or.status }, 502);
        isNew = true;
      }
      const bulk = [];
      // Table orders: a $0 'TABLE SETUP' line (drinks label -> front printer) so servers set the table right away
      const setupId = tableTitle ? inv[norm('TABLE SETUP (Server)')] : null;
      if (setupId) {
        const count = lineItems.filter((l) => l.note !== 'Tip').reduce((s, l) => s + l.unitQty, 0);
        bulk.push({ item: { id: setupId }, name: 'TABLE SETUP (Server)', price: 0, note: ((isNew ? 'SET UP ' : 'MORE FOR ') + tableTitle + ' · ' + name + ' · ' + count + ' item(s)').slice(0, 255) });
      }
      lineItems.forEach((li, n) => {
        for (let i = 0; i < li.unitQty; i++) {
          const isTip = li.note === 'Tip';
          const b = { name: li.name, price: li.price, note: n === 0 && i === 0 ? head : '' };
          if (li.itemId) b.item = { id: li.itemId };
          if (!isTip) b.taxRates = tax;
          bulk.push(b);
        }
      });
      let br = await fetch(api + '/orders/' + order.id + '/bulk_line_items', { method: 'POST', headers: auth, body: JSON.stringify({ items: bulk }) });
      if (!br.ok) {
        // Retry without tax links, then one line item at a time
        const plain = bulk.map((b) => (b.item ? { name: b.name, price: b.price, note: b.note, item: b.item } : { name: b.name, price: b.price, note: b.note }));
        br = await fetch(api + '/orders/' + order.id + '/bulk_line_items', { method: 'POST', headers: auth, body: JSON.stringify({ items: plain }) });
        if (!br.ok) {
          let okAll = true;
          for (const p of plain) {
            let one = await fetch(api + '/orders/' + order.id + '/line_items', { method: 'POST', headers: auth, body: JSON.stringify(p.note === 'Tip' || p.price === 0 ? p : { ...p, taxRates: tax }) });
            if (!one.ok) one = await fetch(api + '/orders/' + order.id + '/line_items', { method: 'POST', headers: auth, body: JSON.stringify(p) });
            if (!one.ok && p.item) one = await fetch(api + '/orders/' + order.id + '/line_items', { method: 'POST', headers: auth, body: JSON.stringify({ name: p.name, price: p.price, note: p.note }) });
            if (!one.ok) { okAll = false; br = one; break; }
          }
          if (!okAll) {
            const msg = (await br.text().catch(() => '')).slice(0, 200);
            if (isNew) await fetch(api + '/orders/' + order.id, { method: 'DELETE', headers: auth }).catch(() => {});
            return reply({ error: 'Clover items error ' + br.status + ' ' + msg }, 502);
          }
        }
      }
      const pr = await fetch(api + '/print_event', { method: 'POST', headers: auth, body: JSON.stringify({ orderRef: { id: order.id } }) });
      return reply({ ok: true, orderId: order.id, printed: pr.ok });
    }

    const [first, ...rest] = name.split(/\s+/);
    const plainItems = lineItems.map(({ itemId, ...l }) => l);
    const hcItems = lineItems.map(({ itemId, ...l }) => (itemId ? { ...l, itemRefUuid: itemId } : l));
    const payload = {
      customer: { firstName: first, lastName: rest.join(' ') || '-', email, phoneNumber: phone },
      shoppingCart: { lineItems: hcItems },
      // Return pages (paid / failed / cancel) are set in Clover Dashboard → Hosted checkout
    };

    const send = (p) => fetch((env.CLOVER_API || 'https://api.clover.com') + '/invoicingcheckoutservice/v1/checkouts', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'X-Clover-Merchant-Id': env.MERCHANT_ID,
        Authorization: 'Bearer ' + env.CLOVER_TOKEN,
      },
      body: JSON.stringify(p),
    });
    let r = await send(payload);
    if (!r.ok) r = await send({ ...payload, shoppingCart: { lineItems: plainItems } });
    const out = await r.json().catch(() => ({}));
    if (!r.ok || !out.href) return reply({ error: 'Clover error ' + r.status + (out.message ? ': ' + out.message : '') }, 502);
    return reply({ url: out.href });
  },
};

// ---------- Kitchen printing after an approved online payment ----------
async function webhook(req, env) {
  const raw = await req.text();
  const sig = req.headers.get('Clover-Signature') || '';
  const t = (sig.match(/t=(\d+)/) || [])[1];
  const v1 = (sig.match(/v1=([0-9a-f]+)/) || [])[1];
  if (!t || !v1 || !(await validSig(env.WEBHOOK_SECRET, t + '.' + raw, v1))) return new Response('bad signature', { status: 401 });
  if (Math.abs(Date.now() / 1000 - Number(t)) > 600) return new Response('stale', { status: 401 });

  let ev; try { ev = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }
  const type = ev.type || ev.Type, status = ev.status || ev.Status, paymentId = ev.id || ev.Id;
  if (type !== 'PAYMENT' || status !== 'APPROVED' || !paymentId) return new Response('ignored');

  const api = (env.CLOVER_API || 'https://api.clover.com') + '/v3/merchants/' + env.MERCHANT_ID;
  const auth = { Authorization: 'Bearer ' + env.CLOVER_REST_TOKEN, 'Content-Type': 'application/json' };
  const pay = await (await fetch(api + '/payments/' + paymentId + '?expand=order', { headers: auth })).json().catch(() => ({}));
  const orderId = pay.order && pay.order.id;
  if (!orderId) return new Response('no order on payment', { status: 202 });
  const pr = await fetch(api + '/print_event', { method: 'POST', headers: auth, body: JSON.stringify({ orderRef: { id: orderId } }) });
  return new Response(pr.ok ? 'printed' : 'print failed ' + pr.status, { status: pr.ok ? 200 : 502 });
}

async function validSig(secret, message, expectedHex) {
  if (!secret) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
  const hex = [...mac].map(b => b.toString(16).padStart(2, '0')).join('');
  if (hex.length !== expectedHex.length) return false;
  let diff = 0; for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ expectedHex.charCodeAt(i);
  return diff === 0;
}

// Clover inventory items by name, so web orders use the real items (printer labels + taxes)
async function cloverItems(env) {
  const api = (env.CLOVER_API || 'https://api.clover.com') + '/v3/merchants/' + env.MERCHANT_ID;
  const r = await fetch(api + '/items?limit=1000', { headers: { Authorization: 'Bearer ' + env.CLOVER_REST_TOKEN } }).catch(() => null);
  const j = r && r.ok ? await r.json().catch(() => ({})) : {};
  const map = {};
  for (const it of j.elements || []) map[norm(it.name)] = it.id;
  return map;
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Table code (F3, M2, DUO1, B5, VIP1) -> Clover floor-plan title ("F3 - Front Royal")
function tableTitleOf(raw) {
  const AREAS = { F: 'Front Royal', M: 'Main Shahi Booth', DUO: 'Main Shahi Booth', B: 'Premium Bar', VIP: 'VIP Lounge' };
  const tm = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').match(/^(VIP|DUO|F|M|B)(\d{1,2})$/);
  return tm ? (tm[1].length > 1 ? tm[1] + ' ' + tm[2] : tm[1] + tm[2]) + ' - ' + AREAS[tm[1]] : '';
}

// "Call server" button on the table page: prints a short slip at the front printer, then removes the $0 slip order
async function callServer(body, env, ctx, reply) {
  const tableTitle = tableTitleOf(body.table);
  if (!tableTitle) return reply({ error: 'Unknown table' }, 400);
  const REASONS = { water: 'WATER PLEASE', cutlery: 'CUTLERY / NAPKINS', bill: 'READY FOR THE BILL', help: 'NEEDS HELP' };
  const why = REASONS[body.reason] || 'NEEDS HELP';
  const api = (env.CLOVER_API || 'https://api.clover.com') + '/v3/merchants/' + env.MERCHANT_ID;
  const auth = { Authorization: 'Bearer ' + env.CLOVER_REST_TOKEN, 'Content-Type': 'application/json' };
  const inv = await cloverItems(env);
  const setupId = inv[norm('TABLE SETUP (Server)')];
  const or = await fetch(api + '/orders', { method: 'POST', headers: auth, body: JSON.stringify({ state: 'open', title: 'CALL ' + tableTitle, note: 'CALL SERVER: ' + why + ' · ' + tableTitle }) });
  const o = await or.json().catch(() => ({}));
  if (!or.ok || !o.id) return reply({ error: 'Clover error ' + or.status }, 502);
  const line = { name: 'CALL SERVER', price: 0, note: why + ' · ' + tableTitle };
  if (setupId) line.item = { id: setupId };
  await fetch(api + '/orders/' + o.id + '/line_items', { method: 'POST', headers: auth, body: JSON.stringify(line) });
  const pr = await fetch(api + '/print_event', { method: 'POST', headers: auth, body: JSON.stringify({ orderRef: { id: o.id } }) });
  const cleanup = new Promise((r) => setTimeout(r, 25000)).then(() => fetch(api + '/orders/' + o.id, { method: 'DELETE', headers: auth })).catch(() => {});
  if (ctx && ctx.waitUntil) ctx.waitUntil(cleanup);
  return reply({ ok: true, printed: pr.ok });
}
