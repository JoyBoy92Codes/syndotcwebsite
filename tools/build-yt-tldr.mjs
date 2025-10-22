// tools/build-yt-tldr.mjs
// Captions: official YouTube API (OAuth) → public scrape → offline STT (whisper.cpp).
// Summaries: FREE_MODE=1 uses rule-based, else OpenAI (set OPENAI_API_KEY).
// Playlists: robust matching for "Shorts", "Daily Close Updates", "Education" + pagination.
// Outputs: latest.json, yt-index.json (sections + flat items), summaries.html (tabbed), per-video pages.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { OpenAI } from 'openai';
import { YoutubeTranscript } from 'youtube-transcript';
import { google } from 'googleapis';

/* ============================================================
   CONFIG / ENV
   ============================================================ */
const FREE_MODE          = process.env.FREE_MODE === '1';
const YT_API_KEY         = process.env.YT_API_KEY || '';
const OPENAI_API_KEY     = process.env.OPENAI_API_KEY || '';
const CHANNEL_HANDLE     = process.env.CHANNEL_HANDLE || '@Syn.Trades';
const CHANNEL_ID_ENV     = process.env.CHANNEL_ID || ''; // optional RSS fallback
const SITE_URL           = (process.env.SITE_URL || '').replace(/\/$/, '');
const SITE_TZ            = process.env.SITE_TZ || 'America/Los_Angeles';

// Caps
const MAX_ITEMS          = Number(process.env.MAX_ITEMS || 15);       // fallback (recent)
const MAX_PER_PLAYLIST   = Number(process.env.MAX_PER_PLAYLIST || 50); // per playlist cap
const INCLUDE_SHORTS     = (process.env.INCLUDE_SHORTS ?? '1') === '1'; // if playlist not found, try search shorts
const SHORTS_MAX         = Number(process.env.SHORTS_MAX || 50);

// OAuth env for official captions
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN || '';

// Offline STT fallback config
const BIN_YTDLP           = process.env.YTDLP_BIN   || 'yt-dlp';
const BIN_WHISPER         = process.env.WHISPER_BIN || 'whisper-cpp';
const WHISPER_MODEL_PATH  = process.env.WHISPER_MODEL || 'models/ggml-base.en.bin';

// Summarization model if using OpenAI
const OPENAI_MODEL        = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// Optional live price plausibility check
const ALLOW_PRICE_LOOKUPS = process.env.ALLOW_PRICE_LOOKUPS === '1';

// Output paths
const ROOT              = process.cwd();
const OUT_LATEST        = path.join(ROOT, 'latest.json');
const OUT_INDEX         = path.join(ROOT, 'yt-index.json'); // has {sections} + {items}
const SUMMARIES_DIR     = path.join(ROOT, 'summaries');
const OUT_LASTID        = path.join(ROOT, '.last-video-id');
const OUT_CONTENT_PAGE  = path.join(ROOT, 'summaries.html');

// Target playlists we want as sections
const TARGET_PLAYLIST_TITLES = ['Shorts', 'Daily Close Updates', 'Education'];

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
   DOMAIN GUARDS — TICKERS / TYPO NORMALIZATION
   ============================================================ */
const TICKER_WHITELIST = new Set([
  'BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','SUI','SEI','APT','ARB','OP','BONK','WIF',
  'SPY','QQQ','DXY','VIX','USD'
]);

const ASR_FIX_MAP = [
  { re: /\bs\s*o\s*l\b/gi, rep: 'SOL' }, { re: /\bs-?o-?l\b/gi, rep: 'SOL' },
  { re: /\bsoul\b/gi, rep: 'SOL' },      { re: /\bsole\b/gi, rep: 'SOL' },
  { re: /\bsold\b/gi, rep: 'SOL' },      { re: /\beeth\b/gi, rep: 'ETH' },
  { re: /\bethh\b/gi, rep: 'ETH' },      { re: /\bbtc\b/gi, rep: 'BTC' },
  { re: /\beth\b/gi, rep: 'ETH' },       { re: /\bxrp\b/gi, rep: 'XRP' },
  { re: /\bavax\b/gi, rep: 'AVAX' },     { re: /\blink\b/gi, rep: 'LINK' },
  { re: /\busd\b/gi, rep: 'USD' },       { re: /\bdxy\b/gi, rep: 'DXY' },
  { re: /\bvix\b/gi, rep: 'VIX' },       { re: /\bq ?q ?q\b/gi, rep: 'QQQ' },
  { re: /\bs ?p ?y\b/gi, rep: 'SPY' }
];

