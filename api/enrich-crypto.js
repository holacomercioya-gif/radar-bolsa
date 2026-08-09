// api/enrich-crypto.js
//
// Calcula un score de corto plazo para las criptomonedas ya sincronizadas,
// combinando momentum (variación 24h) y RSI de 14 días calculado con
// nuestro propio historial acumulado en `daily_prices` (CoinGecko no
// calcula indicadores técnicos por nosotros). Guarda el resultado en
// `scores` con radar_mode = 'cripto_corto'.
//
// Nota honesta: hasta que no haya 14-15 días de historial acumulado, el
// RSI da null y el score se calcula solo con momentum — se completa solo
// con los días, igual que pasó al principio con las acciones.
//
// Disparo manual para probar:
//   https://tu-dominio.vercel.app/api/enrich-crypto?secret=TU_SECRETO

const TOP_N = 10;

function getTodayAR() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
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

async function fetchTopCoins(today) {
  const rows = await supabaseRequest(
    `daily_prices?date=eq.${today}&select=close,pct_change,assets(id,ticker,market)&order=close.desc&limit=100`
  );
  return rows
    .filter((r) => r.assets && r.assets.market === 'CRYPTO' && r.pct_change != null)
    .slice(0, TOP_N)
    .map((r) => ({ assetId: r.assets.id, ticker: r.assets.ticker, close: r.close, pctChange: r.pct_change }));
}

// RSI de 14 períodos, método clásico (Wilder simplificado con promedio simple)
function computeRSI(closesAscending) {
  const period = 14;
  if (closesAscending.length < period + 1) return null;

  const recent = closesAscending.slice(-(period + 1));
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < recent.length; i++) {
    const diff = recent[i] - recent[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

async function fetchRSIFromHistory(assetId) {
  const rows = await supabaseRequest(
    `daily_prices?asset_id=eq.${assetId}&order=date.asc&limit=30&select=close`
  );
  const closes = rows.map((r) => r.close);
  return computeRSI(closes);
}

function computeScore({ pctChange, rsi }) {
  const momentumScore = clamp(50 + pctChange * 3, 0, 100);
  const rsiScore = rsi != null ? clamp(100 - Math.abs(rsi - 58) * 2, 0, 100) : null;

  const parts = [momentumScore, rsiScore].filter((v) => v != null);
  const total = Math.round(parts.reduce((s, v) => s + v, 0) / parts.length);

  return { momentumScore, rsiScore, total };
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
  const coins = await fetchTopCoins(today);

  if (coins.length === 0) {
    res.status(200).json({ ok: true, message: 'Sin criptomonedas sincronizadas para hoy todavía' });
    return;
  }

  const scoreRows = [];
  const journalRows = [];

  for (const coin of coins) {
    const rsi = await fetchRSIFromHistory(coin.assetId);
    const { momentumScore, rsiScore, total } = computeScore({ pctChange: coin.pctChange, rsi });

    const entrada = coin.close;
    const objetivo = Math.round(entrada * 1.1 * 10000) / 10000;
    const stopLoss = Math.round(entrada * 0.92 * 10000) / 10000;

    scoreRows.push({
      asset_id: coin.assetId,
      date: today,
      radar_mode: 'cripto_corto',
      score_total: total,
      momentum: Math.round(momentumScore),
      tecnico: rsiScore != null ? Math.round(rsiScore) : null,
      entrada_sugerida: entrada,
      objetivo_sugerido: objetivo,
      stop_loss: stopLoss,
    });

    journalRows.push({
      asset_id: coin.assetId,
      date_recommended: today,
      radar_mode: 'cripto_corto',
      score_al_momento: total,
      entrada,
      stop_loss: stopLoss,
      objetivo,
      cerrado: false,
    });
  }

  await supabaseRequest('scores?on_conflict=asset_id,date,radar_mode', {
    method: 'POST',
    body: scoreRows,
    prefer: 'resolution=merge-duplicates',
  });
  await supabaseRequest('recommendation_journal', { method: 'POST', body: journalRows });

  res.status(200).json({ ok: true, date: today, criptos_analizadas: scoreRows.length });
};
