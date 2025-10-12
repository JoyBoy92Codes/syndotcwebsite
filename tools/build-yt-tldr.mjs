// tools/build-yt-tldr.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { OpenAI } from 'openai';
import { YoutubeTranscript } from 'youtube-transcript';

/* ============================================================
   TRANSCRIPT HELPERS (lib first, then watch-page fallback)
   ============================================================ */

// A broad list of English variants we’ll try explicitly with the library.
// Includes common region codes and the "auto" forms some tracks use.
const EN_LANGS = [
  'en', 'en-US', 'en-GB', 'en-UK', 'en-CA', 'en-AU', 'en-NZ', 'en-IN', 'en-IE', 'en-SG', 'en-PH', 'en-ZA',
  'a.en', 'auto', 'auto-en'
];

// Try youtube-transcript with multiple language codes
async function fetchTranscriptViaLib(videoId) {
  for (const lang of EN_LANGS) {
    try {
      const parts = await YoutubeTranscript.fetchTranscript(videoId, { lang });
      if (parts?.length) {
        console.log(`✅ transcript via lib (${lang}) for`, videoId);
        return parts.map(p => p.text).join(' ').replace(/\s+/g, ' ');
      }
    } catch {
      // keep trying next lang
    }
  }
  return '';
}

// Robust extractor for captionTracks array from the watch page HTML
function extractCaptionTracks(html) {
  const needle = '"captionTracks":';
  let i = html.indexOf(needle);
  if (i === -1) return null;
  i += needle.length;
  // skip whitespace
  while (i < html.length && /\s/.test(html[i])) i++;
  if (html[i] !== '[') return null;

  // bracket-count the array
  let depth = 0, j = i;
  while (j < html.length) {
    const ch = html[j];
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) { j++; break; }
    }
    j++;
  }

  const raw = html.slice(i, j);
  const cleaned = raw
    .replace(/\\u0026/g, '&')  // unescape & in URLs
    .replace(/\\"/g, '"')      // unescape quotes
    .replace(/\\n/g, '\n')     // newlines
    .replace(/\\\//g, '/');    // slashes

  try { return JSON.parse(cleaned); }
  catch { return null; }
}

// Parse json3 timedtext payload into plain text
function parseJson3TimedText(json) {
  const text = (json?.events || [])
    .map(ev => (ev.segs || []).map(s => s.utf8).join(''))
    .join(' ');
  return text.replace(/\s+/g, ' ').trim();
}

// Heuristic: pick best English/ASR track
function pickEnglishTrack(tracks = []) {
  // Helper checks
  const isEnglishCode = (code = '') => /^en([\-\_][A-Za-z]+)?$/i.test(code);
  const isAutoEnglishCode = (code = '') => /^a\.en$/i.test(code) || /auto/i.test(code);
  const isEnglishName = (name = '') => /english/i.test(String(name));

  // 1) exact languageCode starts with 'en'
  let t = tracks.find(t => isEnglishCode(t.languageCode));
  if (t) return t;

  // 2) languageName mentions English
  t = tracks.find(t => isEnglishName(t.name?.simpleText || t.languageName));
  if (t) return t;

  // 3) auto/ASR english-like
  t = tracks.find(t =>
    isAutoEnglishCode(t.languageCode) ||
    String(t.kind || '').toLowerCase() === 'asr'
  );
  if (t) return t;

  // 4) any track that is translatable to EN
  t = tracks.find(t => t.isTranslatable && (t.languageCode || '').length);
  if (t) return t;

  // 5) fallback to first available
  return tracks[0] || null;
}

// Watch-page fallback with realistic headers, consent suppression, and dual-format fetch
async function fetchTranscriptViaWatchPage(videoId) {
  const headers = {
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'accept-language': 'en-US,en;q=0.9',
    'cookie': 'CONSENT=YES+1'
  };

  // Balanced-brace extractor for ytInitialPlayerResponse = {...};
  function extractPlayerResponse(html) {
    const key = 'ytInitialPlayerResponse';
    let i = html.indexOf(key);
    if (i === -1) return null;
    i = html.indexOf('=', i);
    if (i === -1) return null;
    // move to first '{'
    while (i < html.length && html[i] !== '{') i++;
    if (html[i] !== '{') return null;

    let depth = 0, j = i;
    while (j < html.length) {
      const ch = html[j++];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    const raw = html.slice(i, j);
    try { return JSON.parse(raw); } catch { return null; }
  }

  async function getTracksFrom(url) {
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    const html = await res.text();

    // bail if consent/verify page
    if (/www\.youtube\.com\/consent|One more step|verify you are human|acknowledge/i.test(html)) return null;

    // 1) Try full player response (most reliable)
    const pr = extractPlayerResponse(html);
    let tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!Array.isArray(tracks) || !tracks.length) {
      // 2) Try older inline captions block
      const m = html.match(/"playerCaptionsTracklistRenderer":(\{[\s\S]*?\})\}/);
      if (m) {
        try {
          const j = JSON.parse(m[1] + '}');
          tracks = j.captionTracks;
        } catch {}
      }
    }
    return Array.isArray(tracks) && tracks.length ? tracks : null;
  }

  // Try /embed first, then /watch
  const embedUrl = `https://www.youtube.com/embed/${videoId}?hl=en`;
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en&has_verified=1&bpctr=9999999999`;

  let tracks = await getTracksFrom(embedUrl);
  if (!tracks) tracks = await getTracksFrom(watchUrl);

  // Helper pick
  const isEnglishCode = (c='') => /^en([\-\_][A-Za-z]+)?$/i.test(c);
  const isAutoEnglish = (c='') => /^a\.en$/i.test(c) || /auto/i.test(c);
  const isEnglishName = (s='') => /english/i.test(String(s));
  const pickTrack = (arr=[]) =>
      arr.find(t => isEnglishCode(t.languageCode))
   || arr.find(t => isEnglishName(t.name?.simpleText || t.languageName))
   || arr.find(t => isAutoEnglish(t.languageCode) || String(t.kind||'').toLowerCase()==='asr')
   || arr.find(t => t.isTranslatable)
   || arr[0];

  // If we found caption tracks via HTML:
  if (tracks && tracks.length) {
    let baseUrl = pickTrack(tracks)?.baseUrl || '';
    if (!baseUrl) return '';

    baseUrl = baseUrl.replace(/\\u0026/g, '&');

    // Try json3, then TTML
    const jsonUrl = baseUrl.includes('fmt=') ? baseUrl : `${baseUrl}&fmt=json3`;
    let r = await fetch(jsonUrl, { headers });
    if (r.ok) {
      const body = await r.text();
      if (body.trim().startsWith('{')) {
        try {
          const data = JSON.parse(body);
          const text = (data.events || [])
            .map(ev => (ev.segs || []).map(s => s.utf8).join(''))
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
          if (text) {
            console.log('✅ transcript via embed/watch json3 for', videoId);
            return text;
          }
        } catch {}
      }
    }
    const xmlUrl = baseUrl.includes('fmt=') ? baseUrl.replace(/fmt=[^&]+/, 'fmt=ttml') : `${baseUrl}&fmt=ttml`;
    r = await fetch(xmlUrl, { headers });
    if (r.ok) {
      const xml = await r.text();
      const text = xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (text) {
        console.log('✅ transcript via embed/watch XML for', videoId);
        return text;
      }
    }
  }

  // Final fallback: direct timedtext endpoints
  // Try json3 auto-generated EN, then TTML
  for (const fmt of ['json3', 'ttml']) {
    const url = `https://www.youtube.com/api/timedtext?lang=en&v=${encodeURIComponent(videoId)}&fmt=${fmt}`;
    const r = await fetch(url, { headers });
    if (!r.ok) continue;
    const body = await r.text();

    if (fmt === 'json3' && body.trim().startsWith('{')) {
      try {
        const data = JSON.parse(body);
        const text = (data.events || [])
          .map(ev => (ev.segs || []).map(s => s.utf8).join(''))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (text) {
          console.log('✅ transcript via timedtext json3 for', videoId);
          return text;
        }
      } catch {}
    } else if (fmt === 'ttml') {
      const text = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (text) {
        console.log('✅ transcript via timedtext ttml for', videoId);
        return text;
      }
    }
  }

  console.warn('No captionTracks in embed/watch/timedtext for', videoId);
  return '';
}

