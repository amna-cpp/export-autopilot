import 'dotenv/config';
import http from 'node:http';
import { google } from 'googleapis';

// One-time helper: opens Google's consent screen and prints a refresh token.
// gmail.modify lets the bot read mail, add labels, create drafts and send replies.
const SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const PORT = 3000;
const REDIRECT = `http://localhost:${PORT}/oauth2callback`;

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first (see README step 2).');
  process.exit(1);
}

const oauth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT);
const url = oauth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: [SCOPE] });

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  if (u.pathname !== '/oauth2callback') {
    res.writeHead(404).end();
    return;
  }
  const code = u.searchParams.get('code');
  try {
    const { tokens } = await oauth.getToken(code);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('Done. You can close this tab and go back to the terminal.');
    console.log('\nAdd this line to your .env:\n');
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    if (!tokens.refresh_token) {
      console.log('No refresh token returned. Remove the app at https://myaccount.google.com/permissions and run this again.');
    }
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('Something went wrong. Check the terminal.');
    console.error('Token exchange failed:', err.message);
  } finally {
    server.close();
  }
});

server.listen(PORT, () => {
  console.log('Open this link in your browser and sign in with the company Gmail account:\n');
  console.log(url, '\n');
});