function normalizeTextBasic(s='') {
  return String(s)
    .normalize('NFKC')
    .replace(/\u200B|\u200C|\u200D/g, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
function collapseSpacedCaps(s='') {
  return s.replace(/\b([A-Za-z])(?:\s+[A-Za-z]){1,4}\b/g, m => m.replace(/\s+/g, '').toUpperCase());
}
function fixASRTickers(s='') {
  let out = s;
  for (const { re, rep } of ASR_FIX_MAP) out = out.replace(re, rep);
  return out;
}
function protectTickersWhitelist(s='') {
  return s.replace(/\b([A-Z]{2,5})\b/g, (m, g1) => TICKER_WHITELIST.has(g1) ? g1 : m);
}
function normalizeForFinance(s='') {
  let t = normalizeTextBasic(s);
  t = collapseSpacedCaps(t);
  t = fixASRTickers(t);
  t = protectTickersWhitelist(t);
  return t;
}

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
   TRANSCRIPTS
   ============================================================ */
async function getYouTubeAuthFromEnv() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) return null;
  const oauth2 = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, 'http://127.0.0.1');
  oauth2.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return oauth2;
}
function srtToText(srt) {
  return srt
    .replace(/\r/g, '')
    .split('\n')
    .filter(line =>
      !/^\d+$/.test(line) &&
      !/^\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}$/.test(line)
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
async function fetchTranscriptViaYouTubeAPI(videoId) {
  try {
    const auth = await getYouTubeAuthFromEnv();
    if (!auth) return '';
    const youtube = google.youtube({ version: 'v3', auth });
    const list = await youtube.captions.list({ part: ['snippet'], videoId });
    const items = list.data.items || [];
    if (!items.length) return '';
    const isEn  = c => (c.snippet?.language || '').toLowerCase().startsWith('en');
    const isASR = c => (c.snippet?.trackKind || '').toUpperCase() === 'ASR';
    const pick =
      items.find(c => isEn(c) && isASR(c)) ||
      items.find(isEn) ||
      items.find(isASR) ||
      items[0];
    if (!pick) return '';
    const res = await youtube.captions.download(
      { id: pick.id, tfmt: 'srt' },
      { responseType: 'arraybuffer' }
    );
    const srt  = Buffer.from(res.data).toString('utf8');
    const text = srtToText(srt);
    if (text) console.log('✅ transcript via YouTube API for', videoId, `(${pick.snippet?.trackKind || 'caption'})`);
    return text.slice(0, 8000);
  } catch (e) {
    console.warn('YouTube API captions fetch failed:', e?.response?.data || e.message || e);
    return '';
  }
}
const EN_LANGS = ['en','en-US','en-GB','en-UK','en-CA','en-AU','en-NZ','en-IN','en-IE','en-SG','en-PH','en-ZA','a.en','auto','auto-en'];
async function fetchTranscriptViaLib(videoId) {
  for (const lang of EN_LANGS) {
    try {
      const parts = await YoutubeTranscript.fetchTranscript(videoId, { lang });
      if (parts?.length) {
        console.log(`✅ transcript via lib (${lang}) for`, videoId);
        return parts.map(p => p.text).join(' ').replace(/\s+/g, ' ');
      }
    } catch {}
  }
  return '';
}
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
    if (/consent|verify you are human|acknowledge/i.test(html)) return null;
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
async function fetchTranscriptViaWhisper(videoId) {
  const work = path.join(os.tmpdir(), `yt-${videoId}-${Date.now()}`);
  await fs.mkdir(work, { recursive: true });
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const audioPath = path.join(work, `${videoId}.m4a`);
  const COOKIES = process.env.YT_COOKIES_PATH || '';
  const YTDLP_BIN = process.env.YTDLP_BIN || BIN_YTDLP;
  const WHISPER_BIN = process.env.WHISPER_BIN || BIN_WHISPER;
  const WHISPER_MODEL = process.env.WHISPER_MODEL || WHISPER_MODEL_PATH;
  const EXTRACTOR_ARGS = process.env.YTDLP_EXTRACTOR_ARGS || 'youtube:player_client=android,webpage=True';
  const args = [
    '--no-playlist','--geo-bypass','--force-ipv4','--no-warnings',
    '--extractor-args', EXTRACTOR_ARGS,
    '-x','--audio-format','m4a','-o', audioPath, url
  ];
  if (COOKIES) args.splice(0, 0, '--cookies', COOKIES);
  try {
    await run(YTDLP_BIN, args);
    const outStem = path.join(work, videoId);
    await run(WHISPER_BIN, ['-m', WHISPER_MODEL, '-f', audioPath, '-otxt', '-of', outStem]);
    const txt = await fs.readFile(`${outStem}.txt`, 'utf8');
    const plain = txt.replace(/\s+/g, ' ').trim();
    if (plain) console.log('✅ transcript via whisper.cpp for', videoId);
    return plain.slice(0, 8000);
  } catch (e) {
    console.warn('Whisper fallback failed:', e.message || String(e));
    return '';
  } finally {
    try { await fs.rm(work, { recursive: true, force: true }); } catch {}
  }
}
async function fetchTranscriptText(videoId) {
  const fromApi = await fetchTranscriptViaYouTubeAPI(videoId);
  if (fromApi) return normalizeForFinance(fromApi).slice(0, 8000);
  const fromLib = await fetchTranscriptViaLib(videoId);
  if (fromLib) return normalizeForFinance(fromLib).slice(0, 8000);
  const fromWatch = await fetchTranscriptViaWatchPage(videoId);
  if (fromWatch) return normalizeForFinance(fromWatch).slice(0, 8000);
  const fromWhisper = await fetchTranscriptViaWhisper(videoId);
  if (fromWhisper) return normalizeForFinance(fromWhisper).slice(0, 8000);
  return '';
}

/* ============================================================
   YOUTUBE FETCH — PLAYLISTS + SHORTS + FALLBACKS
   ============================================================ */
async function youtube(endpoint, params) {
  if (!YT_API_KEY) throw new Error('YT_API_KEY missing (or set CHANNEL_ID to use RSS)');
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  url.searchParams.set('key', YT_API_KEY);
  Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
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

// Helpers for robust playlist title matching
const stripEmoji = (s='') => s.replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji}\uFE0F]/gu, '');
const normalizeTitle = (s='') => stripEmoji(s).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
function titleMatches(target, actual) {
  const t = normalizeTitle(target);
  const a = normalizeTitle(actual);
  if (!t || !a) return false;
  return a === t || a.includes(t) || t.includes(a);
}

