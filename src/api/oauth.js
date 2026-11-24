import { AUTHORIZE_URL, TOKEN_URL, OAUTH_SCOPES } from '../settings.js';

export function buildAuthorizeUrl({ clientId, redirectUri }) {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: OAUTH_SCOPES,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function tokenRequest({ clientId, clientSecret, params, fetchImpl }) {
  const doFetch = fetchImpl ?? fetch;
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await doFetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  if (!res.ok) {
    throw new Error(`SmartThings token request failed: HTTP ${res.status}`);
  }
  const body = await res.json();
  if (typeof body?.access_token !== 'string' || !body.access_token) {
    throw new Error('SmartThings token request failed: unexpected response');
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresIn: body.expires_in,
  };
}

export async function exchangeCode({ clientId, clientSecret, code, redirectUri, fetchImpl }) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
  });
  return tokenRequest({ clientId, clientSecret, params, fetchImpl });
}

export async function refreshTokens({ clientId, clientSecret, refreshToken, fetchImpl }) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
  });
  return tokenRequest({ clientId, clientSecret, params, fetchImpl });
}
