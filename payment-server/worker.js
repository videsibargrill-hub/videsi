// Videsi Bar & Grill — online payment server (Cloudflare Worker)
// Prices every cart from the website's menu.json (customers can't change prices),
// then opens a Clover Hosted Checkout page so the money goes to Videsi's Clover account.
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
  async fetch(req, env) {
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

    const menu = await (await fetch(site + '/menu.json', { cf: { cacheTtl: 300 } })).json();
    const items = Array.isArray(body.items) ? body.items.slice(0, 60) : [];
    const c = body.customer || {};
    const name = String(c.name || '').trim().slice(0, 60);
    const email = String(c.email || '').trim().slice(0, 120);
    const phone = String(c.phone || '').replace(/\D/g, '').slice(-10);
    if (!items.length) return reply({ error: 'Cart is empty' }, 400);
    if (!name || !/^\S+@\S+\.\S+$/.test(email) || phone.length !== 10) return reply({ error: 'Name, email and phone are required' }, 400);

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

    const [first, ...rest] = name.split(/\s+/);
    const payload = {
      customer: { firstName: first, lastName: rest.join(' ') || '-', email, phoneNumber: phone },
      shoppingCart: { lineItems },
      // Return pages (paid / failed / cancel) are set in Clover Dashboard → Hosted checkout
    };

    const r = await fetch((env.CLOVER_API || 'https://api.clover.com') + '/invoicingcheckoutservice/v1/checkouts', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'X-Clover-Merchant-Id': env.MERCHANT_ID,
        Authorization: 'Bearer ' + env.CLOVER_TOKEN,
      },
      body: JSON.stringify(payload),
    });
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
