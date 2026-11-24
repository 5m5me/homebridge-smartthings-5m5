import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAuthorizeUrl, exchangeCode, refreshTokens } from '../src/api/oauth.js';
import { AUTHORIZE_URL, TOKEN_URL, OAUTH_SCOPES } from '../src/settings.js';

function fakeFetch(status, body) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  impl.calls = calls;
  return impl;
}

const tokenBody = { access_token: 'AT', refresh_token: 'RT', expires_in: 86399 };
const basic = 'Basic ' + Buffer.from('cid:csecret').toString('base64');

test('buildAuthorizeUrl contains all four query parameters URL-encoded', () => {
  const url = buildAuthorizeUrl({ clientId: 'my id', redirectUri: 'https://example.com/cb?x=1' });
  assert.ok(url.startsWith(AUTHORIZE_URL + '?'));
  const u = new URL(url);
  assert.equal(u.searchParams.get('client_id'), 'my id');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://example.com/cb?x=1');
  assert.equal(u.searchParams.get('scope'), OAUTH_SCOPES);
  assert.ok(url.includes('redirect_uri=https%3A%2F%2Fexample.com%2Fcb%3Fx%3D1'));
  assert.ok(!url.includes(' '));
});

test('exchangeCode sends Basic header and exact form body', async () => {
  const f = fakeFetch(200, tokenBody);
  const out = await exchangeCode({
    clientId: 'cid', clientSecret: 'csecret', code: 'abc', redirectUri: 'https://httpbin.org/get', fetchImpl: f,
  });
  assert.deepEqual(out, { accessToken: 'AT', refreshToken: 'RT', expiresIn: 86399 });
  assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0];
  assert.equal(url, TOKEN_URL);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, basic);
  assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(
    init.body,
    'grant_type=authorization_code&client_id=cid&code=abc&redirect_uri=https%3A%2F%2Fhttpbin.org%2Fget',
  );
});

test('refreshTokens sends Basic header and exact form body', async () => {
  const f = fakeFetch(200, tokenBody);
  const out = await refreshTokens({ clientId: 'cid', clientSecret: 'csecret', refreshToken: 'old', fetchImpl: f });
  assert.deepEqual(out, { accessToken: 'AT', refreshToken: 'RT', expiresIn: 86399 });
  const { url, init } = f.calls[0];
  assert.equal(url, TOKEN_URL);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, basic);
  assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(init.body, 'grant_type=refresh_token&client_id=cid&refresh_token=old');
});

test('a 400 response throws the exact message without the secret', async () => {
  const f = fakeFetch(400, { error: 'invalid_grant' });
  await assert.rejects(
    refreshTokens({ clientId: 'cid', clientSecret: 'csecret', refreshToken: 'old', fetchImpl: f }),
    (err) => {
      assert.equal(err.message, 'SmartThings token request failed: HTTP 400');
      assert.ok(!err.message.includes('csecret'));
      return true;
    },
  );
  await assert.rejects(
    exchangeCode({ clientId: 'cid', clientSecret: 'csecret', code: 'c', redirectUri: 'r', fetchImpl: f }),
    /^Error: SmartThings token request failed: HTTP 400$/,
  );
});

test('a 2xx response without a string access_token throws', async () => {
  for (const body of [{}, { access_token: 42 }, { access_token: null }]) {
    const f = fakeFetch(200, body);
    await assert.rejects(
      refreshTokens({ clientId: 'cid', clientSecret: 'csecret', refreshToken: 'old', fetchImpl: f }),
      (err) => err.message === 'SmartThings token request failed: unexpected response',
    );
  }
});