// Unified transcript getter
async function fetchTranscriptText(videoId) {
  // 1) library (multi-English) first
  const fromLib = await fetchTranscriptViaLib(videoId);
  if (fromLib) return fromLib.slice(0, 8000);

  // 2) watch page fallback
  const fromWatch = await fetchTranscriptViaWatchPage(videoId);
  if (fromWatch) return fromWatch.slice(0, 8000);

  // 3) none
  return '';
}

/* ============================================================
   ENV / PATHS
   ============================================================ */
const YT_API_KEY     = process.env.YT_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CHANNEL_HANDLE = process.env.CHANNEL_HANDLE || '@Syn.Trades';
const CHANNEL_ID     = process.env.CHANNEL_ID || ''; // use RSS if available
const SITE_URL       = (process.env.SITE_URL || '').replace(/\/$/, '');
const SITE_TZ        = process.env.SITE_TZ || 'America/Los_Angeles';
const MAX_ITEMS      = Number(process.env.MAX_ITEMS || 10);

if (!OPENAI_API_KEY || !SITE_URL) {
  console.error('Missing env: OPENAI_API_KEY or SITE_URL');
  process.exit(1);
}

const ai = new OpenAI({ apiKey: OPENAI_API_KEY });
const ROOT = process.cwd();
const OUT_LATEST = path.join(ROOT, 'latest.json');
const OUT_INDEX  = path.join(ROOT, 'yt-index.json');
const SUMMARIES_DIR = path.join(ROOT, 'summaries');
const OUT_LASTID = path.join(ROOT, '.last-video-id');

