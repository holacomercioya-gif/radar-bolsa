// api/sync-crypto-data.js
//
// Trae precios de las 30 criptomonedas por capitalización más grande desde
// CoinGecko (gratis, sin clave) y los guarda en Supabase, reutilizando las
// mismas tablas `assets` y `daily_prices` que usamos para acciones — así
// el sistema empieza a acumular su propio historial de cripto, necesario
// para calcular RSI más adelante (CoinGecko no lo calcula por nosotros
// como sí hace Alpha Vantage con acciones).
//
// Tickers de cripto se guardan como "BTC-USD" (con sufijo) para que nunca
// choquen con el ticker de una acción real que se llame igual.
//
// Disparo manual para probar:
//   https://tu-dominio.vercel.app/api/sync-crypto-data?secret=TU_SECRETO

function getTodayAR() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());
}

async function supabaseRequest(path, { method = 'GET', body, prefer } = {}) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'content-type': 'application/json',
  };
  if (prefer) headers.prefer = prefer;

  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Supabase ${method} ${path} -> ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function fetchCoins() {
  const url = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=30&page=1&price_change_percentage=24h';
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`CoinGecko respondió ${res.status}`);
  const data = await res.json();
  return data
    .filter((c) => c && c.symbol && typeof c.current_price === 'number')
    .map((c) => ({
      ticker: `${c.symbol.toUpperCase()}-USD`,
      name: c.name,
      close: c.current_price,
      volume: c.total_volume ?? null,
      pctChange: c.price_change_percentage_24h ?? null,
    }));
}

module.exports = async function handler(req, res) {
  const secret = req.query?.secret || req.headers['x-cron-secret'];
  const authHeader = req.headers['authorization'];
  const validCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const validManual = secret === process.env.CRON_SECRET;

  if (!validCron && !validManual) {
    res.status(401).json({ error: 'No autorizado' });
    return;
  }

  const today = getTodayAR();
  const coins = await fetchCoins();

  if (coins.length === 0) {
    res.status(200).json({ ok: true, message: 'No se recibieron datos de CoinGecko' });
    return;
  }

  const assetsPayload = coins.map((c) => ({
    ticker: c.ticker,
    name: c.name,
    market: 'CRYPTO',
    asset_type: 'cripto',
  }));

  const upsertedAssets = await supabaseRequest('assets?on_conflict=ticker', {
    method: 'POST',
    body: assetsPayload,
    prefer: 'resolution=merge-duplicates,return=representation',
  });

  const tickerToId = new Map(upsertedAssets.map((a) => [a.ticker, a.id]));

  const pricesPayload = coins
    .filter((c) => tickerToId.has(c.ticker))
    .map((c) => ({
      asset_id: tickerToId.get(c.ticker),
      date: today,
      close: c.close,
      volume: c.volume,
      pct_change: c.pctChange,
    }));

  await supabaseRequest('daily_prices?on_conflict=asset_id,date', {
    method: 'POST',
    body: pricesPayload,
    prefer: 'resolution=merge-duplicates',
  });

  res.status(200).json({ ok: true, date: today, monedas_procesadas: pricesPayload.length });
};
