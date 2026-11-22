const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { google } = require('googleapis');
const { ModernAuth } = require('../modern-auth');
const { OAuthServer } = require('../oauth-server');

function request(port, pathname, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function run() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttube-oauth-pkce-'));
  const auth = new ModernAuth();
  auth.tokensPath = path.join(tempDir, 'tokens.json');
  fs.writeFileSync(auth.tokensPath, JSON.stringify({ youtube: { refresh_token: 'existing-refresh-token' } }));
  auth.oauthState = 'expected-state-value';
  auth.codeVerifier = 'test-pkce-verifier';
  auth.callbackHandled = false;

  let resolveExchange;
  let signalExchange;
  const exchangeStarted = new Promise(resolve => { signalExchange = resolve; });
  let exchangeArgs;
  const oauth2Client = {
    getToken: options => {
      exchangeArgs = options;
      signalExchange();
      return new Promise(resolve => { resolveExchange = resolve; });
    }
  };

  let resolveAuth;
  let rejectAuth;
  const authResult = new Promise((resolve, reject) => {
    resolveAuth = resolve;
    rejectAuth = reject;
  });
  authResult.catch(() => {});
  auth.resolveAuth = resolveAuth;
  auth.rejectAuth = rejectAuth;

  try {
    assert.strictEqual(OAuthServer.prototype.generateAuthUrl.constructor.name, 'AsyncFunction', 'legacy OAuth URL generation must be async when using PKCE');
    assert.strictEqual(new OAuthServer().redirectUri, 'http://127.0.0.1:8080/auth/callback', 'legacy OAuth redirect must match its bound loopback callback');
    const pkceClient = new google.auth.OAuth2('test-client', 'test-secret', 'http://127.0.0.1/callback');
    const generated = await pkceClient.generateCodeVerifierAsync();
    assert.match(generated.codeVerifier, /^[A-Za-z0-9._~-]{43,128}$/);
    assert.match(generated.codeChallenge, /^[A-Za-z0-9_-]{43}$/);
    const authorizeUrl = new URL(pkceClient.generateAuthUrl({
      scope: ['https://www.googleapis.com/auth/youtube.upload'],
      code_challenge_method: 'S256',
      code_challenge: generated.codeChallenge
    }));
    assert.strictEqual(authorizeUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.strictEqual(authorizeUrl.searchParams.get('code_challenge'), generated.codeChallenge);

    await auth.startTempServer({
      uri: 'http://127.0.0.1:0/callback',
      hostname: '127.0.0.1',
      port: 0,
      pathname: '/callback'
    }, oauth2Client);
    const port = auth.server.address().port;

    const invalid = await request(port, '/callback?code=attacker-code&state=wrong-state');
    assert.strictEqual(invalid.status, 400, 'invalid state must be rejected');
    assert.strictEqual(exchangeArgs, undefined, 'invalid state must not exchange a code');

    const wrongMethod = await request(port, '/callback?code=ignored&state=expected-state-value', 'POST');
    assert.strictEqual(wrongMethod.status, 405, 'non-GET callbacks must be rejected');

    const firstCallback = request(port, '/callback?code=valid-code&state=expected-state-value');
    await exchangeStarted;
    assert.deepStrictEqual(exchangeArgs, {
      code: 'valid-code',
      codeVerifier: 'test-pkce-verifier'
    }, 'token exchange must include the matching PKCE verifier');

    const replay = await request(port, '/callback?code=replay-code&state=expected-state-value');
    assert.strictEqual(replay.status, 409, 'a second valid callback must not be processed');

    resolveExchange({ tokens: { access_token: 'test-access-token' } });
    const callbackResponse = await firstCallback;
    assert.strictEqual(callbackResponse.status, 200);
    const saved = await authResult;
    assert.strictEqual(saved.access_token, 'test-access-token');

    const persisted = JSON.parse(fs.readFileSync(auth.tokensPath, 'utf8'));
    assert.strictEqual(persisted.youtube.refresh_token, 'existing-refresh-token', 're-consent must preserve the existing refresh token when Google omits it');
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(auth.tokensPath).mode & 0o777, 0o600, 'token file must be private');
    }
  } catch (error) {
    auth.cleanup();
    rejectAuth(error);
    throw error;
  } finally {
    auth.cleanup();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('OAuth PKCE callback tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
