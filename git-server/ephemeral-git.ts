// Ephemeral Git Server
// Temporary Git server for secure code transfer

import { spawn, execSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import * as net from 'net';
import * as os from 'os';
import * as http from 'http';
import chalk from 'chalk';
import { FrpManager, FrpConfig } from '../src/services/frp-manager';
import { Logger } from '../src/utils/logger';

export interface EphemeralGitServerOptions {
  taskId: string;
  gitHost?: string;
  tunnelConfig: FrpConfig;
}

export class EphemeralGitServer {
  private httpServer?: http.Server;
  private tempRepoPath: string;
  private gitPort?: number;
  private oneTimeToken: string;
  private gitHost?: string;
  private frpManager: FrpManager;
  private tunnel?: { url: string; close: () => Promise<void> };
  private logger: Logger;
  private taskId: string;

  constructor(options: EphemeralGitServerOptions) {
    this.taskId = options.taskId;
    // Store temp files in user's home directory (standard CLI behavior)
    // This prevents contamination of user's project directories
    this.tempRepoPath = path.join(os.homedir(), '.hokipoki', 'tmp', `${this.taskId}.git`);
    this.oneTimeToken = crypto.randomBytes(32).toString('hex');
    this.gitHost = options.gitHost;

    // Initialize logger and FRP manager
    this.logger = new Logger('EphemeralGitServer');
    this.frpManager = new FrpManager(this.logger);

    // Configure FRP manager with tunnel settings
    this.frpManager.configure(options.tunnelConfig);
  }

  /**
   * Find a free port for Git server
   */
  private async findFreePort(): Promise<number> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.listen(0, () => {
        const port = (server.address() as net.AddressInfo).port;
        server.close(() => resolve(port));
      });
    });
  }

  /**
   * Get the local network IP address (for remote provider access)
   */
  private getLocalIPAddress(): string {
    const interfaces = os.networkInterfaces();

    // Look for non-internal IPv4 address
    for (const name of Object.keys(interfaces)) {
      const nets = interfaces[name];
      if (!nets) continue;

      for (const net of nets) {
        // Skip internal (loopback) and IPv6 addresses
        if (net.family === 'IPv4' && !net.internal) {
          return net.address;
        }
      }
    }

    // Fallback to localhost if no network interface found
    return 'localhost';
  }

  /**
   * Initialize ephemeral Git repository
   */
  async initialize(files: string[]): Promise<void> {
    console.log(chalk.cyan('🔒 Initializing ephemeral Git repository...'));

    // Create temp directory
    await fs.mkdir(this.tempRepoPath, { recursive: true });

    // Initialize bare repository
    execSync(`git init --bare ${this.tempRepoPath}`, { stdio: 'ignore' });

    // Enable HTTP push (receive-pack) for git-http-backend
    execSync(`git config --file ${this.tempRepoPath}/config http.receivepack true`, { stdio: 'ignore' });

    // Create working directory (clean it first if it exists)
    const workDir = path.join(path.dirname(this.tempRepoPath), 'work');
    await fs.rm(workDir, { recursive: true, force: true });
    await fs.mkdir(workDir, { recursive: true });

    // Initialize work directory as a git repo with 'main' as default branch
    // This ensures consistency regardless of user's git config (some use 'master', some 'main')
    execSync(`git init -b main ${workDir}`, { stdio: 'ignore' });
    execSync(`cd ${workDir} && git remote add origin ${this.tempRepoPath}`, { stdio: 'ignore' });

    // Configure git user for commits (required for git commit to work)
    execSync(`cd ${workDir} && git config user.name "HokiPoki Ephemeral"`, { stdio: 'ignore' });
    execSync(`cd ${workDir} && git config user.email "ephemeral@hokipoki.local"`, { stdio: 'ignore' });

    // Copy specified files
    console.log(chalk.gray(`Copying ${files.length} files to ephemeral repo...`));

    let successCount = 0;
    let failCount = 0;

    for (const file of files) {
      // Handle both absolute and relative paths
      // If absolute, use as-is. If relative, resolve from current working directory
      const sourcePath = path.isAbsolute(file) ? file : path.join(process.cwd(), file);

      // ALWAYS store in git repo using relative path from current working directory
      // This ensures patches have consistent relative paths
      let relativePath = path.relative(process.cwd(), sourcePath);

      // IMPORTANT: Remove any leading ../ to prevent files from escaping the work directory
      // This happens when files are outside the CWD (like ../hokipoki-frps/)
      while (relativePath.startsWith('../') || relativePath.startsWith('..\\')) {
        relativePath = relativePath.substring(3);
      }

      const destPath = path.join(workDir, relativePath);

      console.log(chalk.gray(`[Git Server] DEBUG: Copying file...`));
      console.log(chalk.gray(`  Input: ${file}`));
      console.log(chalk.gray(`  Source: ${sourcePath}`));
      console.log(chalk.gray(`  Relative: ${relativePath}`));
      console.log(chalk.gray(`  Dest: ${destPath}`));

      // Create directory if needed
      await fs.mkdir(path.dirname(destPath), { recursive: true });

      // Copy file
      try {
        await fs.copyFile(sourcePath, destPath);
        successCount++;
        console.log(chalk.gray(`  ✓ Copied successfully`));
      } catch (error: any) {
        failCount++;
        console.warn(chalk.yellow(`Warning: Could not copy ${file}`));
        console.warn(chalk.red(`  Error: ${error.message}`));
      }
    }

    console.log(chalk.gray(`[Git Server] File copy summary: ${successCount} succeeded, ${failCount} failed`));

    // Verify files were actually copied (critical for debugging empty repo issues)
    if (successCount === 0 && files.length > 0) {
      throw new Error(`Failed to copy any files. ${failCount} files failed to copy.`);
    }

    // If no files specified, create a sample code file for testing
    if (files.length === 0) {
      const sampleFile = path.join(workDir, 'sort.js');
      const bubbleSortCode = `// Bubble sort implementation
function sort(items) {
  let n = items.length;
  for (let i = 0; i < n-1; i++) {
    for (let j = 0; j < n-i-1; j++) {
      if (items[j] > items[j+1]) {
        let temp = items[j];
        items[j] = items[j+1];
        items[j+1] = temp;
      }
    }
  }
  return items;
}

module.exports = { sort };
`;
      await fs.writeFile(sampleFile, bubbleSortCode);
    }

    // Debug: Check what files are in work directory
    console.log(chalk.gray(`[Git Server] DEBUG: Checking work directory contents...`));
    const lsResult = execSync(`ls -la ${workDir}`, { encoding: 'utf8' });
    console.log(chalk.gray(`[Git Server] Work dir contents:\n${lsResult}`));

    // Commit and push files
    console.log(chalk.gray(`[Git Server] DEBUG: Running git add -A...`));
    execSync(`cd ${workDir} && git add -A`, { stdio: 'ignore' });

    // Check what was staged
    console.log(chalk.gray(`[Git Server] DEBUG: Checking git status...`));
    const statusResult = execSync(`cd ${workDir} && git status`, { encoding: 'utf8' });
    console.log(chalk.gray(`[Git Server] Git status:\n${statusResult}`));

    // Commit and push files - with proper error handling
    try {
      console.log(chalk.gray(`[Git Server] DEBUG: Attempting git commit...`));
      const commitResult = execSync(`cd ${workDir} && git commit -m "Initial task files"`, { encoding: 'utf8', stdio: 'pipe' });
      console.log(chalk.gray(`[Git Server] Commit output:\n${commitResult}`));

      console.log(chalk.gray(`[Git Server] DEBUG: Pushing to origin main...`));
      // FIXED: Capture push output instead of ignoring it
      const pushResult = execSync(`cd ${workDir} && git push origin main 2>&1`, { encoding: 'utf8' });
      console.log(chalk.gray(`[Git Server] Push output: ${pushResult}`));
      console.log(chalk.green(`[Git Server] Successfully committed and pushed files`));

      // Verify the bare repo actually has commits
      const headRef = execSync(`git --git-dir=${this.tempRepoPath} rev-parse HEAD`, { encoding: 'utf8' }).trim();
      console.log(chalk.green(`[Git Server] Repository HEAD: ${headRef}`));

    } catch (error: any) {
      // Log detailed error info for debugging
      console.error(chalk.red(`[Git Server] Git operation failed: ${error.message}`));
      if (error.stderr) {
        console.error(chalk.red(`[Git Server] stderr: ${error.stderr.toString()}`));
      }
      if (error.stdout) {
        console.error(chalk.red(`[Git Server] stdout: ${error.stdout.toString()}`));
      }

      // DON'T silently continue - throw to prevent empty repo being served
      throw new Error(`Failed to initialize git repository: ${error.message}`);
    }

    // Clean up work directory
    await fs.rm(workDir, { recursive: true, force: true });

    console.log(chalk.green('✅ Ephemeral repository created'));
  }

  /**
   * Start Git server with authentication
   */
  async start(): Promise<void> {
    console.log(chalk.cyan('🚀 Starting ephemeral Git server...'));

    // Find free port
    this.gitPort = await this.findFreePort();

    // Start HTTP server with token validation
    await this.startHttpServer();

    // Create FRP tunnel for the Git server (mandatory - always use tunnel)
    console.log(chalk.cyan('🌐 Creating FRP tunnel for Git server...'));
    try {
      this.tunnel = await this.frpManager.createTunnel({
        port: this.gitPort
      });

      // Construct the Git URL using the tunnel
      const tunnelUrl = this.tunnel.url.replace(/\/$/, ''); // Remove trailing slash if any
      const gitUrl = `${tunnelUrl}/${this.taskId}.git`;

      console.log(chalk.green(`✅ Git server accessible via FRP tunnel: ${gitUrl}`));
      console.log(chalk.gray(`   Local server: http://localhost:${this.gitPort}/${this.taskId}.git`));
    } catch (error: any) {
      console.error(chalk.red(`❌ Failed to create FRP tunnel: ${error.message}`));
      throw error;
    }
  }

  /**
   * Start HTTP server with git-http-backend and token validation
   */
  private async startHttpServer(): Promise<void> {
    const basePath = path.join(os.homedir(), '.hokipoki', 'tmp');

    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer((req, res) => {
        // Token validation - check Authorization header or query parameter
        const authHeader = req.headers.authorization;
        let token: string | null = null;

        console.log(chalk.gray(`[Git Server] DEBUG: Request headers:`, JSON.stringify(req.headers, null, 2)));

        if (authHeader) {
          if (authHeader.startsWith('Bearer ')) {
            // Bearer token format
            token = authHeader.substring(7);
            console.log(chalk.gray(`[Git Server] DEBUG: Found Bearer token`));
          } else if (authHeader.startsWith('Basic ')) {
            // HTTP Basic Auth format: "Basic base64(username:password)"
            // Git sends credentials as base64(token:x-oauth-basic)
            const base64Credentials = authHeader.substring(6);
            console.log(chalk.gray(`[Git Server] DEBUG: Found Basic auth, base64: ${base64Credentials.substring(0, 20)}...`));
            const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
            console.log(chalk.gray(`[Git Server] DEBUG: Decoded credentials: ${credentials.substring(0, 20)}...`));
            const [username] = credentials.split(':');
            token = username; // The username is the token
            console.log(chalk.gray(`[Git Server] DEBUG: Extracted token from Basic auth: ${token?.substring(0, 8)}...`));
          }
        } else {
          console.log(chalk.yellow(`[Git Server] DEBUG: No Authorization header found`));
        }

        // Fallback to query parameter
        if (!token) {
          token = new URL(req.url || '', `http://${req.headers.host}`).searchParams.get('token');
          if (token) {
            console.log(chalk.gray(`[Git Server] DEBUG: Found token in query param`));
          }
        }

        if (token !== this.oneTimeToken) {
          console.log(chalk.red(`[Git Server] Unauthorized access attempt - invalid token`));
          console.log(chalk.gray(`[Git Server] Expected token: ${this.oneTimeToken.substring(0, 8)}...`));
          console.log(chalk.gray(`[Git Server] Received token: ${token?.substring(0, 8) || 'none'}...`));
          res.writeHead(401, {
            'Content-Type': 'text/plain',
            'WWW-Authenticate': 'Basic realm="Git"'
          });
          res.end('Unauthorized: Invalid token');
          return;
        }

        console.log(chalk.gray(`[Git Server] Authenticated request: ${req.method} ${req.url}`));

        // Parse URL to separate path from query string
        const parsedUrl = new URL(req.url || '', `http://${req.headers.host}`);
        const pathInfo = parsedUrl.pathname; // Just the path, no query string
        const queryString = parsedUrl.search.slice(1); // Remove leading '?'

        // Spawn git-http-backend to handle the request
        const backend = spawn('git', ['http-backend'], {
          env: {
            ...process.env,
            GIT_PROJECT_ROOT: basePath,
            GIT_HTTP_EXPORT_ALL: '1',
            PATH_INFO: pathInfo,
            REQUEST_METHOD: req.method || 'GET',
            CONTENT_TYPE: req.headers['content-type'] || '',
            QUERY_STRING: queryString,
            CONTENT_LENGTH: req.headers['content-length'] || '0',
          },
          stdio: ['pipe', 'pipe', 'pipe']
        });

        // Handle backend errors
        backend.on('error', (error: Error) => {
          console.error(chalk.red('[Git Server] Backend error:'), error);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal Server Error');
          }
        });

        // Pipe request body to backend
        req.pipe(backend.stdin);

        // Parse backend response and send to client
        let headersParsed = false;
        let statusCode = 200;
        const headers: Record<string, string> = {};

        backend.stdout.on('data', (data: Buffer) => {
          if (!headersParsed) {
            const output = data.toString();
            const parts = output.split('\r\n\r\n');

            if (parts.length > 1) {
              // Parse headers
              const headerLines = parts[0].split('\r\n');
              for (const line of headerLines) {
                if (line.startsWith('Status:')) {
                  statusCode = parseInt(line.split(' ')[1]);
                } else {
                  const colonIndex = line.indexOf(':');
                  if (colonIndex > 0) {
                    const key = line.substring(0, colonIndex).trim();
                    const value = line.substring(colonIndex + 1).trim();
                    headers[key] = value;
                  }
                }
              }

              res.writeHead(statusCode, headers);
              headersParsed = true;

              // Write remaining data (body)
              const body = parts.slice(1).join('\r\n\r\n');
              if (body) {
                res.write(body);
              }
            }
          } else {
            // Already parsed headers, just write body
            res.write(data);
          }
        });

        backend.stderr.on('data', (data: Buffer) => {
          console.error(chalk.yellow('[Git Server] Backend stderr:'), data.toString().trim());
        });

        backend.on('close', (code: number) => {
          if (code !== 0) {
            console.error(chalk.red(`[Git Server] Backend exited with code ${code}`));
          }
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Backend process failed');
          } else {
            res.end();
          }
        });
      });

      this.httpServer.on('error', (error: Error) => {
        console.error(chalk.red('[Git Server] HTTP server error:'), error);
        reject(error);
      });

      this.httpServer.listen(this.gitPort, '0.0.0.0', () => {
        console.log(chalk.gray(`[Git Server] HTTP server listening on port ${this.gitPort}`));
        resolve();
      });
    });
  }

  /**
   * Stop the Git server
   */
  async stop(): Promise<void> {
    console.log(chalk.cyan('🛑 Stopping ephemeral Git server...'));

    // Close tunnel first
    if (this.tunnel) {
      try {
        await this.tunnel.close();
        console.log(chalk.gray('[Git Server] Tunnel closed'));
      } catch (error: any) {
        console.error(chalk.yellow(`[Git Server] Warning: Error closing tunnel: ${error.message}`));
      }
      this.tunnel = undefined;
    }

    if (this.httpServer) {
      // Close HTTP server
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => {
          console.log(chalk.gray('[Git Server] HTTP server closed'));
          resolve();
        });
      });

      this.httpServer = undefined;
    }

    // Clean up repository
    await this.cleanup();

    console.log(chalk.green('✅ Git server stopped and cleaned'));
  }

  /**
   * Complete cleanup - wipe all traces
   */
  private async cleanup(): Promise<void> {
    console.log(chalk.gray('🧹 Wiping ephemeral data...'));

    try {
      // Clean up repo
      if (await this.fileExists(this.tempRepoPath)) {
        const repoFiles = await this.getAllFiles(this.tempRepoPath);
        for (const file of repoFiles) {
          try {
            const stat = await fs.stat(file);
            if (stat.isFile()) {
              const randomData = crypto.randomBytes(Math.min(stat.size, 1024 * 1024)); // Max 1MB
              await fs.writeFile(file, randomData);
            }
          } catch {}
        }
        await fs.rm(this.tempRepoPath, { recursive: true, force: true });
      }
    } catch (error) {
      console.warn(chalk.yellow('Warning: Some files could not be wiped'));
    }

    console.log(chalk.green('✨ All traces removed'));
  }

  /**
   * Check if file/directory exists
   */
  private async fileExists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get all files recursively
   */
  private async getAllFiles(dir: string): Promise<string[]> {
    let results: string[] = [];

    try {
      const items = await fs.readdir(dir);

      for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = await fs.stat(fullPath);

        if (stat.isDirectory()) {
          results = results.concat(await this.getAllFiles(fullPath));
        } else {
          results.push(fullPath);
        }
      }
    } catch {
      // Directory might not exist
    }

    return results;
  }

  /**
   * Get changes after execution
   */
  async getChanges(): Promise<string> {
    const workDir = path.join(path.dirname(this.tempRepoPath), 'work-review');

    try {
      // Check if repository still exists
      if (!await this.fileExists(this.tempRepoPath)) {
        console.error(chalk.red('[Git Server] ERROR: Repository path does not exist:'), this.tempRepoPath);
        console.error(chalk.red('[Git Server] Repository may have been cleaned up too early'));
        return '';
      }

      console.log(chalk.gray(`[Git Server] Cloning from: ${this.tempRepoPath}`));

      // Remove work-review directory if it exists from previous run
      if (await this.fileExists(workDir)) {
        await fs.rm(workDir, { recursive: true, force: true });
      }

      // Clone to review changes - use the bare repository directly
      execSync(`git clone ${this.tempRepoPath} ${workDir}`, { stdio: 'pipe' });

      // Fetch the latest changes from the bare repository
      execSync(`cd ${workDir} && git fetch origin`, { stdio: 'ignore' });

      // Get the log to see all commits
      const log = execSync(`cd ${workDir} && git log --oneline`, {
        encoding: 'utf8'
      });
      console.log(chalk.gray('[Git Server] Commits in repository:'));
      console.log(chalk.gray(log));

      // Get the diff - comparing initial commit to latest
      let diff: string;
      try {
        // Count number of commits
        const commitCount = execSync(`cd ${workDir} && git rev-list --count HEAD`, {
          encoding: 'utf8'
        }).trim();

        if (parseInt(commitCount) > 1) {
          // Get diff between first and last commit
          const firstCommit = execSync(`cd ${workDir} && git rev-list --max-parents=0 HEAD`, {
            encoding: 'utf8'
          }).trim();

          diff = execSync(`cd ${workDir} && git diff ${firstCommit} HEAD`, {
            encoding: 'utf8'
          });

          console.log(chalk.green(`[Git Server] Found changes between initial and latest commit`));
        } else {
          // Only one commit, show its contents
          diff = execSync(`cd ${workDir} && git show --format="" HEAD`, {
            encoding: 'utf8'
          });
          console.log(chalk.yellow('[Git Server] Only one commit found, showing its contents'));
        }
      } catch (error) {
        console.error(chalk.red('[Git Server] Error getting diff:'), error);
        // Fallback: show the last commit
        diff = execSync(`cd ${workDir} && git show --format="" HEAD`, {
          encoding: 'utf8'
        });
      }


      // Clean up
      await fs.rm(workDir, { recursive: true, force: true });

      return diff;

    } catch (error) {
      console.error(chalk.red('Error getting changes:'), error);
      return '';
    }
  }

  /**
   * Get configuration for requester
   */
  async getConfig(): Promise<{ url: string; token: string }> {
    // Always use tunnel URL (mandatory)
    if (!this.tunnel) {
      throw new Error('Tunnel not initialized. Call start() first.');
    }

    const tunnelUrl = this.tunnel.url.replace(/\/$/, ''); // Remove trailing slash if any
    const gitUrl = `${tunnelUrl}/${this.taskId}.git`;

    return {
      url: gitUrl,
      token: this.oneTimeToken
    };
  }
}