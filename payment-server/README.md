# Videsi online payment server

Small Cloudflare Worker (free plan). It opens a Clover Hosted Checkout page for each website order,
and after an approved payment it sends the order to the Clover order (kitchen) printer.

1. Clover Dashboard → Settings → Ecommerce → Ecommerce API Tokens → create a token, type **Hosted Checkout**. Copy the **private** token.
2. Clover Dashboard → Settings → API Tokens → create a REST token with **Orders: read + write** and **Payments: read**.
3. Cloudflare → Workers & Pages → Create Worker → name `videsi-pay` → paste `worker.js` → Deploy.
4. Worker → Settings → Variables:
   - `CLOVER_TOKEN` (Secret) = Hosted Checkout private token
   - `CLOVER_REST_TOKEN` (Secret) = REST token
   - `MERCHANT_ID` = `GVS3J6RNJM581`
   - `SITE` = `https://videsibarandgrill.com`
5. Clover Dashboard → Settings → Ecommerce → Hosted Checkout → Webhook URL = `<worker URL>/webhook`; copy the Signing Secret into `WEBHOOK_SECRET` (Secret).
6. In `order.html` set `PAY_API='<worker URL>'`.

Never put any token or secret in the website files.
