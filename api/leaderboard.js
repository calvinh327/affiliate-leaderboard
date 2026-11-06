// Serverless function: pulls Superfiliate conversions, ranks affiliates by sales driven.
// "Sales" = order subtotal after discounts, before shipping and tax (Superfiliate's subtotal_value).
// Needs two environment variables in Vercel: SF_CLIENT_ID and SF_CLIENT_SECRET.
// Results are cached at Vercel's edge for 1 hour so the Superfiliate API isn't hit on every view.

const API = 'https://api.superfiliate.com/api/v1';
const TZ = 'America/Los_Angeles';
const START_DATE = '2026-11-01'; // contest start (Pacific time, inclusive)
const END_DATE = '2026-12-31'; // contest end (Pacific time, inclusive)
const EXCLUDE_CUSTOMER_IDS = new Set([967322479]); // affiliates hidden from the board (967322479 = @carl_witness_lee)

const laDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); // YYYY-MM-DD

async function get(path, params, auth) {
  const url = `${API}/${path}?${new URLSearchParams(params)}`;
  for (let i = 0; i < 5; i++) {
    const r = await fetch(url, { headers: { Authorization: auth } });
    if (r.status === 429) { await new Promise((s) => setTimeout(s, 2000)); continue; }
    if (!r.ok) throw new Error(`Superfiliate ${r.status} on ${path}`);
    return r.json();
  }
  throw new Error('Superfiliate rate limit');
}

function displayName(c) {
  if (!c) return 'Affiliate';
  for (const h of [c.instagram_handle, c.tiktok_handle]) if (h && h.trim()) return '@' + h.trim().replace(/^@/, '');
  const fn = (c.first_name || '').split(' - ')[0].trim();
  const ln = (c.last_name || '').trim();
  return (fn + (ln ? ` ${ln[0]}.` : '')).trim() || 'Affiliate';
}

module.exports = async (req, res) => {
  try {
    const { SF_CLIENT_ID, SF_CLIENT_SECRET } = process.env;
    if (!SF_CLIENT_ID || !SF_CLIENT_SECRET) throw new Error('Missing SF_CLIENT_ID / SF_CLIENT_SECRET');
    const auth = `Bearer ${SF_CLIENT_ID}:${SF_CLIENT_SECRET}`;

    const now = new Date();
    const end = '2027-01-02'; // a little past END_DATE so late-night Dec 31 Pacific orders are included
    let convs = [];
    for (let page = 1; page < 200; page++) {
      const batch = await get('conversions', { start_date: START_DATE, end_date: end, include_pending: 'true', items: 250, page }, auth);
      convs = convs.concat(batch);
      if (batch.length < 250) break;
    }

    const orders = convs
      .filter((c) => c.status === 'finished' || c.status === 'pending')
      .map((c) => {
        const t = new Date(c.created_at.replace(' UTC', 'Z').replace(' ', 'T'));
        return { t, day: laDate(t), cid: c.superfiliate_customer_id, sales: Number(c.subtotal_value) || 0 };
      })
      .filter((o) => o.day >= START_DATE && o.day <= END_DATE && !EXCLUDE_CUSTOMER_IDS.has(Number(o.cid)));

    const ids = [...new Set(orders.map((o) => o.cid).filter(Boolean))];
    const customers = {};
    for (let i = 0; i < ids.length; i += 10) {
      const chunk = ids.slice(i, i + 10);
      const found = await Promise.all(chunk.map((id) => get('customers', { id }, auth).then((r) => r[0]).catch(() => null)));
      chunk.forEach((id, k) => { customers[id] = found[k]; });
    }

    // One leaderboard for the whole contest window
    const agg = new Map();
    for (const o of orders) {
      const name = displayName(customers[o.cid]);
      const a = agg.get(name) || { orders: 0, sales: 0 };
      a.orders += 1;
      a.sales += o.sales;
      agg.set(name, a);
    }
    const round = (n) => Math.round(n * 100) / 100;
    const sorted = [...agg.entries()]
      .map(([affiliate, a]) => ({ affiliate, orders: a.orders, sales: round(a.sales) }))
      .sort((a, b) => b.sales - a.sales || b.orders - a.orders || a.affiliate.toLowerCase().localeCompare(b.affiliate.toLowerCase()));
    let prev = null, rank = 0;
    // Order counts are used only to break ties; the page shows sales only, so they aren't sent.
    const leaderboard = sorted.map((r, i) => { if (r.sales !== prev) { rank = i + 1; prev = r.sales; } return { rank, affiliate: r.affiliate, sales: r.sales }; });

    // Total program sales per month of the contest
    const monthly = ['2026-11', '2026-12'].map((key) => {
      const m = orders.filter((o) => o.day.startsWith(key));
      return { month: key, sales: round(m.reduce((s, o) => s + o.sales, 0)) };
    });

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    res.status(200).json({ updated: now.toISOString(), today: laDate(now), start: START_DATE, end: END_DATE, leaderboard, monthly });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({ error: String(e.message || e) });
  }
};