async function fetchAllPlaylistsForChannel(channelId) {
  let pageToken = '';
  const found = [];
  do {
    const j = await youtube('playlists', {
      part: 'snippet,contentDetails,status',
      channelId,
      maxResults: '50',
      pageToken: pageToken || undefined
    });
    for (const p of (j.items || [])) {
      found.push({
        id: p.id,
        title: p.snippet?.title || '',
        count: p.contentDetails?.itemCount || 0,
        privacyStatus: p.status?.privacyStatus || 'public'
      });
    }
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  console.log(`📚 Found ${found.length} playlists on channel`);
  return found;
}

async function fetchPlaylistVideos(playlistId, maxItems = 50) {
  let pageToken = '';
  const items = [];
  do {
    const j = await youtube('playlistItems', {
      part: 'snippet,contentDetails',
      playlistId,
      maxResults: '50',
      pageToken: pageToken || undefined
    });
    for (const it of (j.items || [])) {
      const vid = it.contentDetails?.videoId || it.snippet?.resourceId?.videoId;
      if (!vid) continue;
      items.push({
        videoId: vid,
        title: it.snippet?.title || '',
        description: it.snippet?.description || '',
        publishedAt: it.contentDetails?.videoPublishedAt || it.snippet?.publishedAt || '',
        url: `https://youtu.be/${vid}`
      });
    }
    pageToken = j.nextPageToken || '';
  } while (pageToken && items.length < maxItems);

  const out = items
    .sort((a,b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, maxItems);

  console.log(`  ▸ playlist ${playlistId}: fetched ${out.length} videos`);
  return out;
}

// Build a "Shorts" pseudo-section using search if a Shorts playlist isn't found/public
async function fetchShortsForChannel(channelId, limit = 50) {
  if (!INCLUDE_SHORTS) return [];
  let pageToken = '';
  const items = [];
  do {
    const j = await youtube('search', {
      part: 'snippet',
      channelId,
      type: 'video',
      order: 'date',
      maxResults: '50',
      videoDuration: 'short', // <= 60s
      pageToken: pageToken || undefined
    });
    for (const it of (j.items || [])) {
      items.push({
        videoId: it.id.videoId,
        title: it.snippet.title,
        description: it.snippet.description || '',
        publishedAt: it.snippet.publishedAt,
        url: `https://youtu.be/${it.id.videoId}`
      });
    }
    pageToken = j.nextPageToken || '';
  } while (pageToken && items.length < limit);

  const out = items
    .sort((a,b)=> new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, limit);

  console.log(`  ▸ Shorts (search): fetched ${out.length} videos`);
  return out;
}

/* ============================================================
   NUMERIC VERIFICATION + PRICE SANITY
   ============================================================ */
function parseNumericTokens(s='') {
  const out = [];
  const re = /\$?\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*([kKmM%])?/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const raw = m[0];
    const num = m[1].replace(/,/g, '');
    let val = Number(num);
    const suf = (m[2] || '').toLowerCase();
    if (suf === 'k') val *= 1e3;
    else if (suf === 'm') val *= 1e6;
    const isPercent = suf === '%' || /%/.test(raw);
    const isUSD = /^\s*\$/.test(raw);
    out.push({ raw, value: val, isPercent, isUSD });
  }
  return out;
}
function appearsInTranscriptHuman(nRaw, transcript) {
  const want = parseNumericTokens(nRaw);
  if (!want.length) return false;
  const tnums = parseNumericTokens(transcript);
  return want.every(w =>
    tnums.some(t => {
      if (w.isPercent !== t.isPercent) return false;
      const normRaw = r => r.replace(/[,\s\$]/g,'').toLowerCase();
      if (normRaw(w.raw) === normRaw(t.raw)) return true;
      const denom = Math.max(1, Math.abs(w.value));
      const rel = Math.abs(w.value - t.value) / denom;
      return rel <= 0.01;
    })
  );
}
async function spotPrices(symbols=[]) {
  if (!ALLOW_PRICE_LOOKUPS || !symbols.length) return {};
  const MAP = { BTC:'bitcoin', ETH:'ethereum', SOL:'solana', XRP:'ripple', ADA:'cardano', AVAX:'avalanche-2', LINK:'chainlink' };
  const ids = symbols.map(s => MAP[s]).filter(Boolean);
  if (!ids.length) return {};
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd`;
  try {
    const r = await fetch(url);
    const j = await r.json();
    const out = {};
    for (const [k,v] of Object.entries(j)) {
      const sym = Object.keys(MAP).find(s => MAP[s] === k);
      out[sym] = v.usd;
    }
    return out;
  } catch { return {}; }
}
async function filterImplausibleLevels(long) {
  const syms = Array.from(new Set((long?.key_levels || []).map(l => (l.asset||'').toUpperCase())))
    .filter(s => TICKER_WHITELIST.has(s));
  const spot = await spotPrices(syms);
  if (!Object.keys(spot).length) return long;
  long.key_levels = (long.key_levels || []).filter(l => {
    const a = (l.asset||'').toUpperCase();
    const p = Number(String(l.level||'').replace(/[^\d.]/g,''));
    if (!a || !p || !spot[a]) return true;
    return p > spot[a] / 100 && p < spot[a] * 100;
  });
  return long;
}

/* ============================================================
   SUMMARIZATION
   ============================================================ */
const STOP = new Set((
  'a,an,and,are,as,at,be,by,for,from,has,have,i,in,is,it,of,on,or,that,the,then,there,these,those,to,was,were,will,with,about,into,over,after,before,than,not,so,just,like,you,can,if,we,they,this,our'
).split(','));

function tokenizeSentences(text) {
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
  const scores = sentences.map(s => {
    const words = tokenizeWords(s);
    let score = 0;
    for (const w of words) {
      if (!STOP.has(w)) score += (tf.get(w) || 0);
      if (/\d/.test(w)) score += 1.5;
      if (/(\b\d{3,5}\b|\b\d+\.\d+\b)/.test(w)) score += 1.0;
    }
    if (/\$/.test(s)) score *= 1.08;
    if ([...TICKER_WHITELIST].some(t => s.includes(t))) score *= 1.10;
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
    .sort((a, b) => a - b);
}
function extractNumbers(text, limit = 40) {
  return Array.from(text.matchAll(/\b(\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*[kKmMbB%]?)\b/g))
    .slice(0, limit)
    .map(m => m[1]);
}
function postFix(s='') {
  return normalizeForFinance(String(s || '').replace(/xxx/gi, '—'));
}

async function summarizeFree(v, transcript) {
  const sentences = tokenizeSentences(transcript).slice(0, 400);
  if (!sentences.length) {
    return { ...v, bullets: ['Transcript unavailable — summary skipped.'], long: { skipped: true } };
  }
  const scores = scoreSentences(sentences);
  const top3Idx = topKIndices(scores, 3);
  const top3 = top3Idx.map(i => sentences[i]);

  const contextIdx = topKIndices(scores, Math.min(1, sentences.length))[0] ?? 0;
  const context = sentences[Math.max(0, contextIdx)];

  const levelCandidates = Array.from(new Set(
    (transcript.match(/\b\d{2,5}(?:\.\d+)?\b/g) || []).slice(0, 6)
  ));
  let key_levels = levelCandidates.map(p => ({ asset: '', level: p, direction: '', notes: '' }));

  const top8 = topKIndices(scores, 8);
  const remainder = top8.filter(i => !top3Idx.includes(i));
  const takeaways = remainder.slice(0, 4).map(i => sentences[i]);

  const used = new Set([...top3, ...takeaways]);
  const details = sentences
    .filter(s => !used.has(s))
    .filter(s => /(\bBTC\b|\bETH\b|\bSOL\b|\bSPY\b|\bQQQ\b|\bUSD\b|\bDXY\b|\bVIX\b|\d)/.test(s))
    .slice(0, 6);

  let bullets = top3.map(s => {
    const t = postFix(s);
    return t.length > 160 ? t.slice(0, 157) + '…' : t;
  });

  let long = {
    context: postFix(context),
    key_levels,
    setups: [],
    takeaways: takeaways.map(postFix),
    catalysts: [],
    notable_details: details.map(postFix)
  };

  const serialized = (bullets.join(' ') + ' ' + JSON.stringify(long));
  const nums = serialized.match(/\$?\s*\d[\d,]*(?:\.\d+)?\s*[kKmM%]?/g) || [];
  const hasUnseen = nums.some(n => !appearsInTranscriptHuman(n, transcript));

  if (hasUnseen) {
    const scrub = s => String(s).replace(/\$?\s*\d[\d,]*(?:\.\d+)?\s*[kKmM%]?/g, 'x');
    bullets = bullets.map(scrub);
    long = {
      ...long,
      context: scrub(long.context || ''),
      takeaways: (long.takeaways || []).map(scrub),
      catalysts: (long.catalysts || []).map(scrub),
      key_levels: (long.key_levels || []).map(kl => ({ ...kl, level: scrub(kl.level || ''), notes: scrub(kl.notes || '') })),
      notable_details: (long.notable_details || []).map(scrub),
      note: 'Numerical details scrubbed — mismatch with transcript.'
    };
  }

  long = await filterImplausibleLevels(long);

  if (Array.isArray(long.key_levels)) {
    long.key_levels = long.key_levels.map(l => {
      const a = postFix(l.asset || '').toUpperCase();
      return { ...l, asset: TICKER_WHITELIST.has(a) ? a : '' };
    });
  }

  return { ...v, bullets, long };
}

async function summarizeWithOpenAI(v, transcript) {
  if (!transcript || transcript.trim().length < 200) {
    return { ...v, bullets: ['Transcript unavailable — summary skipped.'], long: { skipped: true } };
  }

  const ALLOWED_TICKERS = Array.from(TICKER_WHITELIST).join(', ');
  const SYSTEM_PROMPT = `
You are a factual trading summarizer.
• Only use tickers from this whitelist: ${ALLOWED_TICKERS}.
• Keep tickers EXACTLY as uppercase tickers (e.g., SOL, BTC, ETH).
• Only include numeric values that are PRESENT in the transcript (you may reformat $, commas).
• If something is unclear, omit it or say "unspecified". Do not invent values.
Be concise, precise, and faithful to the transcript.
`.trim();

  const prompt = `Return JSON that conforms to:
{
  "tldr": ["<=3 bullets, <=60 words total"],
  "long": {
    "context": "2–4 sentences",
    "key_levels": [{"asset":"","level":"","direction":"support|resistance|pivot","notes":""}],
    "setups": [{"name":"","thesis":"","trigger":"","invalidation":"","targets":""}],
    "takeaways": ["3–6 bullets"],
    "catalysts": ["if mentioned"],
    "notable_details": ["3–6 details, not repeated from TL;DR"]
  }
}
RULES:
- Asset codes MUST be from [${ALLOWED_TICKERS}]. If not present in transcript, omit.
- Every numeric you output MUST appear in the transcript (you may reformat $, commas).
Transcript:
${transcript.slice(0, 6000)}`;

  try {
    const res = await ai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ]
    });

    let data = {};
    try { data = JSON.parse(res.choices[0].message.content || '{}'); } catch {}

    const tldr = Array.isArray(data.tldr) ? data.tldr.slice(0, 3) : [];
    let long = data.long || {};
    long.notable_details = Array.isArray(long.notable_details) ? long.notable_details.slice(0, 6) : [];

    const cleanBullets = (tldr || []).map(postFix);
    if (long?.context) long.context = postFix(long.context);
    if (Array.isArray(long.takeaways)) long.takeaways = long.takeaways.map(postFix);
    if (Array.isArray(long.catalysts)) long.catalysts = long.catalysts.map(postFix);
    if (Array.isArray(long.notable_details)) long.notable_details = long.notable_details.map(postFix);
    if (Array.isArray(long.key_levels)) {
      long.key_levels = long.key_levels.map(l => {
        const a = postFix(l.asset || '').toUpperCase();
        return { ...l, asset: TICKER_WHITELIST.has(a) ? a : '' };
      });
    }

    const serialized = (cleanBullets.join(' ') + ' ' + JSON.stringify(long));
    const modelNums = serialized.match(/\$?\s*\d[\d,]*(?:\.\d+)?\s*[kKmM%]?/g) || [];
    const hasUnseen = modelNums.some(n => !appearsInTranscriptHuman(n, transcript));

    if (hasUnseen) {
      const scrub = s => String(s).replace(/\$?\s*\d[\d,]*(?:\.\d+)?\s*[kKmM%]?/g, 'x');
      return {
        ...v,
        bullets: cleanBullets.map(scrub),
        long: {
          ...long,
          context: scrub(long.context || ''),
          takeaways: (long.takeaways || []).map(scrub),
          catalysts: (long.catalysts || []).map(scrub),
          key_levels: (long.key_levels || []).map(kl => ({ ...kl, level: scrub(kl.level || ''), notes: scrub(kl.notes || '') })),
          notable_details: (long.notable_details || []).map(scrub),
          note: 'Numerical details scrubbed — mismatch with transcript.'
        }
      };
    }

    long = await filterImplausibleLevels(long);

    return { ...v, bullets: cleanBullets, long };
  } catch (e) {
    console.warn('Summarization error:', e);
    return { ...v, bullets: ['Summary pending — processing error.'], long: { error: true } };
  }
}

async function summarizeItem(v) {
  const transcript = await fetchTranscriptText(v.videoId);
  if (FREE_MODE || !ai) return await summarizeFree(v, transcript);
  return await summarizeWithOpenAI(v, transcript);
}

/* ============================================================
   HTML RENDER — PER-VIDEO + CONTENT PAGE (TABS)
   ============================================================ */
function summaryHtml({ title, datePT, url, videoId, bullets, long }) {
  const metaDesc = (bullets || []).join(' • ').slice(0, 155);
  const og = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;

  const levels = Array.isArray(long?.key_levels) ? long.key_levels : [];
  const setups = Array.isArray(long?.setups) ? long.setups : [];
  const takeaways = Array.isArray(long?.takeaways) ? long.takeaways : [];
  const catalysts = Array.isArray(long?.catalysts) ? long.catalysts : [];
  const notableDetails = Array.isArray(long?.notable_details) ? long.notable_details : [];

  const levelsHtml = levels.length
    ? `<table style="width:100%;border-collapse:collapse;margin-top:.5rem">
        <thead><tr><th>Asset</th><th>Level</th><th>Role</th><th>Notes</th></tr></thead>
        <tbody>${levels.map(l => `<tr><td>${esc(l.asset||'')}</td><td>${esc(l.level||'')}</td><td>${esc(l.direction||'')}</td><td>${esc(l.notes||'')}</td></tr>`).join('')}</tbody>
      </table>` : '<p style="color:#9aa3b2">No explicit levels.</p>';

  const setupsHtml = setups.length
    ? `<ul>${setups.map(s => `<li><strong>${esc(s.name||'')}</strong> — ${esc(s.thesis||'')}
        <br><em>Trigger:</em> ${esc(s.trigger||'')} · <em>Invalidation:</em> ${esc(s.invalidation||'')} · <em>Targets:</em> ${esc(s.targets||'')}</li>`).join('')}</ul>`
    : '<p style="color:#9aa3b2">No explicit setups.</p>';

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
.grid{display:grid;grid-template-columns:1fr;gap:.75rem}
@media(min-width:640px){.grid{grid-template-columns:repeat(2,1fr)}}
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
  <h3>Notable Details</h3>
  ${ notableDetails.length ? `<ul>${notableDetails.map(d => `<li>${esc(d)}</li>`).join('')}</ul>` : '<p style="color:#9aa3b2">—</p>' }
</article></div></body></html>`;
}

// Tabbed content page (sections)
function contentPageHtml(sections) {
  const tabs = sections.map((s,i) =>
    `<button class="tab${i===0?' active':''}" data-tab="tab-${i}">${esc(s.title)} (${s.items.length})</button>`
  ).join('');
  const panes = sections.map((s,i) => `
    <div class="pane${i===0?' show':''}" id="tab-${i}">
      <div class="grid">
        ${s.items.map(it => `
          <article class="card">
            <div class="thumb"><img src="https://img.youtube.com/vi/${it.videoId}/hqdefault.jpg" alt="${esc(it.title)}" style="width:100%;height:auto;border:0"/></div>
            <h3 style="margin:.5rem 0">${esc(it.title)}</h3>
            <p class="meta">${esc(it.datePT)} · <a class="btn" href="${esc(it.url)}" target="_blank" rel="noopener">Watch</a> · <a class="btn" href="${esc(it.permalink)}">Summary</a></p>
            ${it.bullets?.length ? `<ul>${it.bullets.map(b => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
          </article>
        `).join('')}
      </div>
    </div>
  `).join('');

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><title>Video Summaries — syndotc™</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="./favicon.ico">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
body{background:#0b0c10;color:#fff;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;margin:0}
.container{max-width:1100px;margin:0 auto;padding:2rem 1.25rem}
h1{font-size:2rem;margin:0 0 1rem}
.tabs{display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:1rem}
.tab{background:transparent;border:1px solid rgba(255,255,255,.15);color:#fff;border-radius:999px;padding:.4rem .9rem;cursor:pointer}
.tab.active{background:rgba(255,255,255,.1)}
.pane{display:none}
.pane.show{display:block}
.grid{display:grid;grid-template-columns:1fr;gap:1rem}
@media(min-width:760px){.grid{grid-template-columns:repeat(2,1fr)}}
.card{background:linear-gradient(180deg,rgba(255,255,255,.04),rgba(255,255,255,.02));border:1px solid rgba(255,255,255,.08);border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.35);padding:1rem}
.thumb{aspect-ratio:16/9;border-radius:12px;overflow:hidden;margin-bottom:.5rem}
.thumb img{display:block;width:100%;height:100%;object-fit:cover}
p.meta{color:#9aa3b2;margin:.25rem 0 .5rem}
a.btn{display:inline-flex;gap:.5rem;align-items:center;border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:.35rem .65rem;color:#fff;text-decoration:none;margin-left:.25rem}
ul{color:#cbd2dd}
</style>
</head><body>
<div class="container">
  <h1>Video Summaries</h1>
  <div class="tabs">${tabs}</div>
  ${panes}
</div>
<script>
document.querySelectorAll('.tab').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('.tab').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.pane').forEach(p=>p.classList.remove('show'));
    btn.classList.add('active');
    const id = btn.getAttribute('data-tab');
    document.getElementById(id).classList.add('show');
  });
});
</script>
</body></html>`;
}

/* ============================================================
   MAIN
   ============================================================ */
(async function main() {
  // previous newest id optimization (used only on pure "recent" fallback)
  let lastId = '';
  try { lastId = (await fs.readFile(OUT_LASTID, 'utf8')).trim(); } catch {}

  // Resolve channelId once
  let channelId = CHANNEL_ID_ENV;
  if (!channelId && YT_API_KEY) channelId = await resolveChannelIdFromHandle(CHANNEL_HANDLE);

  // Data “containers”
  let sections = [];            // [{title, items:[...]}]
  const videoMap = new Map();   // videoId -> video meta

  const usingApi = Boolean(YT_API_KEY);
  let fetchedFromPlaylists = false;

  if (usingApi && channelId) {
    const allPlaylists = await fetchAllPlaylistsForChannel(channelId);

    // Build lookup by normalized title
    const normMap = new Map(); // normalizedTitle -> {id,title,privacyStatus}
    for (const p of allPlaylists) {
      normMap.set(normalizeTitle(p.title), { id: p.id, title: p.title, privacyStatus: p.privacyStatus });
    }

    const playlistSections = [];
    for (const desired of TARGET_PLAYLIST_TITLES) {
      // find best match
      let found = null;
      for (const p of allPlaylists) {
        if (titleMatches(desired, p.title)) { found = p; break; }
      }

      if (found && found.privacyStatus === 'public') {
        const vids = await fetchPlaylistVideos(found.id, MAX_PER_PLAYLIST);
        for (const v of vids) if (!videoMap.has(v.videoId)) videoMap.set(v.videoId, v);
        playlistSections.push({ title: found.title, items: vids });
        console.log(`✔ Section "${found.title}" via playlist (${vids.length} videos)`);
      } else {
        // If "Shorts" wasn't found/public, try shorts search. For others, skip silently.
        if (desired.toLowerCase().includes('short') && INCLUDE_SHORTS) {
          const shorts = await fetchShortsForChannel(channelId, SHORTS_MAX);
          for (const v of shorts) if (!videoMap.has(v.videoId)) videoMap.set(v.videoId, v);
          if (shorts.length) {
            playlistSections.push({ title: 'Shorts', items: shorts });
            console.log(`✔ Section "Shorts" via search (${shorts.length} videos)`);
          } else {
            console.log('⚠ Shorts not found (playlist or search returned 0)');
          }
        } else {
          console.log(`⚠ Playlist not found or not public for "${desired}" — skipping`);
        }
      }
    }

    if (playlistSections.length) {
      sections = playlistSections;
      fetchedFromPlaylists = true;
    }
  }

  // Fallback: recent videos if no playlists found
  if (!fetchedFromPlaylists) {
    let items = [];
    if (CHANNEL_ID_ENV) {
      items = await fetchRecentVideosRSS(CHANNEL_ID_ENV, MAX_ITEMS);
    } else {
      const id = channelId || await resolveChannelIdFromHandle(CHANNEL_HANDLE);
      items = await fetchRecentVideosAPI(id, MAX_ITEMS);
    }
    if (!items.length) throw new Error('No videos found');

    const newestId = items[0]?.videoId;
    if (newestId && newestId === lastId) {
      console.log('No new video since last run; skipping.');
      process.exit(0);
    }

    sections = [{ title: 'All Videos', items }];
    for (const v of items) videoMap.set(v.videoId, v);
  }

  // Summarize all unique videos across sections
  const allVideos = Array.from(videoMap.values())
    .sort((a,b)=> new Date(b.publishedAt) - new Date(a.publishedAt));

  const summarized = [];
  for (const v of allVideos) summarized.push(await summarizeItem(v));

  // Per-video pages and index sections
  await fs.mkdir(SUMMARIES_DIR, { recursive: true });

  const sumById = new Map(summarized.map(s => [s.videoId, s]));

  const indexSections = [];
  for (const section of sections) {
    const items = [];
    for (const s of section.items) {
      const sv = sumById.get(s.videoId);
      if (!sv) continue;
      const slug = `${toPTDate(sv.publishedAt)}-${slugify(sv.title)}`;
      const permalink = `summaries/${slug}.html`;
      const html = summaryHtml({
        title: sv.title,
        datePT: toPTDate(sv.publishedAt),
        url: sv.url,
        videoId: sv.videoId,
        bullets: sv.bullets,
        long: sv.long
      });
      await fs.writeFile(path.join(SUMMARIES_DIR, `${slug}.html`), html, 'utf8');

      items.push({
        title: sv.title,
        datePT: toPTDate(sv.publishedAt),
        url: sv.url,
        videoId: sv.videoId,
        bullets: sv.bullets,
        permalink
      });
    }
    items.sort((a,b)=> new Date(b.datePT) - new Date(a.datePT));
    indexSections.push({ title: section.title, items });
  }

  // Flat items array for back-compat (merge all, newest → oldest)
  const flatItems = indexSections
    .flatMap(sec => sec.items)
    .sort((a,b)=> new Date(b.datePT) - new Date(a.datePT));

  // latest.json (newest summarized)
  const newest = summarized
    .slice()
    .sort((a,b)=> new Date(b.publishedAt) - new Date(a.publishedAt))[0];

  const latest = newest
    ? { title: newest.title, datePT: toPTDate(newest.publishedAt), url: newest.url, videoId: newest.videoId, bullets: newest.bullets }
    : { title: '', datePT: '', url: '', videoId: '', bullets: [] };

  // Write grouped index + flat items + summaries.html
  await fs.writeFile(OUT_INDEX, JSON.stringify({ sections: indexSections, items: flatItems }, null, 2), 'utf8');
  await fs.writeFile(OUT_CONTENT_PAGE, contentPageHtml(indexSections), 'utf8');

  if (newest) await fs.writeFile(OUT_LASTID, newest.videoId || '', 'utf8');
  await fs.writeFile(OUT_LATEST, JSON.stringify(latest, null, 2), 'utf8');

  console.log(
    'Wrote latest.json, yt-index.json (sections + items), summaries.html, and',
    summarized.length,
    'summary pages (',
    fetchedFromPlaylists ? 'via Playlists+API' : (CHANNEL_ID_ENV ? 'via RSS' : 'via API recent'),
    ').',
    FREE_MODE ? 'Mode: FREE (rule-based summarizer)' : 'Mode: OpenAI summarizer'
  );
})().catch(err => { console.error(err); process.exit(1); });
