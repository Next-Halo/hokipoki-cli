import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { Logger } from '../utils/logger';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface TunnelOptions {
  port: number;
  subdomain?: string;
}

interface Tunnel {
  url: string;
  close: () => Promise<void>;
}

export class FrpManager {
  private logger: Logger;
  private processes: Map<number, ChildProcess> = new Map();
  private configFiles: Map<number, string> = new Map();
  private frpcPath?: string;

  // FRP server configuration (production defaults)
  private serverAddr = process.env.FRP_SERVER_ADDR || 'tunnel.hoki-poki.ai';
  private serverPort = parseInt(process.env.FRP_SERVER_PORT || '7001');
  private authToken = process.env.FRP_AUTH_TOKEN || '3de0f9857f79f2dca06751da275339a62d8853fe897550ff4c05d193b7378573';
  private httpPort = parseInt(process.env.FRP_HTTP_PORT || '3999');
  private tunnelDomain = process.env.FRP_TUNNEL_DOMAIN || 'tunnel.hoki-poki.ai'; // Domain for tunnel URLs

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Ensure frpc binary is available
   */
  private async ensureFrpcBinary(): Promise<string> {
    if (this.frpcPath) {
      return this.frpcPath;
    }

    // Check if frpc is in PATH
    try {
      const { stdout } = await execAsync('which frpc');
      this.frpcPath = stdout.trim();
      this.logger.debug(`Found frpc at: ${this.frpcPath}`);
      return this.frpcPath;
    } catch {
      // Not in PATH, need to download
      return await this.downloadFrpc();
    }
  }

  /**
   * Download frpc binary if not available
   */
  private async downloadFrpc(): Promise<string> {
    this.logger.info('Downloading frpc binary...');

    const platform = os.platform();
    const arch = os.arch();

    // Use FRP version matching the server (v0.64.0)
    const frpVersion = 'v0.64.0';

    // Determine download URL based on platform
    let archiveName = '';
    let binaryName = 'frpc';

    if (platform === 'darwin') {
      if (arch === 'arm64') {
        archiveName = 'frp_0.64.0_darwin_arm64.tar.gz';
      } else {
        archiveName = 'frp_0.64.0_darwin_amd64.tar.gz';
      }
    } else if (platform === 'linux') {
      if (arch === 'arm64') {
        archiveName = 'frp_0.64.0_linux_arm64.tar.gz';
      } else {
        archiveName = 'frp_0.64.0_linux_amd64.tar.gz';
      }
    } else {
      throw new Error(`Unsupported platform: ${platform}`);
    }

    const downloadUrl = `https://github.com/fatedier/frp/releases/download/${frpVersion}/${archiveName}`;

    // Download and extract to temp directory
    const binDir = path.join(os.homedir(), '.hokipoki', 'bin');
    await fs.mkdir(binDir, { recursive: true });

    const tarPath = path.join(binDir, 'frp.tar.gz');
    this.logger.debug(`Downloading frpc from: ${downloadUrl}`);

    await execAsync(`curl -L -o "${tarPath}" "${downloadUrl}"`);
    await execAsync(`tar -xzf "${tarPath}" -C "${binDir}" --strip-components=1 "*/frpc"`);
    await execAsync(`chmod +x "${binDir}/frpc"`);
    await fs.unlink(tarPath);

    this.frpcPath = path.join(binDir, binaryName);
    this.logger.info(`frpc binary installed at: ${this.frpcPath}`);

    return this.frpcPath;
  }

  /**
   * Generate a random subdomain
   */
  private generateSubdomain(): string {
    const adjectives = ['happy', 'clever', 'swift', 'bright', 'cool', 'warm', 'bold', 'calm', 'wise', 'kind'];
    const animals = ['fox', 'bear', 'eagle', 'wolf', 'lion', 'tiger', 'panda', 'koala', 'owl', 'hawk'];

    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const animal = animals[Math.floor(Math.random() * animals.length)];
    const num = Math.floor(Math.random() * 100);

    return `${adj}-${animal}-${num}`;
  }

  /**
   * Create a tunnel for the given port
   */
  async createTunnel(options: TunnelOptions): Promise<Tunnel> {
    const { port, subdomain } = options;
    const tunnelName = subdomain || this.generateSubdomain();

    try {
      this.logger.debug(`Creating FRP tunnel for port ${port}`);

      // Ensure frpc binary is available
      const frpcPath = await this.ensureFrpcBinary();

      // Create temporary config file
      const configPath = await this.createFrpcConfig(port, tunnelName);
      this.configFiles.set(port, configPath);

      // Start frpc process
      const process = spawn(frpcPath, ['-c', configPath], {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      // Handle process output
      process.stdout?.on('data', (data: Buffer) => {
        this.logger.debug(`[frpc] ${data.toString().trim()}`);
      });

      process.stderr?.on('data', (data: Buffer) => {
        this.logger.debug(`[frpc] ${data.toString().trim()}`);
      });

      process.on('error', (error: Error) => {
        this.logger.error(`frpc process error: ${error.message}`);
      });

      process.on('exit', (code: number | null) => {
        if (code !== 0) {
          this.logger.warn(`frpc process exited with code: ${code}`);
        }
      });

      // Store process for cleanup
      this.processes.set(port, process);

      // Wait a moment for connection to establish
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Construct tunnel URL using tunnel domain (not server address)
      const tunnelUrl = `http://${tunnelName}.${this.tunnelDomain}:${this.httpPort}`;

      this.logger.info(`FRP tunnel created: ${tunnelUrl}`);

      return {
        url: tunnelUrl,
        close: async () => {
          await this.closeTunnel(port);
        }
      };
    } catch (error: any) {
      this.logger.error(`Failed to create FRP tunnel: ${error.message}`);
      throw new Error(`Failed to create FRP tunnel for port ${port}: ${error.message}`);
    }
  }

  /**
   * Create frpc configuration file
   */
  private async createFrpcConfig(port: number, subdomain: string): Promise<string> {
    // For FRP v0.64.0+ using subdomain with subdomainHost on server
    const config = `serverAddr = "${this.serverAddr}"
serverPort = ${this.serverPort}
auth.method = "token"
auth.token = "${this.authToken}"

[[proxies]]
name = "${subdomain}"
type = "http"
localIP = "127.0.0.1"
localPort = ${port}
subdomain = "${subdomain}"
`;

    const configDir = path.join(os.tmpdir(), 'hokipoki-frp');
    await fs.mkdir(configDir, { recursive: true });

    const configPath = path.join(configDir, `frpc-${port}-${Date.now()}.toml`);
    await fs.writeFile(configPath, config);

    this.logger.debug(`Created frpc config at: ${configPath}`);

    return configPath;
  }

  /**
   * Close a specific tunnel
   */
  async closeTunnel(port: number): Promise<void> {
    const process = this.processes.get(port);
    if (process) {
      try {
        process.kill();
        this.processes.delete(port);
        this.logger.debug(`Closed FRP tunnel for port ${port}`);
      } catch (error: any) {
        this.logger.error(`Error closing FRP tunnel for port ${port}: ${error.message}`);
      }
    }

    // Clean up config file
    const configPath = this.configFiles.get(port);
    if (configPath) {
      try {
        await fs.unlink(configPath);
        this.configFiles.delete(port);
      } catch (error: any) {
        // Config file might already be deleted
      }
    }
  }

  /**
   * Close all active tunnels
   */
  async closeAll(): Promise<void> {
    for (const [port] of this.processes.entries()) {
      await this.closeTunnel(port);
    }
  }
}