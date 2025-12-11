// OAuth Manager for AI CLI Authentication
// Handles browser-based OAuth flow for various AI tools

// import express from 'express'; // Will be used when OAuth server is implemented
import crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
// import { exec } from 'child_process'; // Will be used when OAuth server is implemented
// import { promisify } from 'util'; // Will be used when OAuth server is implemented
import chalk from 'chalk';

interface OAuthToken {
  tool: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  encryptedAt: Date;
}

/*
// Will be used when OAuth configuration is implemented
interface OAuthConfig {
  claude: {
    authUrl: string;
    tokenUrl: string;
    clientId: string;
    scope: string;
  };
  codex: {
    authUrl: string;
    tokenUrl: string;
    clientId: string;
    scope: string;
  };
  gemini: {
    authUrl: string;
    tokenUrl: string;
    clientId: string;
    scope: string;
  };
}
*/

export class OAuthManager {
  private tokenStorePath: string;
  private encryptionKey: Buffer;
  // private server?: any; // Will be used when OAuth server is implemented

  constructor() {
    // Store tokens in user's home directory
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    this.tokenStorePath = path.join(homeDir, '.hokipoki', 'tokens.enc');

    // Generate or load encryption key
    this.encryptionKey = this.loadOrCreateEncryptionKey();
  }

  private loadOrCreateEncryptionKey(): Buffer {
    const keyPath = path.join(
      process.env.HOME || process.env.USERPROFILE || '',
      '.hokipoki',
      'key.secret'
    );

    try {
      // Try to load existing key
      const key = require('fs').readFileSync(keyPath);
      return key;
    } catch {
      // Generate new key
      const key = crypto.randomBytes(32);
      require('fs').mkdirSync(path.dirname(keyPath), { recursive: true });
      require('fs').writeFileSync(keyPath, key);
      require('fs').chmodSync(keyPath, 0o600); // Read/write for owner only
      return key;
    }
  }

  /**
   * Initiate OAuth flow for a specific tool
   */
  async authenticate(tool: string): Promise<OAuthToken> {
    console.log(chalk.cyan(`\n🔐 Authenticating ${tool}...`));

    if (tool === 'claude') {
      // Use real Claude CLI authentication
      return await this.authenticateClaude(tool);
    } else if (tool === 'codex') {
      // For Codex, just read from existing auth file (user must run `codex login` manually first)
      return await this.authenticateCodexFromFile();
    } else if (tool === 'gemini') {
      // For Gemini, read from existing OAuth file (user must have authenticated via Gemini CLI)
      return await this.authenticateGeminiFromFile();
    } else {
      // For other tools, simulate for now
      console.log(chalk.gray('Opening browser for authentication...'));
      await this.simulateOAuthFlow(tool);

      const token: OAuthToken = {
        tool,
        accessToken: this.generateMockToken(tool),
        refreshToken: this.generateMockToken(tool + '-refresh'),
        expiresAt: new Date(Date.now() + 3600 * 1000),
        encryptedAt: new Date()
      };

      await this.storeToken(token);
      console.log(chalk.green(`✅ ${tool} authenticated successfully`));
      return token;
    }
  }

