// api/enrich-argentina.js
//
// Calcula un score de corto plazo para acciones y CEDEARs argentinos,
// combinando momentum (variación del día) y RSI de 14 días calculado con
// nuestro propio historial acumulado en `daily_prices` — igual que hacemos
// con cripto, porque Alpha Vantage no cubre BYMA.
//
// Se guarda con radar_mode = 'moderado_corto', el MISMO que usan las
// acciones de EE.UU. — así compiten juntas en un solo ranking unificado,
// tal como pide el diseño original ("Top 5" de todo el mercado, filtrable
// por Argentina/EE.UU.). El mercado de cada activo (BYMA/USA) ya viaja en
// el dato, la pantalla lo muestra sin necesidad de cambios.
//
// No incluye "noticias" (Alpha Vantage no cubre esta parte para BYMA) ni
// "fuerza relativa" contra el Merval todavía — se puede sumar más adelante
// sincronizando el índice, igual que hicimos con el S&P 500.
//
// Nota honesta: hasta que no haya 14-15 días de historial acumulado por
// activo, el RSI da null y el score se calcula solo con momentum.
//
// Disparo manual para probar:
//   https://tu-dominio.vercel.app/api/enrich-argentina?secret=TU_SECRETO

const TOP_N = 12;
const MIN_PRICE = 10;
const MAX_CREDIBLE_PCT_CHANGE = 50;

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

async function fetchTopCandidates(today) {
  const rows = await supabaseRequest(
    `daily_prices?date=eq.${today}&select=close,volume,pct_change,assets(id,ticker,market,asset_type)&order=pct_change.desc&limit=500`
  );
  return rows
    .filter((r) =>
      r.assets &&
      r.assets.market === 'BYMA' &&
      (r.assets.asset_type === 'accion' || r.assets.asset_type === 'cedear') &&
      r.pct_change != null &&
      r.close >= MIN_PRICE &&
      Math.abs(r.pct_change) <= MAX_CREDIBLE_PCT_CHANGE &&
      (r.volume ?? 0) > 0
    )
    .slice(0, TOP_N)
    .map((r) => ({ assetId: r.assets.id, ticker: r.assets.ticker, close: r.close, pctChange: r.pct_change }));
}

// RSI de 14 períodos calculado con nuestro propio historial acumulado
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
  const rows = await supabaseRequest(`daily_prices?asset_id=eq.${assetId}&order=date.asc&limit=30&select=close`);
  return computeRSI(rows.map((r) => r.close));
}

function computeScore({ pctChange, rsi }) {
  const momentumScore = clamp(50 + pctChange * 3, 0, 100);
  const rsiScore = rsi != null ? clamp(100 - Math.abs(rsi - 58) * 2, 0, 100) : null;

  if (rsiScore == null) {
    // Sin RSI todavía, la señal es solo momentum de un día — mucho menos
    // confiable. Le ponemos un techo (80) para que no compita de igual a
    // igual contra activos que sí tienen varios factores combinados.
    return { momentumScore, rsiScore: null, total: Math.round(clamp(momentumScore * 0.8, 0, 80)) };
  }

  const total = Math.round((momentumScore + rsiScore) / 2);
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
  const candidates = await fetchTopCandidates(today);

  if (candidates.length === 0) {
    res.status(200).json({ ok: true, message: 'Sin candidatos argentinos para hoy todavía' });
    return;
  }

  const scoreRows = [];
  const journalRows = [];

  for (const c of candidates) {
    const rsi = await fetchRSIFromHistory(c.assetId);
    const { momentumScore, rsiScore, total } = computeScore({ pctChange: c.pctChange, rsi });

    const entrada = c.close;
    const objetivo = Math.round(entrada * 1.08 * 100) / 100;
    const stopLoss = Math.round(entrada * 0.95 * 100) / 100;

    scoreRows.push({
      asset_id: c.assetId,
      date: today,
      radar_mode: 'moderado_corto',
      score_total: total,
      momentum: Math.round(momentumScore),
      tecnico: rsiScore != null ? Math.round(rsiScore) : null,
      entrada_sugerida: entrada,
      objetivo_sugerido: objetivo,
      stop_loss: stopLoss,
      risk_reward: 1.6,
    });

    journalRows.push({
      asset_id: c.assetId,
      date_recommended: today,
      radar_mode: 'moderado_corto',
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

  res.status(200).json({ ok: true, date: today, activos_analizados: scoreRows.length });
};
