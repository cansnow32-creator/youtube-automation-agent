const express = require('express');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const crypto = require('crypto');
const { YOUTUBE_SCOPES, preserveRefreshToken } = require('./modern-auth');

class OAuthServer {
  constructor() {
    this.app = express();
    this.server = null;
    this.oauthState = null;
    this.codeVerifier = null;
    this.callbackHandled = false;
    this.redirectUri = 'http://127.0.0.1:8080/auth/callback';
    this.setupRoutes();
  }

  setupRoutes() {
    this.app.get('/auth/callback', async (req, res) => {
      const { code, error, state } = req.query;

      if (!this.isValidState(state)) {
        res.status(400).type('text').send('Invalid OAuth state. Authorization callback rejected.');
        return;
      }
      
      if (this.callbackHandled) {
        res.status(409).type('text').send('OAuth callback has already been handled.');
        return;
      }
      if (error) {
        this.callbackHandled = true;
        res.status(400).type('text').send('Authorization was not completed by the provider.');
        this.codeVerifier = null;
        this.oauthState = null;
        this.server?.close();
        return;
      }

      if (!code) {
        res.status(400).type('text').send('Missing authorization code.');
        return;
      }
      this.callbackHandled = true;
      try {
        // Exchange code for tokens
        await this.exchangeCodeForTokens(code);
        
        res.send(`
          <h1>🎉 Authentication Successful!</h1>
          <p>Your YouTube Automation Agent has been successfully authorized!</p>
          <p>You can close this window and return to the terminal.</p>
          <style>
            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
            h1 { color: #4CAF50; }
          </style>
        `);
        
        console.log(chalk.green('\n✅ Authentication successful! Starting YouTube Automation Agent...'));
        
        // Close the server after successful auth
        setTimeout(() => {
          this.server?.close();
          this.server = null;
          this.codeVerifier = null;
          this.oauthState = null;
          this.startMainApplication();
        }, 2000);
        
      } catch (error) {
        console.error(chalk.red('Token exchange failed:'), error.message);
        res.status(500).type('text').send('Token exchange failed. Check the local application log.');
        this.codeVerifier = null;
        this.oauthState = null;
        this.server?.close();
      }
    });

    this.app.get('/', (req, res) => {
      res.send(`
        <h1>🎬 YouTube Automation Agent</h1>
        <p>OAuth callback server is running...</p>
        <p>Please complete the authorization process.</p>
        <style>
          body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
        </style>
      `);
    });
  }

  isValidState(receivedState) {
    if (typeof receivedState !== 'string' || typeof this.oauthState !== 'string') return false;
    const expected = Buffer.from(this.oauthState, 'utf8');
    const received = Buffer.from(receivedState, 'utf8');
    return expected.length === received.length && crypto.timingSafeEqual(expected, received);
  }

  async exchangeCodeForTokens(code) {
    const credentialsPath = path.join(__dirname, 'config', 'credentials.json');
    const tokensPath = path.join(__dirname, 'config', 'tokens.json');
    
    const credentials = JSON.parse(fs.readFileSync(credentialsPath));
    
    const oauth2Client = new google.auth.OAuth2(
      credentials.youtube.client_id,
      credentials.youtube.client_secret,
      this.redirectUri
    );

    const { tokens } = await oauth2Client.getToken({ code, codeVerifier: this.codeVerifier });
    let previousTokens = {};
    try {
      previousTokens = JSON.parse(fs.readFileSync(tokensPath, 'utf8')).youtube || {};
    } catch (_error) {
      // First authorization: there is no previous token to preserve.
    }
    const savedTokens = preserveRefreshToken(previousTokens, tokens);

    // Save tokens without dropping a refresh token omitted by Google on re-consent.
    const tokenData = {
      youtube: savedTokens
    };
    
    fs.writeFileSync(tokensPath, JSON.stringify(tokenData, null, 2), { mode: 0o600 });
    fs.chmodSync(tokensPath, 0o600);
    console.log(chalk.green('✅ Tokens saved successfully!'));
  }

  async startMainApplication() {
    console.log(chalk.cyan('\n🚀 Starting YouTube Automation Agent...'));
    
    // Import and start the main application
    const { spawn } = require('child_process');
    const mainApp = spawn('node', ['index.js'], {
      stdio: 'inherit',
      cwd: __dirname
    });
    
    mainApp.on('close', (code) => {
      console.log(chalk.yellow(`Main application exited with code ${code}`));
    });
  }

  start() {
    this.server = this.app.listen(8080, '127.0.0.1', () => {
      console.log(chalk.cyan('\n🔐 OAuth callback server started on http://localhost:8080'));
      this.generateAuthUrl().catch(error => {
        console.error(chalk.red('OAuth setup failed:'), error.message);
        this.server?.close();
      });
    });
  }

  async generateAuthUrl() {
    const credentialsPath = path.join(__dirname, 'config', 'credentials.json');
    const credentials = JSON.parse(fs.readFileSync(credentialsPath));
    
    const oauth2Client = new google.auth.OAuth2(
      credentials.youtube.client_id,
      credentials.youtube.client_secret,
      this.redirectUri
    );

    this.oauthState = crypto.randomBytes(32).toString('hex');
    this.callbackHandled = false;
    const pkce = await oauth2Client.generateCodeVerifierAsync();
    this.codeVerifier = pkce.codeVerifier;

    const scopes = YOUTUBE_SCOPES;

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      prompt: 'consent',
      state: this.oauthState,
      code_challenge_method: 'S256',
      code_challenge: pkce.codeChallenge
    });

    console.log(chalk.cyan.bold('\n🎬 YouTube Automation Agent - OAuth Setup'));
    console.log(chalk.gray('═'.repeat(60)));
    console.log(chalk.cyan('\n🔗 Please visit this URL to authorize the application:'));
    console.log(chalk.blue.underline(authUrl));
    console.log(chalk.yellow('\nAfter authorization, you will be redirected back automatically.'));
    console.log(chalk.gray('The OAuth server will handle the rest!'));
  }
}

if (require.main === module) {
  // Keep the legacy module export for compatibility, but route direct CLI use
  // through the same state-validated loopback flow as CredentialManager.
  const { ModernAuth } = require('./modern-auth');
  new ModernAuth().authenticate().catch(error => {
    console.error(chalk.red('Authentication failed:'), error.message);
    process.exitCode = 1;
  });
}

module.exports = { OAuthServer };