  /**
   * Authenticate Codex by reading from existing auth file
   * User must have already run `codex login` to create ~/.codex/auth.json
   */
  private async authenticateCodexFromFile(): Promise<OAuthToken> {
    console.log(chalk.cyan(`\n📂 Reading Codex authentication from ~/.codex/auth.json...`));
    console.log(chalk.gray('Make sure you have run `codex login` first.\n'));

    try {
      const codexAuthPath = path.join(process.env.HOME || '', '.codex', 'auth.json');
      const authData = JSON.parse(require('fs').readFileSync(codexAuthPath, 'utf8'));

      // Extract expiry from JWT access_token
      let expiryDate = new Date(Date.now() + 30 * 24 * 3600 * 1000); // Default 30 days

      if (authData.tokens && authData.tokens.access_token) {
        try {
          // Decode JWT to get expiry (JWT format: header.payload.signature)
          const tokenParts = authData.tokens.access_token.split('.');
          if (tokenParts.length === 3) {
            const payload = JSON.parse(Buffer.from(tokenParts[1], 'base64').toString('utf8'));
            if (payload.exp) {
              // exp is Unix timestamp in seconds
              const tokenExpiry = new Date(payload.exp * 1000);
              expiryDate = tokenExpiry;
              console.log(chalk.gray(`✓ Token expiry from JWT: ${tokenExpiry.toISOString()}`));

              // Check if source tokens are already expired (do this AFTER try-catch)
              if (tokenExpiry < new Date()) {
                console.error(chalk.red('\n❌ Codex tokens in ~/.codex/auth.json are expired!'));
                console.error(chalk.red(`   Token expired: ${tokenExpiry.toISOString()}`));
                console.error(chalk.red(`   Current time:  ${new Date().toISOString()}`));
                console.error(chalk.yellow('\nPlease run: codex login'));
                throw new Error('Codex tokens expired - please re-authenticate');
              }
            }
          }
        } catch (jwtError: any) {
          // Re-throw if it's our intentional "tokens expired" error
          if (jwtError.message && jwtError.message.includes('expired')) {
            throw jwtError;
          }
          // Otherwise it's a JWT parsing error, use default expiry
          console.log(chalk.yellow(`⚠️  Could not parse JWT expiry: ${jwtError.message || jwtError}`));
          console.log(chalk.yellow(`⚠️  Using default 30-day expiry`));
        }
      }

      // Store the entire tokens object as a double-encoded JSON string
      // to prevent it from being parsed during storage/retrieval
      const tokensJson = JSON.stringify(authData.tokens);
      const doubleEncoded = JSON.stringify(tokensJson); // Wrap in another layer

      console.log(chalk.green(`✓ Codex tokens extracted from ~/.codex/auth.json`));
      console.log(chalk.gray(`[DEBUG] Tokens JSON (double-encoded): ${doubleEncoded.substring(0, 100)}...`));

      // Store the token
      const oauthToken: OAuthToken = {
        tool: 'codex',
        accessToken: doubleEncoded,  // Store double-encoded to preserve as string
        expiresAt: expiryDate,  // Use actual expiry from tokens
        encryptedAt: new Date()
      };

      await this.storeToken(oauthToken);

      console.log(chalk.green(`✅ Codex authenticated successfully from file`));
      return oauthToken;

    } catch (error) {
      console.error(chalk.red('\n❌ Failed to read Codex auth file'));
      console.error(chalk.red('Please run: codex login'));
      throw new Error(`Failed to read Codex auth from ~/.codex/auth.json: ${error}`);
    }
  }

