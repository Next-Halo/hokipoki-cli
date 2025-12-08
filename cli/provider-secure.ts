// Secure Provider CLI with Docker Container Orchestration
// Provider spawns container on LOCAL machine
// Provider CANNOT access container - it's fully encrypted and locked

import chalk from 'chalk';
import ora from 'ora';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { OAuthManager } from '../auth/oauth-manager';
import { KeycloakManager } from '../auth/keycloak-manager';

// Get the CLI package root directory (works regardless of where hokipoki is run from)
// __dirname is available in CommonJS and points to the directory containing this file
const CLI_ROOT = path.resolve(__dirname, '..');

const execAsync = promisify(exec);

// Supported tools whitelist - these are the only tools that can be registered
const SUPPORTED_TOOLS = ['claude', 'codex', 'gemini'];

export class SecureProviderCLI {
  private oauthManager: OAuthManager;
  private keycloakManager: KeycloakManager;
  private containerName?: string;
  private backendUrl: string;

  constructor() {
    this.oauthManager = new OAuthManager();
    this.keycloakManager = new KeycloakManager();
    this.backendUrl = process.env.BACKEND_URL || 'https://api.hoki-poki.ai/api';
  }

  /**
   * Register provider with OAuth authentication
   */
  async register(tools: string[]): Promise<void> {
    console.log(chalk.bold.cyan('\n🔐 Provider Registration\n'));

    // Parse tool names to extract base tool (strip model specifications)
    const baseTools: string[] = [];
    for (const toolSpec of tools) {
      // Check if user accidentally included model specification
      if (toolSpec.includes(':')) {
        const [tool, _model] = toolSpec.split(':', 2);
        console.log(chalk.yellow(`⚠️  Note: Model specification detected in '${toolSpec}'`));
        console.log(chalk.gray(`   Registering base tool '${tool}' (models are specified at request time)`));
        if (!baseTools.includes(tool.toLowerCase())) {
          baseTools.push(tool.toLowerCase());
        }
      } else {
        if (!baseTools.includes(toolSpec.toLowerCase())) {
          baseTools.push(toolSpec.toLowerCase());
        }
      }
    }

    // Validate all tools are supported
    const invalidTools = baseTools.filter(t => !SUPPORTED_TOOLS.includes(t));
    if (invalidTools.length > 0) {
      console.log(chalk.red(`\n❌ Unsupported tool(s): ${invalidTools.join(', ')}`));
      console.log(chalk.yellow(`Supported tools: ${SUPPORTED_TOOLS.join(', ')}`));
      process.exit(1);
    }

    const successfulTools: string[] = [];
    const failedTools: string[] = [];

    for (const tool of baseTools) {
      // ALWAYS read fresh tokens from source files (e.g., ~/.codex/auth.json)
      // This ensures we use the latest tokens from the AI CLI's native storage
      console.log(chalk.cyan(`\n🔄 Refreshing ${tool} authentication from source...`));
      try {
        await this.oauthManager.authenticate(tool);
        console.log(chalk.green(`✅ ${tool} tokens updated from source file`));
        successfulTools.push(tool);
      } catch (error: any) {
        console.log(chalk.yellow(`⚠️  ${tool} authentication skipped: ${error.message || error}`));
        failedTools.push(tool);
      }
    }

    // Register tools to backend database (only successful ones)
    if (successfulTools.length > 0) {
      try {
        console.log(chalk.cyan('\n📤 Saving tools to database...'));
        const token = await this.keycloakManager.getToken();

        const response = await fetch(`${this.backendUrl}/provider/tools`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ tools: successfulTools })
        });

        if (!response.ok) {
          const error = await response.json() as { error?: string };
          throw new Error(error.error || 'Failed to save tools to database');
        }

