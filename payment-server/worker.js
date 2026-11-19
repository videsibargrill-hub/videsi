// Videsi Bar & Grill — online payment server (Cloudflare Worker)
// Prices every cart from the website's menu.json (customers can't change prices),
// then opens a Clover Hosted Checkout page so the money goes to Videsi's Clover account.
//
// Settings (Cloudflare → Worker → Settings → Variables):
//   CLOVER_TOKEN   (Secret)  Clover Ecommerce API *private* token — never put this in the website
//   MERCHANT_ID              GVS3J6RNJM581
//   CLOVER_API               https://api.clover.com   (use https://apisandbox.dev.clover.com to test)
//   SITE                     https://videsibarandgrill.com

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
      redirectUrls: {
        success: site + '/order.html?paid=1',
        failure: site + '/order.html?payfail=1',
        cancel: site + '/order.html',
      },
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
