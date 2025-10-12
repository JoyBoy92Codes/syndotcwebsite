// tools/build-yt-tldr.mjs
// Full file — includes free/offline STT fallback (whisper.cpp) and free, rule-based summarizer option.
// If you want $0 end-to-end, set FREE_MODE=1 and install yt-dlp + ffmpeg + whisper.cpp.
// Otherwise, leave OPENAI_API_KEY set to use AI summaries when available.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { OpenAI } from 'openai';
import { YoutubeTranscript } from 'youtube-transcript';

/* ============================================================
   CONFIG / ENV
   ============================================================ */
const FREE_MODE       = process.env.FREE_MODE === '1'; // if true, use rule-based summarizer (no API cost)
const YT_API_KEY      = process.env.YT_API_KEY || '';
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY || '';
const CHANNEL_HANDLE  = process.env.CHANNEL_HANDLE || '@Syn.Trades';
const CHANNEL_ID      = process.env.CHANNEL_ID || ''; // optional: if provided, use RSS (no API)
const SITE_URL        = (process.env.SITE_URL || '').replace(/\/$/, '');
const SITE_TZ         = process.env.SITE_TZ || 'America/Los_Angeles';
const MAX_ITEMS       = Number(process.env.MAX_ITEMS || 10);

// Offline STT fallback config
const BIN_YTDLP       = process.env.YTDLP_BIN   || 'yt-dlp';
const BIN_WHISPER     = process.env.WHISPER_BIN || 'whisper-cpp'; // some builds name the binary 'main'
const WHISPER_MODEL   = process.env.WHISPER_MODEL || 'models/ggml-base.en.bin'; // e.g., 'models/ggml-small.en.bin'

// Summarization model if using OpenAI
const OPENAI_MODEL    = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// Output paths
const ROOT            = process.cwd();
const OUT_LATEST      = path.join(ROOT, 'latest.json');
const OUT_INDEX       = path.join(ROOT, 'yt-index.json');
const SUMMARIES_DIR   = path.join(ROOT, 'summaries');
const OUT_LASTID      = path.join(ROOT, '.last-video-id');

if (!SITE_URL) {
  console.error('Missing env: SITE_URL');
  process.exit(1);
}
if (!FREE_MODE && !OPENAI_API_KEY) {
  console.error('Missing env: OPENAI_API_KEY (or set FREE_MODE=1 for zero-cost summaries)');
  process.exit(1);
}

const ai = !FREE_MODE && OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

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
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

/* ============================================================
   TRANSCRIPT HELPERS (lib first, then watch-page fallback, then local STT)
   ============================================================ */

// A broad list of English variants we’ll try explicitly with the library.
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
  while (i < html.length && /\s/.test(html[i])) i++;
  if (html[i] !== '[') return null;

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
    .replace(/\\u0026/g, '&')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\\//g, '/');

  try { return JSON.parse(cleaned); }
  catch { return null; }
}

