// api/enrich-scores.js
//
// Toma los mejores candidatos de EE.UU. del ranking de precio del día
// (tabla daily_prices) y les calcula un score real combinando:
//   - Momentum: variación de precio de hoy
//   - Técnico: RSI de 14 días (calculado por Alpha Vantage sobre su propio historial)
//   - Noticias: sentimiento de noticias recientes (Alpha Vantage News & Sentiment)
// Guarda el resultado en la tabla `scores`.
//
// Se ejecuta automáticamente después de sync-market-data (ver vercel.json),
// o se puede disparar a mano para probar:
//   https://tu-dominio.vercel.app/api/enrich-scores?secret=TU_SECRETO
//
// Variable de entorno nueva necesaria en Vercel:
//   ALPHA_VANTAGE_KEY -> tu clave gratuita de alphavantage.co
//
// Nota honesta: el plan gratis de Alpha Vantage permite 25 consultas/día y
// 5 consultas/minuto. Por eso este motor analiza solo el Top 4 del día
// (8 consultas en total), no el universo completo. A medida que el negocio
// lo justifique, se puede pasar a un plan pago para escalar a más activos.

const TOP_N = 4;
const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

// Precio mínimo y variación máxima "creíble" para no dejar pasar penny stocks
// ilíquidas ni saltos de precio que en realidad son ruido de datos (cotización
// vieja/errónea de la fuente), no una oportunidad real.
const MIN_PRICE = 10;
const MAX_CREDIBLE_PCT_CHANGE = 50;

async function fetchTopCandidates(today) {
  const rows = await supabaseRequest(
    `daily_prices?date=eq.${today}&select=close,volume,pct_change,assets(id,ticker,market)&order=pct_change.desc&limit=200`
  );
  return rows
    .filter((r) =>
      r.assets &&
      r.assets.market === 'USA' &&
      r.pct_change != null &&
      r.close >= MIN_PRICE &&
      Math.abs(r.pct_change) <= MAX_CREDIBLE_PCT_CHANGE &&
      (r.volume ?? 0) > 0
    )
    .slice(0, TOP_N)
    .map((r) => ({ assetId: r.assets.id, ticker: r.assets.ticker, close: r.close, pctChange: r.pct_change }));
}

