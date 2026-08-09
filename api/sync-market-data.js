// api/sync-market-data.js
//
// Trae precios en vivo de data912.com (universo argentino + panel básico USA)
// y los guarda en Supabase: crea/actualiza activos en `assets` y guarda el
// precio del día en `daily_prices`.
//
// Se ejecuta automáticamente todos los días hábiles vía Vercel Cron
// (ver vercel.json), o se puede disparar a mano para probar:
//   https://tu-dominio.vercel.app/api/sync-market-data?secret=TU_SECRETO
//
// Variables de entorno necesarias en Vercel (Project Settings > Environment Variables):
//   SUPABASE_URL               -> https://eamqqrsbaqzwtwibgvo.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  -> la Secret key (sb_secret_...) de Supabase
//   CRON_SECRET                -> una clave random inventada por vos, para que nadie más pueda disparar el sync

const SOURCES = [
  { url: 'https://data912.com/live/arg_stocks', market: 'BYMA', asset_type: 'accion' },
  { url: 'https://data912.com/live/arg_cedears', market: 'BYMA', asset_type: 'cedear' },
  { url: 'https://data912.com/live/arg_bonds', market: 'BYMA', asset_type: 'bono' },
  { url: 'https://data912.com/live/arg_corp', market: 'BYMA', asset_type: 'on' },
  { url: 'https://data912.com/live/usa_adrs', market: 'USA', asset_type: 'adr' },
  { url: 'https://data912.com/live/usa_stocks', market: 'USA', asset_type: 'accion' },
];

function getTodayAR() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());
}

async function fetchSource(source) {
  try {
    const res = await fetch(source.url, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      console.error(`data912 respondió ${res.status} en ${source.url}`);
      return [];
    }
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data
      .filter((row) => row && row.symbol && typeof row.c === 'number')
      .map((row) => ({
        ticker: row.symbol,
        market: source.market,
        asset_type: source.asset_type,
        close: row.c,
        volume: row.v ?? null,
        pct_change: row.pct_change ?? null,
      }));
  } catch (err) {
    console.error(`Error trayendo ${source.url}:`, err.message);
    return [];
  }
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
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Supabase ${method} ${path} -> ${res.status}: ${errText}`);
  }
  return res.status === 204 ? null : res.json();
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
  const results = await Promise.all(SOURCES.map(fetchSource));
  const rows = results.flat();

  if (rows.length === 0) {
    res.status(200).json({ ok: true, message: 'No se recibieron datos de ninguna fuente', total: 0 });
    return;
  }

  const assetsPayload = rows.map((r) => ({
    ticker: r.ticker,
    name: r.ticker,
    market: r.market,
    asset_type: r.asset_type,
  }));

  const upsertedAssets = await supabaseRequest('assets?on_conflict=ticker', {
    method: 'POST',
    body: assetsPayload,
    prefer: 'resolution=merge-duplicates,return=representation',
  });

  const tickerToId = new Map(upsertedAssets.map((a) => [a.ticker, a.id]));

  const pricesPayload = rows
    .filter((r) => tickerToId.has(r.ticker))
    .map((r) => ({
      asset_id: tickerToId.get(r.ticker),
      date: today,
      close: r.close,
      volume: r.volume,
      pct_change: r.pct_change,
    }));

  await supabaseRequest('daily_prices?on_conflict=asset_id,date', {
    method: 'POST',
    body: pricesPayload,
    prefer: 'resolution=merge-duplicates',
  });

  res.status(200).json({
    ok: true,
    date: today,
    activos_procesados: assetsPayload.length,
    precios_guardados: pricesPayload.length,
  });
};
