// Keycloak Authentication Manager
// Handles browser-based OAuth flow for HokiPoki CLI

import crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import http from 'http';
import { URL } from 'url';
import chalk from 'chalk';
import jwt from 'jsonwebtoken';

// Configuration (can be overridden via environment variables)
const KEYCLOAK_ISSUER = process.env.HOKIPOKI_KEYCLOAK_ISSUER
  || 'https://auth.hoki-poki.ai/realms/hokipoki';
const KEYCLOAK_CLIENT_ID = process.env.HOKIPOKI_CLIENT_ID
  || 'hokipoki-cli'; // CLI uses public client (no secret required)
const REDIRECT_URI = 'http://localhost:3333/callback';
const CALLBACK_PORT = 3333;

interface KeycloakToken {
  access_token: string;
  refresh_token: string;
  expires_at: Date;
  id_token?: string;
}

export interface TunnelConfig {
  token: string;
  serverAddr: string;
  serverPort: number;
  tunnelDomain: string;
  httpPort: number;
  fetchedAt: Date;
}

export class KeycloakManager {
  private tokenStorePath: string;
  private tunnelConfigPath: string;
  private encryptionKey: Buffer;
  private backendUrl: string;

  constructor() {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    this.tokenStorePath = path.join(homeDir, '.hokipoki', 'keycloak_token.enc');
    this.tunnelConfigPath = path.join(homeDir, '.hokipoki', 'tunnel_config.enc');
    this.encryptionKey = this.loadOrCreateEncryptionKey();
    this.backendUrl = process.env.BACKEND_URL || 'https://api.hoki-poki.ai';
  }

  private loadOrCreateEncryptionKey(): Buffer {
    const keyPath = path.join(
      process.env.HOME || process.env.USERPROFILE || '',
      '.hokipoki',
      'key.secret'
    );

    try {
      const key = require('fs').readFileSync(keyPath);
      return key;
    } catch {
      const key = crypto.randomBytes(32);
      require('fs').mkdirSync(path.dirname(keyPath), { recursive: true });
      require('fs').writeFileSync(keyPath, key);
      require('fs').chmodSync(keyPath, 0o600);
      return key;
    }
  }

  /**
   * Initiate browser-based OAuth login flow
   */
  async login(): Promise<void> {
    console.log(chalk.cyan('\n🔐 Opening browser for Keycloak authentication...'));

    // Generate PKCE code verifier and challenge
    const codeVerifier = this.generateCodeVerifier();
    const codeChallenge = this.generateCodeChallenge(codeVerifier);

    // Build authorization URL
    const state = crypto.randomBytes(16).toString('hex');
    const authUrl = new URL(`${KEYCLOAK_ISSUER}/protocol/openid-connect/auth`);
    authUrl.searchParams.set('client_id', KEYCLOAK_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'openid email profile');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    // Start local callback server and open browser
    const authorizationCode = await this.startCallbackServer(state, authUrl.toString());

    // Exchange authorization code for tokens
    await this.exchangeCodeForTokens(authorizationCode, codeVerifier);

    const userEmail = await this.getUserEmail();

    // Check if email is verified
    const isVerified = await this.checkEmailVerified(userEmail);
    if (!isVerified) {
      // Delete the token - don't allow unverified login
      try {
        await fs.unlink(this.tokenStorePath);
      } catch {}

      console.log(chalk.red('\n❌ Email not verified'));
      console.log(chalk.yellow(`\n📧 Please verify your email address: ${userEmail}`));
      console.log(chalk.cyan('   Check your inbox for the verification link.'));
      console.log(chalk.cyan('   Or visit: https://app.hoki-poki.ai/verify-email\n'));
      throw new Error('Email not verified. Please check your inbox for the verification link.');
    }

    console.log(chalk.green(`\n✅ Successfully logged in as: ${userEmail}`));
    console.log(chalk.gray('💾 Token saved securely\n'));
  }

  /**
   * Check if user's email is verified via backend API
   */
  private async checkEmailVerified(email: string): Promise<boolean> {
    try {
      const response = await fetch(
        `${this.backendUrl}/api/auth/check-verified?email=${encodeURIComponent(email)}`
      );

      if (!response.ok) {
        // If we can't check, assume verified (backend might not have this endpoint yet)
        return true;
      }

      const data = await response.json() as any;
      return data.verified === true;
    } catch {
      // If check fails, assume verified (network error, etc.)
      return true;
    }
  }

