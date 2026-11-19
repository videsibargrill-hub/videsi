# Videsi online payment server

Small Cloudflare Worker (free plan) that opens a Clover Hosted Checkout page for each website order.

1. Clover Dashboard → Settings → Ecommerce → Ecommerce API Tokens → create a token, integration type **Hosted Checkout**. Copy the **private** token.
2. Cloudflare → Workers & Pages → Create Worker → name it `videsi-pay` → paste `worker.js` → Deploy.
3. Worker → Settings → Variables: add `CLOVER_TOKEN` (type Secret) = private token, `MERCHANT_ID` = `GVS3J6RNJM581`, `SITE` = `https://videsibarandgrill.com`.
4. Put the worker URL in `order.html` → `PAY_API='https://videsi-pay.<account>.workers.dev'`.

Never put the private token in the website files.