        console.log(chalk.green('✅ Tools saved to database'));
      } catch (error: any) {
        console.log(chalk.yellow(`⚠️  Warning: Could not save tools to database: ${error.message}`));
        console.log(chalk.gray('   Tools are saved locally. You may need to register again if database sync fails.'));
      }
    }

    // Show summary
    console.log(chalk.green('\n✨ Provider registration complete!'));

    if (successfulTools.length > 0) {
      console.log(chalk.green('\n✓ Successfully registered tools:'));
      successfulTools.forEach(tool => console.log(chalk.gray(`  • ${tool}`)));
    }

    if (failedTools.length > 0) {
      console.log(chalk.yellow('\n⚠️  Failed tools (tokens need refresh):'));
      failedTools.forEach(tool => console.log(chalk.gray(`  • ${tool}`)));
      console.log(chalk.yellow('\nYou can still listen for tasks, but expired tools will be validated before task execution.'));
    }

    console.log(chalk.gray('\nYour credentials are encrypted and stored locally.'));
    console.log(chalk.gray('They will ONLY be injected into secure containers.'));
    console.log(chalk.dim('\n💡 Tip: You can now accept tasks for any model of these tools'));
    console.log(chalk.dim('   Use tool:model syntax (e.g., claude:sonnet-4, gemini:gemini-2.5-flash)'));
    console.log(chalk.dim('   Run "claude /model" or "gemini --list-models" to see available models\n'));
  }

  /**
   * Execute task in secure container ON PROVIDER'S MACHINE
   * Provider receives git credentials from requester
   */
  async executeTaskInContainer(task: {
    id: string;
    tool: string;
    model?: string;
    description: string;
    gitUrl: string;
    gitToken: string;
  }): Promise<void> {
    // Extract base tool name (strip model specification if present)
    // This handles both old format (task.tool = "codex:gpt-5") and new format (task.tool = "codex", task.model = "gpt-5")
    const baseTool = task.tool.includes(':') ? task.tool.split(':', 2)[0] : task.tool;

    console.log(chalk.cyan('[DEBUG] executeTaskInContainer called with:'));
    console.log(chalk.gray('  Task ID:'), task.id);
    console.log(chalk.gray('  Tool:'), task.tool);
    console.log(chalk.gray('  Git URL:'), task.gitUrl);
    console.log(chalk.gray('  Description:'), task.description);

    const spinner = ora('Preparing secure execution environment...').start();

    // Log task as in_progress
    await this.logTask({
      id: task.id,
      tool: baseTool,
      model: task.model,
      description: task.description,
      status: 'in_progress'
    });

    try {

      // Get OAuth token for the base tool
      console.log(chalk.gray('[DEBUG] Base tool:'), baseTool);
      console.log(chalk.gray('[DEBUG] Requested model:'), task.model || 'default');

      // Validate and refresh token if needed (prevents 401 errors from expired tokens)
      console.log(chalk.gray('[DEBUG] Validating OAuth token for:', baseTool));
      const isValid = await this.oauthManager.validateAndRefreshToken(baseTool);
      if (!isValid) {
        throw new Error(`Failed to validate/refresh token for ${baseTool}. Please run: npm run hokipoki register -- --as-provider --tools ${baseTool}`);
      }

      console.log(chalk.gray('[DEBUG] Fetching OAuth token for:', baseTool));
      const token = await this.oauthManager.getToken(baseTool);

      if (!token) {
        const availableTools = await this.oauthManager.getAuthenticatedTools();
        console.error(chalk.red('[ERROR] No OAuth token found!'));
        console.error(chalk.red('Available tools:'), availableTools);
        throw new Error(`No authentication found for ${baseTool}. Please run: npm run hokipoki register -- --as-provider --tools ${baseTool}`);
      }

      console.log(chalk.green('[DEBUG] OAuth token retrieved successfully'));

      spinner.text = 'Building secure container if needed...';
      await this.buildSecureContainer();
      console.log(chalk.green('[DEBUG] Docker image ready'));

      spinner.text = 'Starting encrypted container...';

      // Generate container name
      this.containerName = `hokipoki-${task.id}-${Date.now()}`;
      console.log(chalk.gray('[DEBUG] Container name:'), this.containerName);

      // Build Docker run command with security flags
      const dockerArgs = this.buildDockerCommand(task, token.accessToken);
      console.log(chalk.gray('[DEBUG] Docker args count:'), dockerArgs.length);

      console.log(chalk.bold.yellow('\n⚠️  [SECURITY NOTICE] ⚠️'));
      console.log(chalk.yellow('━'.repeat(60)));
      console.log(chalk.white('Container is running on YOUR machine with locked-down security:'));
      console.log(chalk.gray('  • No shell access - docker exec will fail'));
      console.log(chalk.gray('  • No inspection tools (ls, cat, grep removed)'));
      console.log(chalk.gray('  • Read-only filesystem except tmpfs workspace'));
      console.log(chalk.gray('  • Workspace encrypted in memory (tmpfs)'));
      console.log(chalk.gray('  • Auto-wiped on completion\n'));
      console.log(chalk.white('Code is cloned from requester\'s encrypted git server'));
      console.log(chalk.bold.red('⚠️  Attempting to access container violates terms of service'));
      console.log(chalk.red('⚠️  Violations are logged and result in permanent ban'));
      console.log(chalk.yellow('━'.repeat(60) + '\n'));

      console.log(chalk.cyan('[DEBUG] Spawning Docker container...'));

      // Execute container using spawn to avoid shell escaping issues
      const { spawn } = require('child_process');
      const containerProcess = spawn('docker', dockerArgs);
      console.log(chalk.green('[DEBUG] Container process spawned'));

      // Track 401 authentication errors and commit message
      let has401Error = false;
      let commitMessage: string | undefined;

      // Show all output for debugging
      containerProcess.stdout?.on('data', (data: Buffer) => {
        const line = data.toString().trim();
        console.log(chalk.dim('Container stdout:', line));

        // Check for 401 Unauthorized errors
        if (line.includes('401 Unauthorized') || line.includes('401 unauthorized')) {
          has401Error = true;
        }

        // Extract commit message from special marker
        const commitMatch = line.match(/\[HOKIPOKI_COMMIT_MESSAGE\](.*?)\[\/HOKIPOKI_COMMIT_MESSAGE\]/);
        if (commitMatch && commitMatch[1]) {
          commitMessage = commitMatch[1];
          console.log(chalk.green('[Provider] Captured commit message:', commitMessage));
        }
      });

      containerProcess.stderr?.on('data', (data: Buffer) => {
        // Show stderr - git push goes to stderr so check for success patterns
        const error = data.toString();

        // Check for 401 Unauthorized errors
        if (error.includes('401 Unauthorized') || error.includes('401 unauthorized')) {
          has401Error = true;
        }

        // Git push success messages go to stderr, show them in green
        if (error.includes('->') || error.includes('To git://')) {
          console.log(chalk.green('Container stderr:', error));
        } else {
          console.error(chalk.red('Container stderr:', error));
        }
      });

      // Start playful animation while waiting
      spinner.stop();
      const animationInterval = this.startHokiPokiAnimation();

      // Wait for completion
      await new Promise<void>((resolve, reject) => {
        containerProcess.on('exit', (code: number | null) => {
          clearInterval(animationInterval);
          // Clear animation line and move to new line
          process.stdout.write('\r\x1b[K');
          if (code === 0) {
            console.log(chalk.green('✅ Task executed successfully'));
            resolve();
          } else {
            console.log(chalk.red('✖ Container execution failed'));
            reject(new Error(`Container exited with code ${code}`));
          }
        });

        containerProcess.on('error', (error: Error) => {
          clearInterval(animationInterval);
          // Clear animation line and move to new line
          process.stdout.write('\r\x1b[K');
          reject(error);
        });
      });

      // Display 401 error guidance if detected
      if (has401Error) {
        console.log(chalk.bold.red('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
        console.log(chalk.bold.red('❌ AUTHENTICATION ERROR DETECTED'));
        console.log(chalk.bold.red('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
        console.log(chalk.yellow(`\nYour ${baseTool} tokens are expired or invalid!`));
        console.log(chalk.white('\nTo fix this:'));
        console.log(chalk.cyan(`  1. Run: ${baseTool === 'claude' ? 'claude setup-token' : baseTool + ' login'}`));
        console.log(chalk.cyan(`  2. Then restart provider: npm run hokipoki -- listen --tools ${baseTool}`));
        console.log(chalk.gray('\nNote: With the latest update, tokens are now read fresh from source files.'));
        console.log(chalk.gray('      Just restart the provider after re-authenticating.\n'));
      }

      console.log(chalk.green('\n✅ Execution complete'));
      console.log(chalk.gray('Container auto-destroyed - no traces remain on your machine'));

      // Log task as completed with summary
      await this.logTask({
        id: task.id,
        tool: baseTool,
        model: task.model,
        description: task.description,
        status: 'completed',
        completedAt: new Date(),
        summary: commitMessage
      });

    } catch (error) {
      spinner.fail('Execution failed');

      // Log task as failed
      await this.logTask({
        id: task.id,
        tool: baseTool,
        model: task.model,
        description: task.description,
        status: 'failed',
        completedAt: new Date()
      });

      throw error;
    } finally {
      // Ensure container is destroyed
      await this.destroyContainer();
    }
  }

  /**
   * Build Docker run command with MAXIMUM security
   * SECURITY: Container is locked down to prevent provider inspection
   */
  private buildDockerCommand(
    task: { id: string; tool: string; model?: string; description: string; gitUrl: string; gitToken: string },
    oauthToken: string
  ): string[] {
    // Extract subdomain from FRP tunnel URL for Docker host mapping
    // FRP tunnels use format: http://subdomain.hoki.local:3999
    let tunnelSubdomain = '';
    const urlMatch = task.gitUrl.match(/http:\/\/([^\/]+)/);
    if (urlMatch) {
      const fullHost = urlMatch[1]; // e.g., "itchy-penguin-60.hoki.local:3999"
      if (fullHost.includes('.hoki.local') || fullHost.includes('.localhost')) {
        tunnelSubdomain = fullHost.split(':')[0]; // e.g., "itchy-penguin-60.hoki.local"
        console.log(chalk.gray('[DEBUG] Tunnel subdomain for host mapping:'), tunnelSubdomain);
      }
    }

    // Return array of arguments instead of string to avoid shell escaping issues
    return [
      'run',
      '--rm',                           // Auto-remove when stopped
      '--name', this.containerName!,    // Named for tracking
      '--privileged',                   // REQUIRED for LUKS encryption (needs loop devices and device mapper)
      '--cap-add', 'SYS_ADMIN',         // Required for device mapper and mount operations
      '--cap-add', 'MKNOD',             // Required for device creation
      '--device-cgroup-rule', 'b 7:* rmw', // Allow loop device access (major number 7)
      '--device-cgroup-rule', 'c 10:* rmw', // Allow device mapper control (major number 10)
      '--memory=1g',                    // Memory limit (increased for LUKS encryption)
      '--memory-swap=1g',               // No swap (prevent dumps)
      '--cpus=1',                       // CPU limit
      '--pids-limit=200',               // Process limit (increased for cryptsetup + AI CLIs)
      '--tmpfs', '/workspace:rw,size=300m,mode=0755', // Increased for encrypted.img (100MB + overhead)
      '--tmpfs', '/tmp:rw,size=50m,mode=1777',        // Writable /tmp for AI CLIs
      '--add-host=host.docker.internal:host-gateway',  // Allow container to reach host
      // Map FRP tunnel subdomain to host so container can access the tunnel
      ...(tunnelSubdomain ? [`--add-host=${tunnelSubdomain}:host-gateway`] : []),
      '--network=bridge',               // Isolated network
      // SECURITY NOTE: --privileged + specific caps are required for LUKS encryption operations
      // This enables loop device and device mapper operations. Code is still protected:
      // - All code is LUKS encrypted (provider sees only encrypted blob)
      // - Container is ephemeral (auto-removed after task)
      // - Workspace is tmpfs (exists only in RAM)
      // - No data persists on provider's machine after container exits
      '-e', `TASK_ID=${task.id}`,
      '-e', `GIT_URL=${task.gitUrl}`,  // Use original URL since we're mapping the host
      '-e', `GIT_TOKEN=${task.gitToken}`,
      '-e', `AI_TOOL=${task.tool}`,
      ...(task.model ? ['-e', `AI_MODEL=${task.model}`] : []), // Optional model specification
      '-e', `TASK_DESCRIPTION=${task.description}`,
      '-e', `OAUTH_TOKEN=${oauthToken}`,  // No quotes needed in array format
      // Enable debug pause if set in environment
      ...(process.env.DEBUG_PAUSE === 'true' ? ['-e', 'DEBUG_PAUSE=true'] : []),
      'hokipoki/secure-executor'
    ];
  }

  /**
   * Build secure container if not exists or outdated
   */
  private async buildSecureContainer(): Promise<void> {
    const dockerfilePath = path.join(CLI_ROOT, 'docker', 'Dockerfile.secure-executor');
    const buildContext = CLI_ROOT;

    try {
      // Check if image exists
      const inspectResult = await execAsync('docker image inspect hokipoki/secure-executor --format "{{.Created}}"');
      const imageCreated = new Date(inspectResult.stdout.trim());

      // Check if executor source is newer than image
      const executorPath = path.join(CLI_ROOT, 'container', 'executor.ts');
      const { stdout: statOutput } = await execAsync(`stat -f "%m" "${executorPath}" 2>/dev/null || stat -c "%Y" "${executorPath}" 2>/dev/null`);
      const sourceModified = new Date(parseInt(statOutput.trim()) * 1000);

      if (sourceModified > imageCreated) {
        console.log(chalk.yellow('[DEBUG] Source files newer than image, rebuilding...'));
        await execAsync(`docker build -f "${dockerfilePath}" -t hokipoki/secure-executor "${buildContext}"`);
      } else {
        console.log(chalk.gray('[DEBUG] Secure executor image is up to date'));
      }
    } catch {
      console.log(chalk.cyan('Building secure executor image...'));
      await execAsync(`docker build -f "${dockerfilePath}" -t hokipoki/secure-executor "${buildContext}"`);
    }
  }

  /**
   * Destroy container and wipe all traces
   */
  private async destroyContainer(): Promise<void> {
    if (this.containerName) {
      try {
        // Force remove container (auto-wipes tmpfs)
        await execAsync(`docker rm -f ${this.containerName}`);
      } catch {
        // Container might already be auto-removed
      }

      this.containerName = undefined;
    }
  }

  /**
   * Kill running container for a specific task (used when task is cancelled)
   */
  async killContainer(taskId: string): Promise<void> {
    try {
      // Find and kill all containers matching the task ID pattern
      const { stdout } = await execAsync(`docker ps -q -f name=hokipoki-${taskId}`);
      const containerIds = stdout.trim().split('\n').filter(id => id);

      if (containerIds.length > 0) {
        console.log(chalk.yellow(`\n🛑 Killing ${containerIds.length} running container(s) for task ${taskId}...`));
        for (const containerId of containerIds) {
          await execAsync(`docker rm -f ${containerId}`);
        }
        console.log(chalk.green('✅ Container(s) stopped'));
      }
    } catch (error) {
      // Silently ignore errors - container might already be stopped
      console.log(chalk.gray('[DEBUG] Container cleanup:', error instanceof Error ? error.message : 'No containers found'));
    }
  }

  /**
   * Playful animation while waiting for AI to finish
   * Shows animated HokiPoki song lyrics
   */
  private startHokiPokiAnimation(): NodeJS.Timeout {
    const frames = [
      chalk.cyan('♫ You put your ') + chalk.bold.yellow('MODEL') + chalk.cyan(' in...'),
      chalk.cyan('♫ You pull your ') + chalk.bold.yellow('PROMPT') + chalk.cyan(' out...'),
      chalk.cyan('♫ You share it ') + chalk.bold.yellow('ALL AROUND') + chalk.cyan('...'),
      chalk.cyan('♫ That\'s what it\'s ') + chalk.bold.yellow('ALL ABOUT') + chalk.cyan('!'),
      chalk.dim.italic('   🎵 HokiPoki is working... 🎵'),
    ];

    let frameIndex = 0;

    return setInterval(() => {
      // Clear the line and move cursor to beginning
      process.stdout.write('\r\x1b[K');
      // Write current frame
      process.stdout.write(frames[frameIndex]);
      // Move to next frame
      frameIndex = (frameIndex + 1) % frames.length;
    }, 800); // Change frame every 800ms
  }

  /**
   * Show provider status
   */
  async status(): Promise<void> {
    console.log(chalk.bold.cyan('\n📊 Provider Status\n'));

    const authenticatedTools = await this.oauthManager.getAuthenticatedTools();

    if (authenticatedTools.length > 0) {
      console.log(chalk.green('Authenticated tools:'));
      authenticatedTools.forEach(tool => {
        console.log(chalk.gray(`  • ${tool}`));
      });
    } else {
      console.log(chalk.yellow('No authenticated tools'));
      console.log(chalk.gray('Run: npm run cli register -- --as-provider --tools claude codex'));
    }

    // Check Docker
    try {
      await execAsync('docker --version');
      console.log(chalk.green('\n✅ Docker is installed'));
    } catch {
      console.log(chalk.red('\n❌ Docker is not installed'));
      return;
    }

    // Check secure image
    try {
      await execAsync('docker image inspect hokipoki/secure-executor');
      console.log(chalk.green('✅ Secure executor image is ready'));
    } catch {
      console.log(chalk.yellow('⚠️  Secure executor image needs to be built'));
      console.log(chalk.gray(`It will be built automatically when you run 'hokipoki listen'`));
    }
  }

  /**
   * Get Keycloak token for backend API calls
   */
  private async getBackendToken(): Promise<string> {
    return await this.keycloakManager.getToken();
  }

  /**
   * Log task to backend API
   */
  private async logTask(taskData: {
    id: string;
    tool: string;
    model?: string;
    description: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    credits?: number;
    providerId?: string;
    completedAt?: Date;
    summary?: string;
  }): Promise<void> {
    try {
      const token = await this.getBackendToken();

      if (!token) {
        // Silent fail if no token - don't block the main workflow
        return;
      }

      await fetch(`${this.backendUrl}/tasks`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          id: taskData.id,
          tool: taskData.tool,
          model: taskData.model,
          description: taskData.description,
          status: taskData.status,
          credits: taskData.credits || 0,
          createdAt: new Date().toISOString(),
          completedAt: taskData.completedAt?.toISOString(),
          providerId: taskData.providerId,
          summary: taskData.summary
        })
      });
    } catch (error) {
      // Silent fail - don't block the main workflow if backend logging fails
      console.error(chalk.dim('Note: Task logging to dashboard failed'));
    }
  }
}