  /**
   * Authenticate Gemini by reading from existing OAuth file
   * User must have authenticated via Gemini CLI to create ~/.gemini/oauth_creds.json
   */
  private async authenticateGeminiFromFile(): Promise<OAuthToken> {
    console.log(chalk.cyan(`\n📂 Reading Gemini authentication from ~/.gemini/oauth_creds.json...`));
    console.log(chalk.gray('Make sure you have authenticated with Gemini CLI first.\n'));

    try {
      const geminiAuthPath = path.join(process.env.HOME || '', '.gemini', 'oauth_creds.json');
      const authData = JSON.parse(require('fs').readFileSync(geminiAuthPath, 'utf8'));

      // Parse expiry date
      let expiryDate = new Date(Date.now() + 30 * 24 * 3600 * 1000); // Default 30 days

      if (authData.expiry_date) {
        const tokenExpiry = new Date(authData.expiry_date);

        // Check if source tokens are already expired
        if (tokenExpiry < new Date()) {
          console.log(chalk.red('\n❌ Gemini OAuth token has expired!'));
          console.log(chalk.yellow('   Token expired: ' + tokenExpiry.toISOString()));
          console.log(chalk.yellow('   Current time:  ' + new Date().toISOString()));
          console.log(chalk.cyan('\n   To refresh: Run `gemini` in your terminal to re-authenticate, then try again.\n'));
          throw new Error('Gemini token expired. Run `gemini` to refresh your OAuth credentials.');
        }

        expiryDate = tokenExpiry;
        console.log(chalk.gray(`✓ Using token expiry from source: ${tokenExpiry.toISOString()}`));
      }

      // Store the entire OAuth credentials object as a double-encoded JSON string
      const credsJson = JSON.stringify(authData);
      const doubleEncoded = JSON.stringify(credsJson); // Wrap in another layer

      console.log(chalk.green(`✓ Gemini OAuth credentials extracted from ~/.gemini/oauth_creds.json`));
      console.log(chalk.gray(`[DEBUG] OAuth creds (double-encoded): ${doubleEncoded.substring(0, 100)}...`));

      // Store the token
      const oauthToken: OAuthToken = {
        tool: 'gemini',
        accessToken: doubleEncoded,  // Store double-encoded to preserve as string
        expiresAt: expiryDate,
        encryptedAt: new Date()
      };

      await this.storeToken(oauthToken);

      console.log(chalk.green(`✅ Gemini authenticated successfully from file`));
      return oauthToken;

    } catch (error: any) {
      // Check if it's a file not found error
      if (error.code === 'ENOENT' || (error.message && error.message.includes('ENOENT'))) {
        console.error(chalk.red('\n❌ Gemini OAuth file not found'));
        console.error(chalk.yellow('Please authenticate with Gemini CLI first to create ~/.gemini/oauth_creds.json'));
        throw new Error('Gemini OAuth file not found - please authenticate with Gemini CLI first');
      }

      // For other errors (like JSON parse errors), show detailed message
      console.error(chalk.red('\n❌ Failed to read Gemini OAuth file'));
      console.error(chalk.red('Error: ' + (error.message || error)));
      throw new Error(`Failed to read Gemini OAuth from ~/.gemini/oauth_creds.json: ${error}`);
    }
  }