// Watch-page fallback with realistic headers, consent suppression, and dual-format fetch
async function fetchTranscriptViaWatchPage(videoId) {
  const headers = {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'accept-language': 'en-US,en;q=0.9',
    'cookie': 'CONSENT=YES+1'
  };

  function extractPlayerResponse(html) {
    const key = 'ytInitialPlayerResponse';
    let i = html.indexOf(key);
    if (i === -1) return null;
    i = html.indexOf('=', i);
    if (i === -1) return null;
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
    if (/www\.youtube\.com\/consent|One more step|verify you are human|acknowledge/i.test(html)) return null;

    const pr = extractPlayerResponse(html);
    let tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!Array.isArray(tracks) || !tracks.length) {
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

  const embedUrl = `https://www.youtube.com/embed/${videoId}?hl=en`;
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en&has_verified=1&bpctr=9999999999`;

  let tracks = await getTracksFrom(embedUrl);
  if (!tracks) tracks = await getTracksFrom(watchUrl);

  const isEnglishCode = (c='') => /^en([\-\_][A-Za-z]+)?$/i.test(c);
  const isAutoEnglish = (c='') => /^a\.en$/i.test(c) || /auto/i.test(c);
  const isEnglishName = (s='') => /english/i.test(String(s));
  const pickTrack = (arr=[]) =>
      arr.find(t => isEnglishCode(t.languageCode))
   || arr.find(t => isEnglishName(t.name?.simpleText || t.languageName))
   || arr.find(t => isAutoEnglish(t.languageCode) || String(t.kind||'').toLowerCase()==='asr')
   || arr.find(t => t.isTranslatable)
   || arr[0];

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

// Offline STT fallback (whisper.cpp) — $0
async function fetchTranscriptViaWhisper(videoId) {
  const work = path.join(os.tmpdir(), `yt-${videoId}-${Date.now()}`);
  await fs.mkdir(work, { recursive: true });
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const audioPath = path.join(work, `${videoId}.m4a`);
  try {
    // 1) download audio (m4a)
    await run(BIN_YTDLP, ['-x', '--audio-format', 'm4a', '-o', audioPath, url]);

    // 2) transcribe offline
    // whisper-cpp accepts: -m <model> -f <audio> -otxt -of <outstem>
    const outStem = path.join(work, videoId);
    await run(BIN_WHISPER, ['-m', WHISPER_MODEL, '-f', audioPath, '-otxt', '-of', outStem]);

    const txt = await fs.readFile(`${outStem}.txt`, 'utf8');
    const plain = txt.replace(/\s+/g, ' ').trim();
    if (plain) console.log('✅ transcript via whisper.cpp for', videoId);
    return plain.slice(0, 8000);
  } catch (e) {
    console.warn('Whisper fallback failed:', e.message || e);
    return '';
  } finally {
    try { await fs.rm(work, { recursive: true, force: true }); } catch {}
  }
}

// Unified transcript getter
async function fetchTranscriptText(videoId) {
  // 1) library (multi-English) first
  const fromLib = await fetchTranscriptViaLib(videoId);
  if (fromLib) return fromLib.slice(0, 8000);

  // 2) watch page fallback
  const fromWatch = await fetchTranscriptViaWatchPage(videoId);
  if (fromWatch) return fromWatch.slice(0, 8000);

  // 3) offline STT (free, reliable)
  const fromWhisper = await fetchTranscriptViaWhisper(videoId);
  if (fromWhisper) return fromWhisper.slice(0, 8000);

  // 4) none
  return '';
}

/* ============================================================
   YOUTUBE FETCH (API or RSS)
   ============================================================ */
async function youtube(endpoint, params) {
  if (!YT_API_KEY) throw new Error('YT_API_KEY missing (or set CHANNEL_ID to use RSS)');
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
    const get = tag => (e.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [, ''])[1].trim();
    const title = get('title');
    const idTag = get('yt:videoId');
    const published = get('published');
    const link = (e.match(/<link rel="alternate" href="([^"]+)"/) || [, ''])[1];
    out.push({ videoId: idTag, title, description: '', publishedAt: published, url: link });
  }
  return out;
}

/* ============================================================
   SUMMARIZATION
   - Paid path: OpenAI (if FREE_MODE=0 and OPENAI_API_KEY present)
   - Free path: rule-based extractive summarizer (no external API)
   ============================================================ */

// tiny stopword set for heuristics
const STOP = new Set((
  'a,an,and,are,as,at,be,by,for,from,has,have,i,in,is,it,of,on,or,that,the,then,there,these,those,to,was,were,will,with,about,into,over,after,before,than,not,so,just,like,you,can,if,we,they,this,our'
).split(','));

function tokenizeSentences(text) {
  // naive splitter good enough for transcripts
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[\.\!\?])\s+(?=[A-Z0-9"'])|(?:\n|\r)+/g)
    .map(s => s.trim())
    .filter(Boolean);
}
function tokenizeWords(s) {
  return s.toLowerCase().match(/[a-z0-9%\.]+/g) || [];
}
function scoreSentences(sentences) {
  const tf = new Map();
  for (const s of sentences) {
    for (const w of tokenizeWords(s)) {
      if (STOP.has(w)) continue;
      tf.set(w, (tf.get(w) || 0) + 1);
    }
  }
  // sentence score: sum of word frequencies + boost for numbers and levels
  const scores = sentences.map(s => {
    const words = tokenizeWords(s);
    let score = 0;
    for (const w of words) {
      if (!STOP.has(w)) score += (tf.get(w) || 0);
      if (/\d/.test(w)) score += 1.5; // boost numeric mentions
      if (/(\b\d{3,5}\b|\b\d+\.\d+\b)/.test(w)) score += 1.0; // price-ish
    }
    // short sentences get a slight boost (conciseness)
    if (s.length < 140) score *= 1.05;
    return score;
  });
  return scores;
}
function topKIndices(scores, k) {
  return scores
    .map((sc, i) => ({ sc, i }))
    .sort((a, b) => b.sc - a.sc)
    .slice(0, k)
    .map(o => o.i)
    .sort((a, b) => a - b); // keep original order
}
function extractNumbers(text, limit = 40) {
  return Array.from(text.matchAll(/\b(\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*[kKmMbB%]?)\b/g))
    .slice(0, limit)
    .map(m => m[1]);
}

async function summarizeFree(v, transcript) {
  const sentences = tokenizeSentences(transcript).slice(0, 400); // cap for speed
  if (!sentences.length) {
    return { ...v, bullets: ['Transcript unavailable — summary skipped.'], long: { skipped: true } };
  }
  const scores = scoreSentences(sentences);
  const top3 = topKIndices(scores, 3).map(i => sentences[i]);

  // simple “context” = first or best sentence about topic
  const contextIdx = topKIndices(scores, Math.min(1, sentences.length))[0] ?? 0;
  const context = sentences[Math.max(0, contextIdx)];

  // “key levels”: scan for common price patterns like 1234, 123.45, 4,200, 1.234
  const levelCandidates = Array.from(new Set(
    (transcript.match(/\b\d{2,5}(?:\.\d+)?\b/g) || []).slice(0, 6)
  ));
  const key_levels = levelCandidates.map(p => ({
    asset: '',
    level: p,
    direction: '',
    notes: ''
  }));

  // “takeaways”: pick 3 more top sentences
  const moreIdx = topKIndices(scores, 6).filter(i => !top3.includes(sentences[i]));
  const takeaways = moreIdx.slice(0, 4).map(i => sentences[i]);

  // evidence: quote top sentence fragments
  const evidence = top3.slice(0, 2).map((q, i) => ({ quote: q.slice(0, 160), ts: '' }));

  return {
    ...v,
    bullets: top3.map(s => s.length > 160 ? s.slice(0, 157) + '…' : s),
    long: {
      context,
      key_levels,
      setups: [],
      takeaways,
      catalysts: [],
      evidence
    }
  };
}

async function summarizeWithOpenAI(v, transcript) {
  // Strict: skip videos without transcript
  if (!transcript || transcript.trim().length < 200) {
    return { ...v, bullets: ['Transcript unavailable — summary skipped.'], long: { skipped: true } };
  }

  const numTokens = extractNumbers(transcript, 200);

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
      model: OPENAI_MODEL,
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

async function summarizeItem(v) {
  const transcript = await fetchTranscriptText(v.videoId);
  if (FREE_MODE || !ai) {
    return await summarizeFree(v, transcript);
  }
  return await summarizeWithOpenAI(v, transcript);
}

/* ============================================================
   HTML RENDER
   ============================================================ */
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

  console.log('Wrote latest.json, yt-index.json and', indexItems.length, 'summary pages (via ' + (CHANNEL_ID ? 'RSS' : 'API') + ').',
              FREE_MODE ? 'Mode: FREE (rule-based summarizer)' : 'Mode: OpenAI summarizer');
})().catch(err => { console.error(err); process.exit(1); });