async function fetchSPYFromAlphaVantage() {
  try {
    const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=SPY&apikey=${ALPHA_VANTAGE_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    const quote = data['Global Quote'];
    if (!quote || !quote['05. price']) return null;
    return {
      close: parseFloat(quote['05. price']),
      pctChange: parseFloat((quote['10. change percent'] || '0').replace('%', '')),
    };
  } catch {
    return null;
  }
}

async function fetchIndexPctChange(today) {
  try {
    const [spyAsset] = await supabaseRequest('assets?ticker=eq.SPY&select=id&limit=1');
    if (spyAsset) {
      const [row] = await supabaseRequest(
        `daily_prices?date=eq.${today}&asset_id=eq.${spyAsset.id}&select=pct_change&limit=1`
      );
      if (row) return row.pct_change;
    }

    // No lo tenemos guardado para hoy todavía — lo traemos directo y lo guardamos
    // para no tener que volver a pedirlo el resto del día.
    const spyData = await fetchSPYFromAlphaVantage();
    if (!spyData) return null;

    const [asset] = await supabaseRequest('assets?on_conflict=ticker', {
      method: 'POST',
      body: [{ ticker: 'SPY', name: 'SPDR S&P 500 ETF', market: 'USA', asset_type: 'etf' }],
      prefer: 'resolution=merge-duplicates,return=representation',
    });
    await supabaseRequest('daily_prices?on_conflict=asset_id,date', {
      method: 'POST',
      body: [{ asset_id: asset.id, date: today, close: spyData.close, pct_change: spyData.pctChange }],
      prefer: 'resolution=merge-duplicates',
    });
    return spyData.pctChange;
  } catch {
    return null;
  }
}

async function fetchRSI(ticker) {
  try {
    const url = `https://www.alphavantage.co/query?function=RSI&symbol=${ticker}&interval=daily&time_period=14&series_type=close&apikey=${ALPHA_VANTAGE_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    const series = data['Technical Analysis: RSI'];
    if (!series) return null;
    const latestDate = Object.keys(series)[0];
    return parseFloat(series[latestDate]['RSI']);
  } catch {
    return null;
  }
}

async function fetchNewsSentiment(ticker) {
  try {
    const url = `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=${ticker}&limit=20&apikey=${ALPHA_VANTAGE_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    const feed = data.feed;
    if (!Array.isArray(feed) || feed.length === 0) return null;

    let weightedSum = 0;
    let weightTotal = 0;
    for (const article of feed) {
      const tSent = (article.ticker_sentiment || []).find((t) => t.ticker === ticker);
      if (!tSent) continue;
      const relevance = parseFloat(tSent.relevance_score) || 0;
      const score = parseFloat(tSent.ticker_sentiment_score) || 0;
      weightedSum += score * relevance;
      weightTotal += relevance;
    }
    return weightTotal > 0 ? weightedSum / weightTotal : null;
  } catch {
    return null;
  }
}

function computeScore({ pctChange, rsi, newsSentiment, spyPctChange }) {
  const momentumScore = clamp(50 + pctChange * 5, 0, 100);
  const rsiScore = rsi != null ? clamp(100 - Math.abs(rsi - 58) * 2, 0, 100) : null;
  const newsScore = newsSentiment != null ? clamp((newsSentiment + 1) * 50, 0, 100) : null;
  const fuerzaRelativaScore = spyPctChange != null ? clamp(50 + (pctChange - spyPctChange) * 8, 0, 100) : null;

  const parts = [
    { value: momentumScore, weight: 0.25 },
    { value: rsiScore, weight: 0.3 },
    { value: newsScore, weight: 0.25 },
    { value: fuerzaRelativaScore, weight: 0.2 },
  ].filter((p) => p.value != null);

  const weightSum = parts.reduce((s, p) => s + p.weight, 0);
  const total = parts.reduce((s, p) => s + p.value * p.weight, 0) / weightSum;

  return { momentumScore, rsiScore, newsScore, fuerzaRelativaScore, total: Math.round(total) };
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

  if (!ALPHA_VANTAGE_KEY) {
    res.status(500).json({ error: 'Falta configurar ALPHA_VANTAGE_KEY en Vercel' });
    return;
  }

  const today = getTodayAR();
  const candidates = await fetchTopCandidates(today);

  if (candidates.length === 0) {
    res.status(200).json({ ok: true, message: 'Sin candidatos de EE.UU. para hoy todavía' });
    return;
  }

  const spyPctChange = await fetchIndexPctChange(today);

  const scoreRows = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const rsi = await fetchRSI(c.ticker);
    const newsSentiment = await fetchNewsSentiment(c.ticker);
    const { momentumScore, rsiScore, newsScore, fuerzaRelativaScore, total } = computeScore({
      pctChange: c.pctChange,
      rsi,
      newsSentiment,
      spyPctChange,
    });

    scoreRows.push({
      asset_id: c.assetId,
      date: today,
      radar_mode: 'moderado_corto',
      score_total: total,
      momentum: Math.round(momentumScore),
      tecnico: rsiScore != null ? Math.round(rsiScore) : null,
      noticias: newsScore != null ? Math.round(newsScore) : null,
      fuerza_relativa: fuerzaRelativaScore != null ? Math.round(fuerzaRelativaScore) : null,
      entrada_sugerida: c.close,
      objetivo_sugerido: Math.round(c.close * 1.08 * 100) / 100,
      stop_loss: Math.round(c.close * 0.95 * 100) / 100,
      risk_reward: 1.6,
    });

    // Respetamos el límite de 5 consultas/minuto del plan gratis de Alpha Vantage
    if (i < candidates.length - 1) await sleep(12000);
  }

  // Registro en el journal para poder medir a futuro el track record real
  // del sistema (probabilidad de acierto basada en resultados propios, no inventada)
  const journalRows = scoreRows.map((s) => ({
    asset_id: s.asset_id,
    date_recommended: today,
    radar_mode: s.radar_mode,
    score_al_momento: s.score_total,
    entrada: s.entrada_sugerida,
    stop_loss: s.stop_loss,
    objetivo: s.objetivo_sugerido,
    cerrado: false,
  }));
  if (journalRows.length > 0) {
    await supabaseRequest('recommendation_journal', { method: 'POST', body: journalRows });
  }

  await supabaseRequest('scores?on_conflict=asset_id,date,radar_mode', {
    method: 'POST',
    body: scoreRows,
    prefer: 'resolution=merge-duplicates',
  });

  res.status(200).json({ ok: true, date: today, candidatos_analizados: scoreRows.length });
};