/* ============================================================
   UTILS
   ============================================================ */
function toPTDate(iso, tz = SITE_TZ) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-CA', { timeZone: tz });
}
function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 80);
}
function esc(s = '') {
  return String(s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
}

/* ============================================================
   SUMMARIZATION (grounded, number-safe)
   ============================================================ */
async function summarizeItem(v) {
  const transcript = await fetchTranscriptText(v.videoId);

  // Strict: skip videos without transcript
  if (!transcript || transcript.trim().length < 200) {
    return { ...v, bullets: ['Transcript unavailable — summary skipped.'], long: { skipped: true } };
  }

  // collect numeric tokens to cross-check
  const numTokens = Array.from(transcript.matchAll(/\b(\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*[kKmMbB%]?)\b/g))
    .slice(0, 200).map(m => m[1]);

  const prompt = `You are a factual trading summarizer.
You MUST write only what appears in the transcript—never infer or guess.
Copy numbers exactly as they appear (including k/M/%). If uncertain, omit.
Return JSON:

{
  "tldr": ["2–3 concise bullets (<=60 words total)"],
  "long": {
    "context": "1–2 sentences of context",
    "key_levels": [{"asset":"","level":"","direction":"support|resistance|pivot","notes":""}],
    "setups": [{"name":"","thesis":"","trigger":"","invalidation":"","targets":""}],
    "takeaways": ["3–6 concise bullets"],
    "catalysts": ["FOMC, CPI, earnings, etc if mentioned"],
    "evidence": [{"quote":"exact phrase from transcript","ts":"00:00:00"}]
  }
}

Transcript:
${transcript.slice(0, 6000)}`;

  try {
    const res = await ai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Be precise. Only describe what the transcript explicitly states.' },
        { role: 'user', content: prompt }
      ]
    });

    const data = JSON.parse(res.choices[0].message.content || '{}');
    const tldr = Array.isArray(data.tldr) ? data.tldr.slice(0, 3) : [];
    const long = data.long || {};

    // scrub numbers not found in transcript
    const numbersInText = (tldr.join(' ') + ' ' + JSON.stringify(long))
      .match(/\b(\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*[kKmMbB%]?)\b/g) || [];
    const appears = n => numTokens.some(tok => tok.toLowerCase() === n.toLowerCase());
    const hasUnseen = numbersInText.some(n => !appears(n));

    if (hasUnseen) {
      const scrub = s => s.replace(/\d/g, 'x');
      return { ...v, bullets: tldr.map(scrub), long: { ...long, note: 'Numerical details scrubbed — mismatch with transcript.' } };
    }

    return { ...v, bullets: tldr, long };
  } catch (e) {
    console.warn('Summarization error:', e);
    return { ...v, bullets: ['Summary pending — processing error.'], long: { error: true } };
  }
}

