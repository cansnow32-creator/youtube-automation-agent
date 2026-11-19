const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

// Narrow OAuth permissions to the APIs this agent actually calls. Avoid the
// broader youtube account-management scope; force-ssl covers Data API writes.
const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
  'https://www.googleapis.com/auth/youtube.force-ssl'
];

function preserveRefreshToken(previousTokens, receivedTokens) {
  const next = { ...(receivedTokens || {}) };
  if (!next.refresh_token && previousTokens?.refresh_token) {
    next.refresh_token = previousTokens.refresh_token;
  }
  return next;
}

class ModernAuth {
  constructor() {
    this.credentialsPath = path.join(__dirname, 'config', 'credentials.json');
    this.tokensPath = path.join(__dirname, 'config', 'tokens.json');
    this.server = null;
    this.oauthState = null;
  }

  async authenticate() {
    console.log(chalk.cyan.bold('\n🔐 YouTube Authentication (Modern Flow)'));
    console.log(chalk.gray('═'.repeat(60)));
    
    try {
      const credentials = JSON.parse(fs.readFileSync(this.credentialsPath));
      
      const redirect = this.resolveRedirect(credentials);
      const redirectUri = redirect.uri;
      
      const oauth2Client = new google.auth.OAuth2(
        credentials.youtube.client_id,
        credentials.youtube.client_secret,
        redirectUri
      );

      this.oauthState = crypto.randomBytes(32).toString('hex');

      const scopes = YOUTUBE_SCOPES;

      const authResult = new Promise((resolve, reject) => {
        this.resolveAuth = resolve;
        this.rejectAuth = reject;
        this.authTimeout = setTimeout(() => {
          this.cleanup();
          reject(new Error('Authentication timeout (5 minutes)'));
        }, 300000);
      });

      // Start a temporary local server at the exact redirect URI used in the OAuth request.
      await this.startTempServer(redirect, oauth2Client);
      
      // Generate auth URL
      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: scopes,
        prompt: 'consent',
        state: this.oauthState
      });

      console.log(chalk.cyan('🔗 Please visit this URL to authorize:'));
      console.log(chalk.blue(authUrl));

      // Best effort: open the URL in the default browser
      const { exec } = require('child_process');
      const openCommands = {
        win32: `start "" "${authUrl}"`,
        darwin: `open "${authUrl}"`,
        linux: `xdg-open "${authUrl}"`
      };
      if (openCommands[process.platform]) {
        exec(openCommands[process.platform], () => {});
      }
      console.log(chalk.yellow(`\n⚡ A temporary server is running on port ${redirect.port}`));
      console.log(chalk.yellow('After authorization, you\'ll be redirected automatically.'));
      console.log(chalk.gray('Waiting for authorization...'));
      
