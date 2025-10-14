// tools/oauth-get-token.mjs
import http from 'node:http';
import open from 'open';
import readline from 'node:readline';
import { google } from 'googleapis';
import fs from 'node:fs/promises';

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_OAUTH_MODE = 'loopback' } = process.env;
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in env.');
  process.exit(1);
}

const SCOPES = ['https://www.googleapis.com/auth/youtube.force-ssl'];

async function saveTokens(tokens) {
  await fs.writeFile('.yt-oauth.json', JSON.stringify(tokens, null, 2), 'utf8');
  console.log('\nSaved tokens to .yt-oauth.json');
  console.log(tokens.refresh_token ? '✅ Refresh token captured.' : '⚠️ No refresh token — re-run and be sure to click Allow when prompted.');
}

/** LOOPBACK MODE: opens browser and listens on http://127.0.0.1:53682/callback */
async function runLoopback() {
  const REDIRECT_URI = 'http://127.0.0.1:53682/callback';
  const oauth2 = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);

  const authUrl = oauth2.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });
  console.log('\nAuthorize this app (loopback mode). If your browser does not open, copy/paste this URL manually:\n');
  console.log(authUrl + '\n');

  // Try to open default browser, but even if this fails the URL is printed.
  try { await open(authUrl); } catch {}

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (req.url.startsWith('/callback')) {
        const urlObj = new URL(req.url, REDIRECT_URI);
        const codeParam = urlObj.searchParams.get('code');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Authorization received. You can close this tab.');
        server.close(() => resolve(codeParam));
      } else {
        res.writeHead(404); res.end();
      }
    });

    // Add a timeout so it doesn’t just sit forever
    server.listen(53682, '127.0.0.1').on('listening', () => {
      setTimeout(() => {
        server.close();
        reject(new Error('Timed out waiting for Google to redirect. If this keeps happening, use GOOGLE_OAUTH_MODE=oob.'));
      }, 180000); // 3 minutes
    }).on('error', (e) => {
      reject(new Error('Could not start local server (port blocked?). Try GOOGLE_OAUTH_MODE=oob.\n' + e.message));
    });
  });

  const { tokens } = await oauth2.getToken(code);
  await saveTokens(tokens);
}

/** OOB MODE: prints URL, you paste the code */
async function runOob() {
  const REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';
  const oauth2 = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);
  const authUrl = oauth2.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });

  console.log('\n1) Open this URL in your browser:\n');
  console.log(authUrl + '\n');
  console.log('2) Approve access with the Google account that is Editor on the channel.');
  console.log('3) Google will show a one-time AUTH CODE. Copy it and paste it here.\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const code = await new Promise(res => rl.question('Paste AUTH CODE: ', v => res(v.trim())));
  rl.close();

  const { tokens } = await oauth2.getToken(code);
  await saveTokens(tokens);
}

(async function main() {
  try {
    if (GOOGLE_OAUTH_MODE.toLowerCase() === 'oob') {
      await runOob();
    } else {
      await runLoopback();
    }
  } catch (e) {
    console.error('\nOAuth failed:', e.message || e);
    console.error('Tip: set GOOGLE_OAUTH_MODE=oob to use the manual copy-paste flow.');
    process.exit(1);
  }
})();