function summaryHtml({ title, datePT, url, videoId, bullets, long }) {
  const metaDesc = (bullets || []).join(' • ').slice(0, 155);
  const og = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;

  const levels = Array.isArray(long?.key_levels) ? long.key_levels : [];
  const setups = Array.isArray(long?.setups) ? long.setups : [];
  const takeaways = Array.isArray(long?.takeaways) ? long.takeaways : [];
  const catalysts = Array.isArray(long?.catalysts) ? long.catalysts : [];
  const evidence = Array.isArray(long?.evidence) ? long.evidence : [];

  const levelsHtml = levels.length
    ? `<table style="width:100%;border-collapse:collapse;margin-top:.5rem">
        <thead><tr><th>Asset</th><th>Level</th><th>Role</th><th>Notes</th></tr></thead>
        <tbody>${levels.map(l => `<tr><td>${esc(l.asset||'')}</td><td>${esc(l.level||'')}</td><td>${esc(l.direction||'')}</td><td>${esc(l.notes||'')}</td></tr>`).join('')}</tbody>
      </table>` : '<p style="color:#9aa3b2">No explicit levels.</p>';

  const setupsHtml = setups.length
    ? `<ul>${setups.map(s => `<li><strong>${esc(s.name||'')}</strong> — ${esc(s.thesis||'')}
        <br><em>Trigger:</em> ${esc(s.trigger||'')} · <em>Invalidation:</em> ${esc(s.invalidation||'')} · <em>Targets:</em> ${esc(s.targets||'')}</li>`).join('')}</ul>`
    : '<p style="color:#9aa3b2">No explicit setups.</p>';

  const evidenceHtml = evidence.length
    ? `<h3>Evidence (from transcript)</h3><ul>${evidence.map(e =>
        `<li><em>${esc(e.ts||'')}</em> — “${esc(e.quote||'')}”</li>`).join('')}</ul>`
    : '';

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><title>${esc(title)} — Video Summary</title>
<meta name="description" content="${esc(metaDesc)}">
<meta property="og:title" content="${esc(title)} — Video Summary">
<meta property="og:description" content="${esc(metaDesc)}">
<meta property="og:image" content="${og}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="../favicon.ico">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
body{background:#0b0c10;color:#fff;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;margin:0}
.container{max-width:860px;margin:0 auto;padding:2rem 1.25rem}
.card{background:linear-gradient(180deg,rgba(255,255,255,.04),rgba(255,255,255,.02));border:1px solid rgba(255,255,255,.08);border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.35);padding:1rem}
.thumb{aspect-ratio:16/9;border-radius:12px;overflow:hidden}
.thumb iframe{width:100%;height:100%;border:0}
h1{font-size:2rem;margin:.5rem 0}p.meta{color:#9aa3b2;margin:.25rem 0 1rem}
ul{color:#cbd2dd}table{color:#cbd2dd;font-size:.9rem}th{text-align:left;color:#9aa3b2;font-weight:600}
a.btn{display:inline-flex;gap:.5rem;align-items:center;border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:.55rem .85rem;color:#fff;text-decoration:none;margin-top:.5rem}
</style>
</head><body><div class="container">
<a class="btn" href="../summaries.html">← All summaries</a>
<article class="card" style="margin-top:1rem">
  <div class="thumb"><iframe src="https://www.youtube.com/embed/${videoId}?rel=0&modestbranding=1" title="${esc(title)}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen loading="lazy"></iframe></div>
  <h1>${esc(title)}</h1>
  <p class="meta">Published: ${esc(datePT)} (PT) · <a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Watch on YouTube</a></p>
  <h3>TL;DR</h3><ul>${(bullets || []).map(b => `<li>${esc(b)}</li>`).join('')}</ul>
  <h3>Context</h3><p>${esc(long?.context || '—')}</p>
  <h3>Key Levels</h3>${levelsHtml}
  <h3>Setups</h3>${setupsHtml}
  <h3>Takeaways</h3>${takeaways.length ? `<ul>${takeaways.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : '<p style="color:#9aa3b2">—</p>'}
  ${catalysts.length ? `<h3>Catalysts</h3><p>${esc(catalysts.join(' • '))}</p>` : ''}
  ${evidenceHtml}
</article></div></body></html>`;
}

/* ============================================================
   YOUTUBE FETCH (API or RSS)
   ============================================================ */
async function youtube(endpoint, params) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  url.searchParams.set('key', YT_API_KEY);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
async function resolveChannelIdFromHandle(handle) {
  const j = await youtube('search', { part: 'snippet', q: handle, type: 'channel', maxResults: '1' });
  const item = j.items?.[0];
  if (!item?.snippet?.channelId) throw new Error('Cannot resolve channel from handle');
  return item.snippet.channelId;
}
async function fetchRecentVideosAPI(channelId, max = 8) {
  const j = await youtube('search', { part: 'snippet', channelId, order: 'date', maxResults: String(max), type: 'video' });
  return (j.items || []).map(it => ({
    videoId: it.id.videoId,
    title: it.snippet.title,
    description: it.snippet.description || '',
    publishedAt: it.snippet.publishedAt,
    url: `https://youtu.be/${it.id.videoId}`
  }));
}
async function fetchRecentVideosRSS(channelId, max = 8) {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('RSS fetch failed: ' + res.status);
  const xml = await res.text();
  const entries = xml.split('<entry>').slice(1).map(b => '<entry>' + b);
  const out = [];
  for (const e of entries.slice(0, max)) {
    const get = tag => (e.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [,''])[1].trim();
    const title = get('title');
    const idTag = get('yt:videoId');
    const published = get('published');
    const link = (e.match(/<link rel="alternate" href="([^"]+)"/) || [,''])[1];
    out.push({ videoId: idTag, title, description: '', publishedAt: published, url: link });
  }
  return out;
}

/* ============================================================
   MAIN
   ============================================================ */
(async function main() {
  // check last ID to skip duplicates
  let lastId = '';
  try { lastId = (await fs.readFile(OUT_LASTID, 'utf8')).trim(); } catch {}

  let items = [];
  if (CHANNEL_ID) {
    items = await fetchRecentVideosRSS(CHANNEL_ID, MAX_ITEMS);
  } else {
    const channelId = await resolveChannelIdFromHandle(CHANNEL_HANDLE);
    items = await fetchRecentVideosAPI(channelId, MAX_ITEMS);
  }
  if (!items.length) throw new Error('No videos found');

  const newestId = items[0]?.videoId;
  if (newestId && newestId === lastId) {
    console.log('No new video since last run; skipping.');
    process.exit(0);
  }

  const summarized = [];
  for (const v of items) summarized.push(await summarizeItem(v));

  const newest = summarized[0];
  const latest = { title: newest.title, datePT: toPTDate(newest.publishedAt), url: newest.url, videoId: newest.videoId, bullets: newest.bullets };

  await fs.mkdir(SUMMARIES_DIR, { recursive: true });
  const indexItems = [];
  for (const s of summarized) {
    const slug = `${toPTDate(s.publishedAt)}-${slugify(s.title)}`;
    const permalink = `summaries/${slug}.html`;
    indexItems.push({ title: s.title, datePT: toPTDate(s.publishedAt), url: s.url, videoId: s.videoId, bullets: s.bullets, permalink });
    const html = summaryHtml({ title: s.title, datePT: toPTDate(s.publishedAt), url: s.url, videoId: s.videoId, bullets: s.bullets, long: s.long });
    await fs.writeFile(path.join(SUMMARIES_DIR, `${slug}.html`), html, 'utf8');
  }

  await fs.writeFile(OUT_LATEST, JSON.stringify(latest, null, 2), 'utf8');
  await fs.writeFile(OUT_INDEX,  JSON.stringify({ items: indexItems }, null, 2), 'utf8');
  await fs.writeFile(OUT_LASTID, newestId || '', 'utf8');

  console.log('Wrote latest.json, yt-index.json and', indexItems.length, 'summary pages (via ' + (CHANNEL_ID ? 'RSS' : 'API') + ').');
})().catch(err => { console.error(err); process.exit(1); });
