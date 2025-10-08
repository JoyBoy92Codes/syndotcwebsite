import fs from 'node:fs/promises';
import path from 'node:path';
import { OpenAI } from 'openai';

// ---- env ----
const YT_API_KEY     = process.env.YT_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CHANNEL_HANDLE = process.env.CHANNEL_HANDLE || '@Syn.Trades';
const SITE_URL       = (process.env.SITE_URL || '').replace(/\/$/, '');
const SITE_TZ        = process.env.SITE_TZ || 'America/Los_Angeles';
const MAX_ITEMS      = Number(process.env.MAX_ITEMS || 10);

if (!YT_API_KEY || !OPENAI_API_KEY || !SITE_URL) {
  console.error('Missing env: YT_API_KEY, OPENAI_API_KEY, SITE_URL');
  process.exit(1);
}

const ai   = new OpenAI({ apiKey: OPENAI_API_KEY });
const ROOT = process.cwd();
const OUT_LATEST = path.join(ROOT, 'latest.json');
const OUT_INDEX  = path.join(ROOT, 'yt-index.json');
const SUMMARIES_DIR = path.join(ROOT, 'summaries');

// ---- helpers ----
async function youtube(endpoint, params) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  url.searchParams.set('key', YT_API_KEY);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function resolveChannelIdFromHandle(handle) {
  // Find channel via search (robust for handles)
  const j = await youtube('search', { part: 'snippet', q: handle, type: 'channel', maxResults: '1' });
  const item = j.items?.[0];
  if (!item?.snippet?.channelId) throw new Error('Cannot resolve channel from handle');
  return item.snippet.channelId;
}

async function fetchRecentVideos(channelId, max = 8) {
  const j = await youtube('search', {
    part: 'snippet', channelId, order: 'date', maxResults: String(max), type: 'video'
  });
  return (j.items || []).map(it => ({
    videoId: it.id.videoId,
    title: it.snippet.title,
    description: it.snippet.description || '',
    publishedAt: it.snippet.publishedAt,
    url: `https://youtu.be/${it.id.videoId}`
  }));
}

function toPTDate(iso, tz = SITE_TZ) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 80);
}

async function summarizeItem(v) {
  // If description is empty (e.g., Shorts), still produce bullets
  const userPrompt =
`Write a very short TL;DR for a trading video in 2–3 bullets (<=60 words total).
Be objective and actionable. Focus on structure: key levels/ranges, holds/origins, momentum shifts, invalidation.
Avoid hype and advice.

Return strict JSON: {"bullets":["...","..."]}

Title: ${v.title}
Description: ${v.description.slice(0, 1200)}`;

  try {
    const res = await ai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are a concise trading note-taker for a website." },
        { role: "user", content: userPrompt }
      ]
    });

    const data = JSON.parse(res.choices[0].message.content || "{}");
    const bullets = Array.isArray(data.bullets) ? data.bullets.slice(0,3) : [];
    return { ...v, bullets };
  } catch (err) {
    // Fallback: first sentences of description
    const fallback = (v.description || '').split(/\.\s+/).slice(0,3).map(s => s.trim()).filter(Boolean);
    return { ...v, bullets: fallback.length ? fallback : ["New video summary pending."] };
  }
}

function summaryHtml({ title, datePT, url, videoId, bullets }) {
  const metaDesc = (bullets || []).join(' • ').slice(0, 155);
  const og = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>${title} — Video Summary</title>
<meta name="description" content="${metaDesc}">
<meta property="og:title" content="${title} — Video Summary">
<meta property="og:description" content="${metaDesc}">
<meta property="og:image" content="${og}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="/favicon.ico">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
  body{background:#0b0c10;color:#fff;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;margin:0}
  .container{max-width:860px;margin:0 auto;padding:2rem 1.25rem}
  .card{background:linear-gradient(180deg,rgba(255,255,255,.04),rgba(255,255,255,.02));border:1px solid rgba(255,255,255,.08);border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.35);padding:1rem}
  .thumb{aspect-ratio:16/9;border-radius:12px;overflow:hidden}
  .thumb iframe{width:100%;height:100%;border:0}
  h1{font-size:2rem;margin:.5rem 0}
  p.meta{color:#9aa3b2;margin:.25rem 0 1rem}
  ul{color:#cbd2dd}
  a.btn{display:inline-flex;gap:.5rem;align-items:center;border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:.55rem .85rem;color:#fff;text-decoration:none;margin-top:.5rem}
</style>
</head><body>
  <div class="container">
    <a class="btn" href="/summaries.html">← All summaries</a>
    <article class="card" style="margin-top:1rem">
      <div class="thumb"><iframe src="https://www.youtube.com/embed/${videoId}?rel=0&modestbranding=1" title="${title}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen loading="lazy"></iframe></div>
      <h1>${title}</h1>
      <p class="meta">Published: ${datePT} (PT) · <a class="btn" href="${url}" target="_blank" rel="noopener">Watch on YouTube</a></p>
      <h3>TL;DR</h3>
      <ul>${(bullets||[]).map(b=>`<li>${b}</li>`).join('')}</ul>
    </article>
  </div>
</body></html>`;
}

// ---- main ----
(async function main() {
  const channelId = await resolveChannelIdFromHandle(CHANNEL_HANDLE);
  const items = await fetchRecentVideos(channelId, MAX_ITEMS);
  if (!items.length) throw new Error('No videos found');

  // summarize each
  const summarized = [];
  for (const v of items) summarized.push(await summarizeItem(v));

  // latest.json
  const newest = summarized[0];
  const latest = {
    title: newest.title,
    datePT: toPTDate(newest.publishedAt),
    url: newest.url,
    videoId: newest.videoId,
    bullets: newest.bullets
  };

  // index + SEO pages
  await fs.mkdir(SUMMARIES_DIR, { recursive: true });
  const indexItems = [];
  for (const s of summarized) {
    const slug = `${toPTDate(s.publishedAt)}-${slugify(s.title)}`;
    const permalink = `/summaries/${slug}.html`;
    indexItems.push({
      title: s.title,
      datePT: toPTDate(s.publishedAt),
      url: s.url,
      videoId: s.videoId,
      bullets: s.bullets,
      permalink
    });
    const html = summaryHtml({
      title: s.title, datePT: toPTDate(s.publishedAt), url: s.url, videoId: s.videoId, bullets: s.bullets
    });
    await fs.writeFile(path.join(SUMMARIES_DIR, `${slug}.html`), html, 'utf8');
  }

  await fs.writeFile(OUT_LATEST, JSON.stringify(latest, null, 2), 'utf8');
  await fs.writeFile(OUT_INDEX,  JSON.stringify({ items: indexItems }, null, 2), 'utf8');

  console.log('Wrote latest.json, yt-index.json and', indexItems.length, 'summary pages.');
})().catch(err => { console.error(err); process.exit(1); });
