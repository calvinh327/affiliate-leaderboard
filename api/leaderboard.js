// Serverless function: pulls Superfiliate conversions, ranks affiliates by order count.
// Needs two environment variables in Vercel: SF_CLIENT_ID and SF_CLIENT_SECRET.
// Results are cached at Vercel's edge for 1 hour so the Superfiliate API isn't hit on every view.

const API = 'https://api.superfiliate.com/api/v1';
const TZ = 'America/Los_Angeles';
const SINCE_YEAR = 2026; // ignore orders placed before this year

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
    const end = new Date(now.getTime() + 86400000).toISOString().slice(0, 10);
    let convs = [];
    for (let page = 1; page < 200; page++) {
      const batch = await get('conversions', { start_date: `${SINCE_YEAR}-01-01`, end_date: end, include_pending: 'true', items: 250, page }, auth);
      convs = convs.concat(batch);
      if (batch.length < 250) break;
    }

    const orders = convs
      .filter((c) => c.status === 'finished' || c.status === 'pending')
      .map((c) => {
        const t = new Date(c.created_at.replace(' UTC', 'Z').replace(' ', 'T'));
        return { t, day: laDate(t), cid: c.superfiliate_customer_id };
      })
      .filter((o) => Number(o.day.slice(0, 4)) >= SINCE_YEAR);

    const ids = [...new Set(orders.map((o) => o.cid).filter(Boolean))];
    const customers = {};
    for (let i = 0; i < ids.length; i += 10) {
      const chunk = ids.slice(i, i + 10);
      const found = await Promise.all(chunk.map((id) => get('customers', { id }, auth).then((r) => r[0]).catch(() => null)));
      chunk.forEach((id, k) => { customers[id] = found[k]; });
    }

    const thisMonth = laDate(now).slice(0, 7);
    const cutoff30 = now.getTime() - 30 * 86400000;
    const windows = {
      month: (o) => o.day.slice(0, 7) === thisMonth,
      '30d': (o) => o.t.getTime() >= cutoff30,
      all: () => true,
    };
    const out = {};
    for (const [w, keep] of Object.entries(windows)) {
      const agg = new Map();
      for (const o of orders.filter(keep)) {
        const name = displayName(customers[o.cid]);
        agg.set(name, (agg.get(name) || 0) + 1);
      }
      const sorted = [...agg.entries()].sort((a, b) => b[1] - a[1] || a[0].toLowerCase().localeCompare(b[0].toLowerCase()));
      let prev = null, rank = 0;
      out[w] = sorted.map(([affiliate, n], i) => { if (n !== prev) { rank = i + 1; prev = n; } return { rank, affiliate, orders: n }; });
    }

    // Last six months of total program orders
    const monthly = [];
    const [y0, m0] = thisMonth.split('-').map(Number);
    for (let k = 5; k >= 0; k--) {
      const d = new Date(Date.UTC(y0, m0 - 1 - k, 1));
      const key = d.toISOString().slice(0, 7);
      monthly.push({ month: key, orders: orders.filter((o) => o.day.startsWith(key)).length });
    }

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    res.status(200).json({ updated: now.toISOString(), windows: out, monthly });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({ error: String(e.message || e) });
  }
};