      // The server will handle the rest
      return authResult;
      
    } catch (error) {
      this.cleanup();
      console.error(chalk.red('Authentication failed:'), error.message);
      throw error;
    }
  }

  resolveRedirect(credentials) {
    const explicitRedirect = process.env.YOUTUBE_REDIRECT_URI;
    const configured = [explicitRedirect, ...(credentials.youtube?.redirect_uris || [])].filter(Boolean);
    const legacyGeneratedRedirect = /^http:\/\/localhost:8080\/(?:oauth2callback|callback)\/?$/i;
    let redirect = null;
    for (const value of configured) {
      if (!explicitRedirect && legacyGeneratedRedirect.test(value)) continue;
      try {
        const candidate = new URL(value);
        if (candidate.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(candidate.hostname)) {
          redirect = candidate;
          break;
        }
      } catch (_error) {
        // Ignore obsolete out-of-band and malformed redirect values.
      }
    }
    redirect ||= new URL('http://127.0.0.1/');
    if (!redirect.port) redirect.port = String(8000 + Math.floor(Math.random() * 1000));
    return {
      uri: redirect.toString(),
      hostname: redirect.hostname,
      port: Number(redirect.port),
      pathname: redirect.pathname || '/'
    };
  }

  isValidOAuthState(receivedState) {
    if (typeof receivedState !== 'string' || typeof this.oauthState !== 'string') return false;
    const expected = Buffer.from(this.oauthState, 'utf8');
    const received = Buffer.from(receivedState, 'utf8');
    return expected.length === received.length && crypto.timingSafeEqual(expected, received);
  }

  async startTempServer(redirect, oauth2Client) {
    this.server = http.createServer(async (req, res) => {
      const url = new URL(req.url, redirect.uri);
      
      if (url.pathname === redirect.pathname) {
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        const state = url.searchParams.get('state');

        if (!this.isValidOAuthState(state)) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Invalid OAuth state. Authorization callback rejected.');
          return;
        }
        
        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(`Authorization error: ${error}. You can close this window.`);
          this.rejectAuth(new Error(`Authorization error: ${error}`));
          return;
        }
        
        if (code) {
          try {
            const { tokens } = await oauth2Client.getToken(code);
            
            // Google may omit refresh_token on later authorizations. Keep the existing
            // one so a re-consent cannot silently break unattended access.
            let previousTokens = {};
            try {
              previousTokens = JSON.parse(fs.readFileSync(this.tokensPath, 'utf8')).youtube || {};
            } catch (_error) {
              // First authorization: there is no prior token file to preserve.
            }
            const savedTokens = preserveRefreshToken(previousTokens, tokens);

            // Save tokens
            const tokenData = { youtube: savedTokens };
            fs.writeFileSync(this.tokensPath, JSON.stringify(tokenData, null, 2), { mode: 0o600 });
            fs.chmodSync(this.tokensPath, 0o600);
            
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`
              <html>
                <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
                  <h1 style="color: #4CAF50;">🎉 Authentication Successful!</h1>
                  <p>Your YouTube Automation Agent has been authorized!</p>
                  <p><strong>"Ethereal Dreamscript"</strong> is ready for automation.</p>
                  <p>You can close this window and return to the terminal.</p>
                </body>
              </html>
            `);
            
            console.log(chalk.green('\n✅ Authentication successful!'));
            this.cleanup();
            this.resolveAuth(savedTokens);
            
          } catch (tokenError) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(`Token exchange failed: ${tokenError.message}`);
            this.rejectAuth(tokenError);
          }
        }
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html>
            <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
              <h1>🎬 YouTube Automation Agent</h1>
              <p>Waiting for OAuth callback...</p>
              <p>Please complete the authorization in the other tab.</p>
            </body>
          </html>
        `);
      }
    });
    
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(redirect.port, redirect.hostname, resolve);
    });
    console.log(chalk.gray(`Temporary OAuth server started on ${redirect.uri}`));
  }
  
  cleanup() {
    if (this.authTimeout) {
      clearTimeout(this.authTimeout);
      this.authTimeout = null;
    }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.oauthState = null;
  }

  async testAuthentication() {
    try {
      const tokens = JSON.parse(fs.readFileSync(this.tokensPath));
      const credentials = JSON.parse(fs.readFileSync(this.credentialsPath));
      
      const oauth2Client = new google.auth.OAuth2(
        credentials.youtube.client_id,
        credentials.youtube.client_secret
      );
      
      oauth2Client.setCredentials(tokens.youtube);
      
      const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
      const response = await youtube.channels.list({
        part: 'snippet',
        mine: true
      });
      
      if (response.data.items && response.data.items.length > 0) {
        const channel = response.data.items[0];
        console.log(chalk.green(`✅ Connected to channel: ${channel.snippet.title}`));
        console.log(chalk.gray(`   Channel ID: ${channel.id}`));
        console.log(chalk.gray(`   Subscribers: ${channel.statistics?.subscriberCount || 'Hidden'}`));
        return true;
      } else {
        console.log(chalk.red('❌ No channel found'));
        return false;
      }
    } catch (error) {
      console.error(chalk.red('Authentication test failed:'), error.message);
      return false;
    }
  }
}

async function runAuth() {
  const auth = new ModernAuth();
  
  try {
    await auth.authenticate();
    
    console.log(chalk.cyan('\n🧪 Testing authentication...'));
    const success = await auth.testAuthentication();
    
    if (success) {
      console.log(chalk.green.bold('\n🎉 Authentication Complete!'));
      console.log(chalk.cyan('Your "Ethereal Dreamscript" YouTube automation is ready!'));
      console.log(chalk.yellow('\n📋 Next Steps:'));
      console.log(chalk.white('1. Run: npm start'));
      console.log(chalk.white('2. Visit: http://localhost:3456'));
      console.log(chalk.white('3. Your first video will be generated within 24 hours!'));
    } else {
      console.log(chalk.red('\n❌ Authentication test failed.'));
    }
  } catch (error) {
    console.error(chalk.red('\nAuthentication failed:'), error.message);
    if (error.message.includes('timeout')) {
      console.log(chalk.yellow('\n💡 Try again - the authorization window might have closed.'));
    }
    process.exit(1);
  }
}

if (require.main === module) {
  runAuth();
}

module.exports = { ModernAuth, preserveRefreshToken, YOUTUBE_SCOPES };