  /**
   * Authenticate with CLI tool using web browser flow
   */
  private async authenticateClaude(tool: string): Promise<OAuthToken> {
    console.log(chalk.cyan(`\n🌐 Starting ${tool} CLI web authentication...`));
    console.log(chalk.gray('This will open your browser for authentication.\n'));

    try {
      // Claude CLI authentication
      const authCommand = 'claude';
      const authArgs = ['setup-token'];
      const configEnv = {
        ...process.env,
        CLAUDE_CONFIG_DIR: path.join(process.env.HOME || '', '.claude')
      };

      console.log(chalk.yellow(`Running: ${authCommand} ${authArgs.join(' ')}`));
      console.log(chalk.gray('Please complete authentication in your browser...\n'));

      // Use spawn instead of execAsync to handle interactive browser auth
      const { spawn } = require('child_process');

      const setupProcess = spawn(authCommand, authArgs, {
        env: configEnv,
        stdio: ['inherit', 'pipe', 'pipe'] // inherit stdin for interactive, pipe stdout/stderr to capture
      });

      let stdout = '';
      let stderr = '';

      setupProcess.stdout.on('data', (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        // Show output to user in real-time
        process.stdout.write(text);
      });

      setupProcess.stderr.on('data', (data: Buffer) => {
        const text = data.toString();
        stderr += text;
        // Show errors to user in real-time
        process.stderr.write(text);
      });

      // Wait for process to complete
      await new Promise((resolve, reject) => {
        setupProcess.on('close', (code: number) => {
          if (code === 0) {
            resolve(code);
          } else {
            reject(new Error(`claude setup-token exited with code ${code}`));
          }
        });

        setupProcess.on('error', (error: Error) => {
          reject(error);
        });
      });

      console.log(chalk.green('\n✅ Browser authentication completed'));

      // Extract Claude OAuth token from stdout
      const combinedOutput = stdout + stderr;
      const tokenMatch = combinedOutput.match(/sk-ant-oat01-[a-zA-Z0-9_-]+/);

      if (!tokenMatch) {
        console.log(chalk.red('\n❌ Could not extract Claude OAuth token from output'));
        console.log(chalk.gray('Combined output (first 500 chars):'));
        console.log(chalk.gray(combinedOutput.substring(0, 500)));
        throw new Error('Could not extract OAuth token from claude setup-token output');
      }

      const token = tokenMatch[0];
      console.log(chalk.green(`✓ Token obtained for ${tool}`));

      // Store the real token
      const oauthToken: OAuthToken = {
        tool,
        accessToken: token,
        expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000), // 30 days
        encryptedAt: new Date()
      };

      await this.storeToken(oauthToken);

      console.log(chalk.green(`✅ ${tool} authenticated successfully with Claude CLI`));
      return oauthToken;

    } catch (error) {
      console.error(chalk.red('\n❌ Authentication failed:'), error);
      throw error;
    }
  }

  // Removed extractClaudeToken() - token now comes directly from claude setup-token output

  /**
   * Simulate OAuth flow (for testing)
   */
  private async simulateOAuthFlow(tool: string): Promise<void> {
    // In demo mode, just simulate the delay
    console.log(chalk.gray('Simulating browser OAuth flow...'));
    console.log(chalk.yellow('In production, this would:'));
    console.log(chalk.yellow(`  1. Open browser to ${tool} authorization page`));
    console.log(chalk.yellow(`  2. User grants permission`));
    console.log(chalk.yellow(`  3. Receive OAuth token`));

    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 500));

    console.log(chalk.gray('OAuth flow completed (simulated)'));
  }

  /**
   * Generate mock token for testing
   */
  private generateMockToken(seed: string): string {
    return crypto
      .createHash('sha256')
      .update(seed + Date.now())
      .digest('hex');
  }

  /**
   * Encrypt and store token
   */
  private async storeToken(token: OAuthToken): Promise<void> {
    // Load existing tokens
    let tokens: OAuthToken[] = [];
    try {
      tokens = await this.loadTokens();
    } catch {
      // No existing tokens
    }

    // Update or add token
    const index = tokens.findIndex(t => t.tool === token.tool);
    if (index >= 0) {
      tokens[index] = token;
    } else {
      tokens.push(token);
    }

    // Encrypt tokens
    const jsonStr = JSON.stringify(tokens);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(
      'aes-256-gcm',
      this.encryptionKey,
      iv
    );

    let encrypted = cipher.update(jsonStr, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    // Store encrypted data
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
   * Load and decrypt tokens
   */
  async loadTokens(): Promise<OAuthToken[]> {
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

    return JSON.parse(decrypted);
  }

  /**
   * Get token for specific tool
   * ALWAYS reads fresh tokens from source files for claude, codex, gemini
   */
  async getToken(tool: string): Promise<OAuthToken | null> {
    // For claude, codex, and gemini: ALWAYS read from source files
    // This ensures tokens are fresh after running `claude setup-token`, `codex login`, or gemini auth
    if (tool === 'claude' || tool === 'codex' || tool === 'gemini') {
      try {
        console.log(chalk.gray(`[getToken] Reading fresh ${tool} tokens from source file...`));
        return await this.authenticate(tool);
      } catch (error) {
        console.error(chalk.red(`[getToken] Failed to read ${tool} tokens from source:`), error);
        return null;
      }
    }

    // For other tools, use cached tokens
    try {
      const tokens = await this.loadTokens();
      return tokens.find(t => t.tool === tool) || null;
    } catch {
      return null;
    }
  }

  /**
   * Check if tool is authenticated
   */
  async isAuthenticated(tool: string): Promise<boolean> {
    const token = await this.getToken(tool);
    if (!token) return false;

    // Check if token is expired
    return new Date(token.expiresAt) > new Date();
  }

  /**
   * Get all authenticated tools
   * For claude/codex/gemini, checks source files directly (same as getToken)
   * This allows picking up fresh tokens after running native CLI without re-registering
   */
  async getAuthenticatedTools(): Promise<string[]> {
    const authenticatedTools: string[] = [];

    // For claude/codex/gemini, check source files directly (same as getToken)
    for (const tool of ['claude', 'codex', 'gemini']) {
      try {
        const token = await this.authenticate(tool);
        if (token && new Date(token.expiresAt) > new Date()) {
          authenticatedTools.push(tool);
        }
      } catch {
        // Tool not available from source, skip
      }
    }

    // For other tools, check encrypted cache
    try {
      const cachedTokens = await this.loadTokens();
      for (const token of cachedTokens) {
        if (!['claude', 'codex', 'gemini'].includes(token.tool)) {
          if (new Date(token.expiresAt) > new Date()) {
            authenticatedTools.push(token.tool);
          }
        }
      }
    } catch {
      // Cache not available, ignore
    }

    return authenticatedTools;
  }

  /**
   * Validate token and refresh if needed
   * For claude/codex/gemini, getToken() already reads from source, so just verify it exists
   * Returns true if token is valid, false if refresh needed
   */
  async validateAndRefreshToken(tool: string): Promise<boolean> {
    console.log(chalk.gray(`[DEBUG] Validating token for ${tool}...`));

    // For claude/codex/gemini, getToken() always reads fresh from source
    // So we just need to check if it succeeds
    if (tool === 'claude' || tool === 'codex' || tool === 'gemini') {
      try {
        const token = await this.getToken(tool);
        if (!token) {
          console.log(chalk.yellow(`⚠️  No token found for ${tool}`));
          console.log(chalk.yellow(`Please run: ${tool === 'claude' ? 'claude setup-token' : tool + ' login'}`));
          console.log(chalk.yellow(`Then: npm run hokipoki register -- --as-provider --tools ${tool}`));
          return false;
        }
        console.log(chalk.green(`✓ Token for ${tool} is valid and fresh from source`));
        return true;
      } catch (error: any) {
        console.error(chalk.red(`❌ Failed to read ${tool} tokens from source`));
        console.error(chalk.yellow(`Please run: ${tool === 'claude' ? 'claude setup-token' : tool + ' login'}`));
        console.error(chalk.yellow(`Then: npm run hokipoki register -- --as-provider --tools ${tool}`));
        return false;
      }
    }

    // For other tools, check cached token expiry
    const token = await this.getToken(tool);
    if (!token) {
      console.log(chalk.yellow(`⚠️  No token found for ${tool}, re-authentication needed`));
      return false;
    }

    const expiresIn = new Date(token.expiresAt).getTime() - Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;

    if (expiresIn < oneDayMs) {
      console.log(chalk.yellow(`⚠️  Token for ${tool} expires soon (in ${Math.floor(expiresIn / (60 * 60 * 1000))} hours), refreshing...`));
      try {
        await this.authenticate(tool);
        console.log(chalk.green(`✅ Token refreshed for ${tool}`));
        return true;
      } catch (error) {
        console.error(chalk.red(`❌ Failed to refresh token for ${tool}:`), error);
        return false;
      }
    }

    console.log(chalk.green(`✓ Token for ${tool} is valid`));
    return true;
  }

  /**
   * Revoke token for a tool
   */
  async revokeToken(tool: string): Promise<void> {
    const tokens = await this.loadTokens();
    const filtered = tokens.filter(t => t.tool !== tool);

    // Re-encrypt and store
    const jsonStr = JSON.stringify(filtered);
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

    await fs.writeFile(this.tokenStorePath, JSON.stringify(encryptedData));
  }
}