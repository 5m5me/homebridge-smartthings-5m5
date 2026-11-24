#!/usr/bin/env node
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { buildAuthorizeUrl, exchangeCode } from '../src/api/oauth.js';
import { PLATFORM_NAME } from '../src/settings.js';

const USAGE = `Usage: smartthings-5m5-oauth --client-id <id> [--client-secret <secret>] [--redirect-uri <uri>]

Options:
  --client-id       OAuth client ID of your SmartThings API-Access app
  --client-secret   OAuth client secret of your SmartThings API-Access app
                    (or set the ST_CLIENT_SECRET environment variable)
  --redirect-uri    Redirect URI registered for the app (default: https://httpbin.org/get)
  -h, --help        Show this help

The tool prints an authorize URL. Open it, approve access, then paste the
"code" value from the redirected URL back here. The refresh token and a
config snippet are printed for you to paste into Homebridge.`;

function ask(rl, question) {
  return new Promise((resolve) => {
    rl.once('close', () => resolve(null));
    rl.question(question, resolve);
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      'client-id': { type: 'string' },
      'client-secret': { type: 'string' },
      'redirect-uri': { type: 'string', default: 'https://httpbin.org/get' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const clientId = values['client-id'];
  const clientSecret = values['client-secret'] ?? process.env.ST_CLIENT_SECRET;
  const redirectUri = values['redirect-uri'];
  if (!clientId || !clientSecret) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  console.log('Open this URL in a browser and approve access:\n');
  console.log(buildAuthorizeUrl({ clientId, redirectUri }));
  console.log('');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await ask(rl, 'Paste the code from the redirected URL: ');
  rl.close();
  if (answer === null) {
    console.error('Input closed before a code was entered.');
    process.exitCode = 1;
    return;
  }
  const code = answer.trim();
  if (!code) {
    console.error('No code entered.');
    process.exitCode = 1;
    return;
  }

  const tokens = await exchangeCode({ clientId, clientSecret, code, redirectUri });
  console.log(`\nRefresh token: ${tokens.refreshToken}\n`);
  console.log('Add this to your Homebridge platform config:\n');
  console.log(JSON.stringify({
    platform: PLATFORM_NAME,
    oauth: { clientId, clientSecret, refreshToken: tokens.refreshToken },
  }, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
