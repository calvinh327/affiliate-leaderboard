# Windmill Affiliate Leaderboard

A small website that shows the affiliate leaderboard with live data from Superfiliate.

- `index.html`: the page affiliates see
- `api/leaderboard.js`: a server function that calls Superfiliate. Your API key stays on the server and is never sent to the browser. Results are cached for 1 hour.

## Deploy on Vercel

1. Put this folder in a GitHub repo (github.com → New repository → "uploading an existing file" → drag in everything in this folder, including the `api` folder).
2. In Vercel, click **Add New → Project**, import that repo and keep the defaults (Framework: Other).
3. Before you deploy, open **Environment Variables** and add:
   - `SF_CLIENT_ID` = your Superfiliate client ID (`sfci1_...`)
   - `SF_CLIENT_SECRET` = your Superfiliate client secret (`sfcs1_...`)
4. Click **Deploy**. Your link will be `https://<project>.vercel.app`.
5. Optional: under **Settings → Domains**, add `leaderboard.windmillair.com` and add the DNS record Vercel shows you.