  /**
   * Start local HTTP server to receive OAuth callback
   */
  private async startCallbackServer(expectedState: string, authUrl: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        if (!req.url?.startsWith('/callback')) {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }

        const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
            <!DOCTYPE html>
            <html>
              <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>HokiPoki - Authentication Failed</title>
                <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
                <style>
                  * { margin: 0; padding: 0; box-sizing: border-box; }
                  body {
                    font-family: 'JetBrains Mono', 'Courier New', Consolas, monospace;
                    background: #000000;
                    color: #00ffff;
                    min-height: 100vh;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 20px;
                    font-size: 14px;
                  }
                  .container {
                    background: #000000;
                    border: 1px solid #4d6650;
                    padding: 2rem;
                    max-width: 28rem;
                    width: 100%;
                  }
                  .header {
                    border-bottom: 1px solid #4d6650;
                    padding-bottom: 1rem;
                    margin-bottom: 2rem;
                  }
                  .logo {
                    font-size: 1.5rem;
                    font-weight: bold;
                    text-transform: uppercase;
                    letter-spacing: 0.1em;
                    color: #00ffff;
                  }
                  .logo::before { content: "> "; }
                  .logo::after { content: "_"; animation: blink 1s infinite; }
                  @keyframes blink { 0%, 50% { opacity: 1; } 51%, 100% { opacity: 0; } }
                  .error-message {
                    border: 1px solid #ff0000;
                    background: rgba(255, 0, 0, 0.1);
                    padding: 0.75rem;
                    margin-bottom: 1.5rem;
                    font-size: 12px;
                    font-weight: bold;
                    text-transform: uppercase;
                    color: #ff0000;
                  }
                  .error-message::before { content: "[ERROR] "; }
                  p {
                    color: #00ffff;
                    font-size: 14px;
                    line-height: 1.6;
                    margin-bottom: 1rem;
                  }
                  .footer {
                    border-top: 1px solid #4d6650;
                    margin-top: 1.5rem;
                    padding-top: 1rem;
                    font-size: 9px;
                    font-weight: bold;
                    text-transform: uppercase;
                    color: #808080;
                  }
                </style>
              </head>
              <body>
                <div class="container">
                  <div class="header">
                    <div class="logo">HOKIPOKI</div>
                  </div>
                  <div class="error-message">Authentication Failed</div>
                  <p>Error: ${error}</p>
                  <p>You can close this window and try again.</p>
                  <div class="footer">🔒 SECURE AUTH</div>
                </div>
              </body>
            </html>
          `);
          server.close();
          reject(new Error(`Authentication failed: ${error}`));
          return;
        }

        if (!code || state !== expectedState) {
          res.writeHead(400);
          res.end('Invalid callback');
          server.close();
          reject(new Error('Invalid callback parameters'));
          return;
        }

        // Success!
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <!DOCTYPE html>
          <html>
            <head>
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title>HokiPoki - Authentication Successful</title>
              <link rel="preconnect" href="https://fonts.googleapis.com">
              <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
              <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
              <style>
                * {
                  margin: 0;
                  padding: 0;
                  box-sizing: border-box;
                }

                body {
                  font-family: 'JetBrains Mono', 'Courier New', Consolas, monospace;
                  background: #000000;
                  color: #00ffff;
                  min-height: 100vh;
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  padding: 20px;
                  font-size: 14px;
                  line-height: 1.5;
                }

                .container {
                  background: #000000;
                  border: 1px solid #4d6650;
                  padding: 2rem;
                  max-width: 28rem;
                  width: 100%;
                }

                .header {
                  border-bottom: 1px solid #4d6650;
                  padding-bottom: 1rem;
                  margin-bottom: 2rem;
                }

                .logo {
                  font-size: 1.5rem;
                  font-weight: bold;
                  text-transform: uppercase;
                  letter-spacing: 0.1em;
                  color: #00ffff;
                }

                .logo::before {
                  content: "> ";
                  color: #00ffff;
                }

                .logo::after {
                  content: "_";
                  animation: blink 1s infinite;
                }

                @keyframes blink {
                  0%, 50% { opacity: 1; }
                  51%, 100% { opacity: 0; }
                }

                .subtitle {
                  margin-top: 0.5rem;
                  font-size: 10px;
                  font-weight: bold;
                  text-transform: uppercase;
                  letter-spacing: 0.05em;
                  color: #808080;
                }

                .success-message {
                  border: 1px solid #4d6650;
                  background: rgba(77, 102, 80, 0.1);
                  padding: 0.75rem;
                  margin-bottom: 1.5rem;
                  font-size: 12px;
                  font-weight: bold;
                  text-transform: uppercase;
                }

                .success-message::before {
                  content: "[SUCCESS] ";
                  color: #4d6650;
                }

                .success-message-text {
                  color: #4d6650;
                }

                .success-icon {
                  text-align: center;
                  margin: 1.5rem 0;
                  animation: bounce 0.6s ease;
                }

                .success-icon svg {
                  width: 64px;
                  height: 64px;
                }

                @keyframes bounce {
                  0%, 100% { transform: scale(1); }
                  50% { transform: scale(1.1); }
                }

                p {
                  color: #00ffff;
                  font-size: 14px;
                  line-height: 1.6;
                  margin-bottom: 1.5rem;
                }

                .instructions {
                  border: 1px solid #4d6650;
                  background: rgba(77, 102, 80, 0.05);
                  padding: 1rem;
                  margin-top: 1.5rem;
                }

                .instructions-title {
                  font-size: 10px;
                  font-weight: bold;
                  text-transform: uppercase;
                  letter-spacing: 0.05em;
                  color: #808080;
                  margin-bottom: 0.75rem;
                }

                .instructions code {
                  background: rgba(0, 255, 255, 0.1);
                  border: 1px solid #00ffff;
                  padding: 0.125rem 0.5rem;
                  color: #00ffff;
                  font-family: 'JetBrains Mono', 'Courier New', Consolas, monospace;
                  font-size: 12px;
                  white-space: nowrap;
                }

                .footer {
                  border-top: 1px solid #4d6650;
                  margin-top: 1.5rem;
                  padding-top: 1rem;
                  font-size: 9px;
                  font-weight: bold;
                  text-transform: uppercase;
                  letter-spacing: 0.025em;
                  color: #808080;
                }
              </style>
            </head>
            <body>
              <div class="container">
                <div class="header">
                  <div class="logo">HOKIPOKI</div>
                  <div class="subtitle">Decentralized P2P AI Tool Marketplace</div>
                </div>

                <div class="success-message">
                  <span class="success-message-text">Authentication Successful!</span>
                </div>

                <div class="success-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="#4d6650" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10" fill="rgba(77, 102, 80, 0.2)" stroke="#4d6650"/>
                    <path d="M9 12l2 2 4-4" stroke="#4d6650"/>
                  </svg>
                </div>

                <p>You've successfully authenticated with HokiPoki.</p>
                <p>You can close this window and return to your terminal.</p>

                <div class="instructions">
                  <div class="instructions-title">Next steps:</div>
                  <p style="font-size: 12px; margin: 0; color: #00ffff;">
                    Return to your terminal and run <code>hokipoki listen</code> or <code>hokipoki request</code> to start using HokiPoki.
                  </p>
                </div>

                <div class="footer">
                  🔒 SECURE AUTH<br>
                  🎵 That's what it's all about! 🎵
                </div>
              </div>
            </body>
          </html>
        `);

        server.close();
        resolve(code);
      });

      server.listen(CALLBACK_PORT, () => {
        console.log(chalk.gray(`🌐 Started local callback server on http://localhost:${CALLBACK_PORT}...`));
        console.log(chalk.gray(`⏳ Waiting for authentication...\n`));

        // Open browser
        this.openBrowser(authUrl);
      });

      server.on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * Open system browser
   */
  private openBrowser(url: string): void {
    const { exec } = require('child_process');
    const command = process.platform === 'darwin' ? 'open' :
                   process.platform === 'win32' ? 'start' : 'xdg-open';

    exec(`${command} "${url}"`, (error: Error | null) => {
      if (error) {
        console.error(chalk.yellow('⚠️  Could not open browser automatically.'));
        console.log(chalk.cyan(`Please visit: ${url}`));
      }
    });
  }

  /**
   * Exchange authorization code for tokens
   */
  private async exchangeCodeForTokens(code: string, codeVerifier: string): Promise<void> {
    const tokenUrl = `${KEYCLOAK_ISSUER}/protocol/openid-connect/token`;

    const params = new URLSearchParams();
    params.set('grant_type', 'authorization_code');
    params.set('client_id', KEYCLOAK_CLIENT_ID);
    params.set('code', code);
    params.set('redirect_uri', REDIRECT_URI);
    params.set('code_verifier', codeVerifier);

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token exchange failed: ${error}`);
    }

    const data = await response.json() as any;

    const token: KeycloakToken = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      id_token: data.id_token,
      expires_at: new Date(Date.now() + data.expires_in * 1000),
    };

    await this.storeToken(token);
  }

  /**
   * Store encrypted token
   */
  private async storeToken(token: KeycloakToken): Promise<void> {
    const jsonStr = JSON.stringify(token);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(
      'aes-256-gcm',
      this.encryptionKey,
      iv
    );

    let encrypted = cipher.update(jsonStr, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    const encryptedData = {
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex'),
      data: encrypted
    };

    await fs.mkdir(path.dirname(this.tokenStorePath), { recursive: true });
    await fs.writeFile(this.tokenStorePath, JSON.stringify(encryptedData));
    await fs.chmod(this.tokenStorePath, 0o600);
  }

  /**
   * Load and decrypt token
   */
  private async loadToken(): Promise<KeycloakToken | null> {
    try {
      const encryptedData = JSON.parse(
        await fs.readFile(this.tokenStorePath, 'utf8')
      );

      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        this.encryptionKey,
        Buffer.from(encryptedData.iv, 'hex')
      );

      decipher.setAuthTag(Buffer.from(encryptedData.authTag, 'hex'));

      let decrypted = decipher.update(encryptedData.data, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      const token = JSON.parse(decrypted);
      // Convert expires_at back to Date
      token.expires_at = new Date(token.expires_at);
      return token;
    } catch {
      return null;
    }
  }

  /**
   * Get valid access token (auto-refresh if expired)
   */
  async getToken(): Promise<string> {
    const token = await this.loadToken();

    if (!token) {
      throw new Error('Not authenticated. Please run: hokipoki login');
    }

    // Check if token is expired (with 5 minute buffer)
    const expiresIn = token.expires_at.getTime() - Date.now();
    if (expiresIn < 5 * 60 * 1000) {
      // Token expired or expiring soon, refresh it
      await this.refreshToken(token.refresh_token);
      const newToken = await this.loadToken();
      return newToken!.access_token;
    }

    return token.access_token;
  }

  /**
   * Refresh access token using refresh token
   */
  private async refreshToken(refreshToken: string): Promise<void> {
    const tokenUrl = `${KEYCLOAK_ISSUER}/protocol/openid-connect/token`;

    const params = new URLSearchParams();
    params.set('grant_type', 'refresh_token');
    params.set('client_id', KEYCLOAK_CLIENT_ID);
    params.set('refresh_token', refreshToken);

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      throw new Error('Token refresh failed. Please login again: hokipoki login');
    }

    const data = await response.json() as any;

    const token: KeycloakToken = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      id_token: data.id_token,
      expires_at: new Date(Date.now() + data.expires_in * 1000),
    };

    await this.storeToken(token);
  }

  /**
   * Check if user is authenticated
   */
  async isAuthenticated(): Promise<boolean> {
    try {
      await this.getToken();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get user email from token
   */
  async getUserEmail(): Promise<string> {
    const token = await this.getToken();
    const decoded = jwt.decode(token) as any;
    return decoded?.email || decoded?.preferred_username || 'Unknown';
  }

  /**
   * Logout (terminate Keycloak session and delete local token)
   */
  async logout(): Promise<void> {
    try {
      // Load token to get id_token for proper OIDC logout
      const token = await this.loadToken();

      if (token && token.id_token) {
        // Call Keycloak's end_session_endpoint to terminate server-side session
        const logoutUrl = `${KEYCLOAK_ISSUER}/protocol/openid-connect/logout`;
        const params = new URLSearchParams();
        params.set('client_id', KEYCLOAK_CLIENT_ID);
        params.set('id_token_hint', token.id_token);

        try {
          await fetch(`${logoutUrl}?${params.toString()}`, {
            method: 'GET',
          });
        } catch (error) {
          // Continue with local logout even if remote logout fails
          console.log(chalk.yellow('⚠️  Could not reach Keycloak server, logging out locally\n'));
        }
      }

      // Delete local token file
      await fs.unlink(this.tokenStorePath);

      // Also clear cached tunnel config
      await this.clearTunnelConfig();

      console.log(chalk.green('✅ Logged out successfully'));
      console.log(chalk.gray('🗑️  Session terminated\n'));
    } catch {
      console.log(chalk.yellow('⚠️  No active session found\n'));
    }
  }

  /**
   * Generate PKCE code verifier
   */
  private generateCodeVerifier(): string {
    return crypto.randomBytes(32).toString('base64url');
  }

  /**
   * Generate PKCE code challenge from verifier
   */
  private generateCodeChallenge(verifier: string): string {
    return crypto
      .createHash('sha256')
      .update(verifier)
      .digest('base64url');
  }

  /**
   * Get tunnel configuration (fetches from backend if not cached or expired)
   * Cache expires after 24 hours to allow for token rotation
   */
  async getTunnelConfig(): Promise<TunnelConfig> {
    // Try to load cached config first
    const cached = await this.loadTunnelConfig();

    if (cached) {
      // Check if cache is still valid (less than 24 hours old)
      const cacheAge = Date.now() - new Date(cached.fetchedAt).getTime();
      const maxAge = 24 * 60 * 60 * 1000; // 24 hours

      if (cacheAge < maxAge) {
        return cached;
      }
    }

    // Fetch fresh config from backend
    return await this.fetchAndCacheTunnelConfig();
  }

  /**
   * Fetch tunnel config from backend and cache it
   */
  private async fetchAndCacheTunnelConfig(): Promise<TunnelConfig> {
    const accessToken = await this.getToken();

    const response = await fetch(`${this.backendUrl}/api/tunnel/token`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get tunnel config: ${error}`);
    }

    const data = await response.json() as any;

    const config: TunnelConfig = {
      token: data.token,
      serverAddr: data.serverAddr,
      serverPort: data.serverPort,
      tunnelDomain: data.tunnelDomain,
      httpPort: data.httpPort,
      fetchedAt: new Date(),
    };

    // Cache the config
    await this.storeTunnelConfig(config);

    return config;
  }

  /**
   * Store encrypted tunnel config
   */
  private async storeTunnelConfig(config: TunnelConfig): Promise<void> {
    const jsonStr = JSON.stringify(config);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(
      'aes-256-gcm',
      this.encryptionKey,
      iv
    );

    let encrypted = cipher.update(jsonStr, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    const encryptedData = {
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex'),
      data: encrypted
    };

    await fs.mkdir(path.dirname(this.tunnelConfigPath), { recursive: true });
    await fs.writeFile(this.tunnelConfigPath, JSON.stringify(encryptedData));
    await fs.chmod(this.tunnelConfigPath, 0o600);
  }

  /**
   * Load and decrypt tunnel config
   */
  private async loadTunnelConfig(): Promise<TunnelConfig | null> {
    try {
      const encryptedData = JSON.parse(
        await fs.readFile(this.tunnelConfigPath, 'utf8')
      );

      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        this.encryptionKey,
        Buffer.from(encryptedData.iv, 'hex')
      );

      decipher.setAuthTag(Buffer.from(encryptedData.authTag, 'hex'));

      let decrypted = decipher.update(encryptedData.data, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      const config = JSON.parse(decrypted);
      // Convert fetchedAt back to Date
      config.fetchedAt = new Date(config.fetchedAt);
      return config;
    } catch {
      return null;
    }
  }

  /**
   * Clear cached tunnel config (useful when logging out)
   */
  async clearTunnelConfig(): Promise<void> {
    try {
      await fs.unlink(this.tunnelConfigPath);
    } catch {
      // File might not exist, that's okay
    }
  }
}