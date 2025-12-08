// Requester CLI Command
// Handles requester-side operations: publishing tasks and reviewing solutions

import WebSocket from 'ws';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { execSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';
import { MCPMessage } from '../types';
import { P2PConnectionWS as P2PConnection } from '../p2p/connection-ws';
import { EphemeralGitServer } from '../git-server/ephemeral-git';
import { KeycloakManager, TunnelConfig } from '../auth/keycloak-manager';
import { FrpConfig } from '../src/services/frp-manager';

interface RequesterOptions {
  tool: string;
  task: string;
  files?: string[];
  dir?: string[];
  all?: boolean;
  workspace?: string; // Workspace name to publish task to
  server: string;
  gitHost?: string;
  json?: boolean;
}

export class RequesterCommand {
  private ws?: WebSocket;
  private peerId?: string;
  private p2pConnection?: P2PConnection;
  private taskId?: string;
  private gitServer?: EphemeralGitServer;
  private jsonMode: boolean;
  private aiMode: boolean;
  private forceInteractive: boolean;
  private noAutoApply: boolean;
  private expandedFiles?: string[];
  private backendUrl: string;
  private keycloakManager: KeycloakManager;
  private toolName: string; // Extracted tool name (e.g., "claude")
  private modelName?: string; // Extracted model name (e.g., "sonnet")
  private workspaceId?: string; // User's workspace ID
  private userId?: string; // User's ID

  constructor(private options: RequesterOptions) {
    this.keycloakManager = new KeycloakManager();
    this.jsonMode = options.json || false;
    this.forceInteractive = (options as any).interactive || false;
    this.noAutoApply = (options as any).autoApply === false; // Commander sets --no-auto-apply as autoApply: false
    // AI mode: detect if running from non-TTY (AI CLI) or JSON mode
    // Can be overridden by --interactive flag
    this.aiMode = this.forceInteractive ? false : (!process.stdout.isTTY || this.jsonMode);
    this.backendUrl = process.env.BACKEND_URL || 'https://api.hoki-poki.ai/api';

    // Parse natural language if tool not specified
    if (!this.options.tool) {
      const parsed = this.parseNaturalRequest(this.options.task);
      if (parsed.tool) {
        this.options.tool = parsed.tool;
        this.options.task = parsed.task;
      } else {
        // Default to asking for any available tool
        this.options.tool = 'any';
      }
    }

    // Parse tool:model syntax
    const { tool, model } = this.parseToolAndModel(this.options.tool);
    this.toolName = tool;
    this.modelName = model;

    // Expand file list from various sources
    this.expandFileList();
  }

  /**
   * Parse tool:model syntax (e.g., "claude:sonnet" -> { tool: "claude", model: "sonnet" })
   */
  private parseToolAndModel(toolString: string): { tool: string, model?: string } {
    if (toolString.includes(':')) {
      const [tool, model] = toolString.split(':', 2);
      return { tool: tool.trim(), model: model.trim() };
    }
    return { tool: toolString.trim() };
  }

  private parseNaturalRequest(input: string): { tool?: string, task: string } {
    // Pattern matching for tool names in natural language
    const patterns = [
      { tool: 'codex', regex: /\b(codex|copilot|github copilot)\b/i },
      { tool: 'gemini', regex: /\b(gemini|google|bard)\b/i },
      { tool: 'claude', regex: /\b(claude|anthropic)\b/i },
      { tool: 'gpt4', regex: /\b(gpt-?4|openai|chatgpt)\b/i },
      { tool: 'llama', regex: /\b(llama|meta|facebook)\b/i }
    ];

    for (const { tool, regex } of patterns) {
      if (regex.test(input)) {
        // Remove tool mention from task for cleaner description
        const task = input.replace(regex, '').replace(/\s+/g, ' ').trim();
        console.log(chalk.cyan(`[Detected tool: ${tool} from natural language]`));
        return { tool, task };
      }
    }

    // No tool mentioned, return as-is
    return { task: input };
  }

  /**
   * Expand file list from --files, --dir, and --all options
   */
  private expandFileList(): void {
    const files: Set<string> = new Set();

    // Add specific files from --files
    if (this.options.files && this.options.files.length > 0) {
      this.options.files.forEach(f => files.add(f));
    }

    // Add files from directories --dir
    if (this.options.dir && this.options.dir.length > 0) {
      for (const dir of this.options.dir) {
        try {
          // Use glob to recursively find all files in directory
          const dirFiles = glob.sync(`${dir}/**/*`, {
            nodir: true,  // Only files, not directories
            dot: false,   // Don't include hidden files
            ignore: [
              `${dir}/**/node_modules/**`,
              `${dir}/**/dist/**`,
              `${dir}/**/.git/**`,
              `${dir}/**/.next/**`,
              `${dir}/**/build/**`,
              `${dir}/**/coverage/**`,
              `${dir}/**/*.log`,
              `${dir}/**/patches/**`,
              `${dir}/**/package-lock.json`,
              `${dir}/**/.hokipoki-tmp/**`  // CRITICAL: Exclude temp directory to prevent file corruption
            ]
          });
          dirFiles.forEach(f => files.add(f));
        } catch (error) {
          console.warn(chalk.yellow(`Warning: Could not read directory ${dir}`));
        }
      }
    }

    // Add all files from repo using git ls-files --all
    if (this.options.all) {
      try {
        // Use git ls-files to get all tracked files (respects .gitignore)
        const gitFiles = execSync('git ls-files', { encoding: 'utf-8' })
          .split('\n')
          .filter(f => f.trim().length > 0);
        gitFiles.forEach(f => files.add(f));
      } catch (error) {
        console.warn(chalk.yellow('Warning: Could not run git ls-files. Make sure you are in a git repository.'));
      }
    }

    this.expandedFiles = Array.from(files);
  }

  async execute() {
    // Setup signal handlers to cancel task on interrupt
    process.on('SIGINT', () => this.handleInterrupt());
    process.on('SIGTERM', () => this.handleInterrupt());

    // Check Keycloak authentication first
    const { KeycloakManager } = await import('../auth/keycloak-manager');
    const keycloak = new KeycloakManager();

    if (!await keycloak.isAuthenticated()) {
      if (this.jsonMode) {
        console.log(JSON.stringify({ error: 'Not authenticated. Please run: hokipoki login' }));
      } else {
        console.log(chalk.red('\n❌ Not authenticated.'));
        console.log(chalk.yellow('Please run: hokipoki login\n'));
      }
      process.exit(1);
    }

    const userEmail = await keycloak.getUserEmail();

    // Fetch user's workspaces from profile
    try {
      const token = await this.keycloakManager.getToken();
      const response = await fetch(`${this.backendUrl}/profile`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      if (!response.ok) throw new Error('Failed to fetch profile');
      const data = await response.json() as {
        workspaces?: Array<{ id: string; name: string; isPersonal?: boolean }>;
        id: string;
      };

      const workspaces = data.workspaces || [];
      this.userId = data.id;

      // Resolve workspace based on --workspace flag
      if (this.options.workspace) {
        // User specified a workspace name - find it
        const targetWorkspace = workspaces.find((w: any) => w.name === this.options.workspace);

        if (!targetWorkspace) {
          // Error: workspace not found
          const availableNames = workspaces.map((w: any) => w.name).join(', ');
          if (this.jsonMode) {
            console.log(JSON.stringify({
              error: `Workspace '${this.options.workspace}' not found`,
              availableWorkspaces: availableNames
            }));
          } else {
            console.log(chalk.red(`\n❌ Workspace '${this.options.workspace}' not found`));
            console.log(chalk.yellow('Available workspaces:'), availableNames || 'none');
          }
          process.exit(1);
        }

        this.workspaceId = targetWorkspace.id;
        if (!this.jsonMode) {
          console.log(chalk.gray('Publishing to workspace:'), targetWorkspace.name);
        }
      } else {
        // No workspace specified - use personal workspace (default)
        const personalWorkspace = workspaces.find((w: any) => w.isPersonal === true);

        if (personalWorkspace) {
          this.workspaceId = personalWorkspace.id;
        } else {
          console.log(chalk.yellow('\n⚠️  Warning: No personal workspace found'));
        }
      }
    } catch (error) {
      console.log(chalk.yellow('\n⚠️  Warning: Could not fetch workspace information'));
      if (this.options.workspace) {
        console.log(chalk.red('Cannot proceed without workspace information'));
        process.exit(1);
      }
    }

    // Check for active tasks before publishing (Layer 2: CLI enforcement)
    try {
      const token = await this.keycloakManager.getToken();
      const activeTasksResponse = await fetch(`${this.backendUrl}/tasks/active`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      if (!activeTasksResponse.ok) throw new Error('Failed to check active tasks');
      const activeTasksData = await activeTasksResponse.json() as {
        hasActiveTasks: boolean;
        activeTasks: Array<{
          id: string;
          tool: string;
          model?: string;
          status: string;
          description: string;
          createdAt: string;
          provider?: string;
        }>;
      };

      if (activeTasksData.hasActiveTasks) {
        const activeTask = activeTasksData.activeTasks[0];
        if (this.jsonMode) {
          console.log(JSON.stringify({
            error: 'You already have an active task',
            activeTask: {
              id: activeTask.id,
              tool: activeTask.tool,
              model: activeTask.model,
              status: activeTask.status,
              description: activeTask.description,
              createdAt: activeTask.createdAt,
              provider: activeTask.provider
            }
          }));
        } else {
          console.log(chalk.red('\n❌ You already have an active task in progress\n'));
          console.log(chalk.yellow('Please wait for it to complete before requesting a new task.\n'));
          console.log(chalk.cyan('Active task details:'));
          console.log(chalk.gray('  ID:'), activeTask.id.slice(0, 8) + '...');
          console.log(chalk.gray('  Tool:'), activeTask.tool);
          if (activeTask.model) {
            console.log(chalk.gray('  Model:'), activeTask.model);
          }
          console.log(chalk.gray('  Status:'), activeTask.status);
          console.log(chalk.gray('  Description:'), activeTask.description);
          console.log(chalk.gray('  Created:'), new Date(activeTask.createdAt).toLocaleString());
          if (activeTask.provider) {
            console.log(chalk.gray('  Provider:'), activeTask.provider);
          }
          console.log('');
        }
        process.exit(1);
      }
    } catch (error: any) {
      // If the endpoint returns 404 or any error, just warn but continue
      // This ensures backward compatibility if backend doesn't have the endpoint yet
      if (error.response?.status !== 404) {
        console.log(chalk.yellow('\n⚠️  Warning: Could not check for active tasks'));
      }
    }

    if (!this.jsonMode) {
      console.log(chalk.green(`✅ Authenticated as: ${userEmail}\n`));
      console.log(chalk.bold.cyan('🚀 HokiPoki Request Mode\n'));
      console.log(chalk.gray('Tool requested:'), this.toolName);
      if (this.modelName) {
        console.log(chalk.gray('Model:'), this.modelName);
      }
      console.log(chalk.gray('Task:'), this.options.task);

      if (this.expandedFiles && this.expandedFiles.length > 0) {
        console.log(chalk.gray('Files:'), `${this.expandedFiles.length} file(s)`);
        if (this.expandedFiles.length <= 5) {
          console.log(chalk.dim('  -', this.expandedFiles.join('\n  - ')));
        } else {
          console.log(chalk.dim('  -', this.expandedFiles.slice(0, 5).join('\n  - ')));
          console.log(chalk.dim(`  ... and ${this.expandedFiles.length - 5} more`));
        }
      }
    }

    const spinner = this.jsonMode ? null : ora('Connecting to relay server...').start();

    try {
      await this.connectToMCP();
      if (spinner) spinner.succeed('Connected to relay server');

      // Publish task
      await this.publishTask();

      // Wait for match
      if (!this.jsonMode) {
        console.log(chalk.cyan('\n⏳ Awaiting provider...'));
      }

    } catch (error) {
      if (spinner) spinner.fail('Failed to connect to relay server');

      if (this.jsonMode) {
        console.log(JSON.stringify({ success: false, error: String(error) }));
      } else {
        console.error(chalk.red(error));
      }
      process.exit(1);
    }
  }

  private async connectToMCP(): Promise<void> {
    return new Promise<void>(async (resolve, reject) => {
      this.ws = new WebSocket(this.options.server);

      this.ws.on('open', async () => {
        // STEP 1: Authenticate with JWT token (MUST be first message)
        try {
          const token = await this.keycloakManager.getToken();

          this.send({
            type: 'authenticate',
            token: token
          });

          // STEP 2: After authentication succeeds, register as requester
          // (connection_confirmed will trigger after auth success)
        } catch (error) {
          console.error(chalk.red('Failed to get authentication token:'), error);
          reject(error);
          return;
        }
      });

      this.ws.on('message', async (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());

          if (message.type === 'connection_confirmed') {
            this.peerId = message.peerId;

            // Now that we're authenticated, register as requester
            this.send({
              type: 'register_requester',
              payload: {
                workspaceId: this.workspaceId,
                userId: this.userId
              }
            });

            resolve();
            return;
          }

          await this.handleMCPMessage(message);
        } catch (error) {
          console.error(chalk.red('Error handling message:'), error);
        }
      });

      this.ws.on('error', (error) => {
        reject(error);
      });

      this.ws.on('close', () => {
        console.log(chalk.yellow('\nConnection to relay server lost'));
      });
    });
  }

  private async publishTask() {
    // Estimate credits based on task complexity
    const credits = this.estimateCredits();

    this.send({
      type: 'publish_task',
      payload: {
        tool: this.toolName,
        model: this.modelName,
        task: this.options.task,
        description: this.options.task,
        files: this.options.files || [],
        estimatedDuration: 5,
        credits,
        workspaceId: this.workspaceId  // Include workspace ID for routing
      }
    });
  }

  private estimateCredits(): number {
    // Simple heuristic for credit estimation
    const baseCredits = 2.5;
    const fileBonus = (this.options.files?.length || 0) * 0.5;
    const complexityBonus = this.options.task.length > 100 ? 1 : 0;

    return baseCredits + fileBonus + complexityBonus;
  }

  private async handleMCPMessage(message: any) {
    switch (message.type) {
      case 'task_published':
        this.taskId = message.taskId;
        console.log(chalk.green(`\n✅ Task published: ${message.taskId}`));

        // Log task to backend
        if (this.taskId) {
          await this.logTask({
            id: this.taskId,
            tool: this.toolName,
            model: this.modelName,
            description: this.options.task,
            status: 'pending'
          });
        }
        break;

      case 'task_matched':
      case 'provider_matched':  // Support both for compatibility
        await this.handleTaskMatched(message);
        break;

      case 'peer_signal':
        if (this.p2pConnection) {
          this.p2pConnection.handleSignal(message.payload);
        }
        break;

      case 'task_cancelled':
        console.log(chalk.red(`\nTask cancelled: ${message.reason}`));
        process.exit(1);
        break;

      case 'no_providers_available':
        const toolInfo = message.model ? `${message.tool}:${message.model}` : message.tool;
        console.error(chalk.red(`\n❌ No providers available for tool: ${toolInfo}`));
        console.log(chalk.yellow('All providers declined or no providers are online.'));
        console.log(chalk.gray('Try again later or request a different tool.'));

        // Mark task as failed in database
        if (this.taskId) {
          await this.logTask({
            id: this.taskId,
            tool: this.toolName,
            model: this.modelName,
            description: this.options.task,
            status: 'failed'
          });
        }

        await this.cleanup();
        process.exit(1);
        break;

      case 'error':
        console.error(chalk.red(`\nError: ${message.error}`));
        process.exit(1);
        break;
    }
  }

  private async handleTaskMatched(message: any) {
    if (!this.jsonMode) {
      console.log(chalk.green(`\n🤝 Matched with provider: ${message.providerId}`));
      console.log(chalk.cyan('Establishing secure P2P connection...'));
    }

    // Initialize P2P connection - reuse existing WebSocket
    this.p2pConnection = new P2PConnection(
      this.peerId!,
      message.providerId,
      'requester',
      this.ws! // Pass existing WebSocket instead of URL
    );

    this.p2pConnection.on('connected', async () => {
      if (!this.jsonMode) {
        console.log(chalk.green('✅ Secure P2P connection established'));
        console.log(chalk.cyan('Setting up encrypted git server...'));
      }
      await this.setupGitServerAndSendCredentials();
    });

    this.p2pConnection.on('data', async (data: any) => {
      await this.handleP2PData(data);
    });

    this.p2pConnection.on('error', (error: Error) => {
      if (this.jsonMode) {
        console.log(JSON.stringify({ success: false, error: error.message }));
      } else {
        console.error(chalk.red('P2P connection error:'), error);
      }
      process.exit(1);
    });

    await this.p2pConnection.connect();
  }

  /**
   * Setup ephemeral git server and send credentials to provider
   */
  private async setupGitServerAndSendCredentials() {
    const spinner = this.jsonMode ? null : ora('Setting up ephemeral git server...').start();

    try {
      // Fetch tunnel config from backend (requires authentication)
      if (spinner) spinner.text = 'Fetching tunnel configuration...';
      const tunnelConfig = await this.keycloakManager.getTunnelConfig();

      // Convert TunnelConfig to FrpConfig
      const frpConfig: FrpConfig = {
        token: tunnelConfig.token,
        serverAddr: tunnelConfig.serverAddr,
        serverPort: tunnelConfig.serverPort,
        tunnelDomain: tunnelConfig.tunnelDomain,
        httpPort: tunnelConfig.httpPort
      };

      if (spinner) spinner.text = 'Setting up ephemeral git server...';

      // Initialize ephemeral git server with tunnel config
      this.gitServer = new EphemeralGitServer({
        taskId: this.taskId!,
        gitHost: this.options.gitHost,
        tunnelConfig: frpConfig
      });

      // Initialize with expanded file list
      await this.gitServer.initialize(this.expandedFiles || []);

      // Start git server
      await this.gitServer.start();
      const gitConfig = await this.gitServer.getConfig();

      if (spinner) spinner.succeed('Git server ready');

      // Send git credentials to provider via P2P
      if (!this.jsonMode) {
        console.log(chalk.cyan('Sending encrypted git credentials to provider...'));
      }

      this.p2pConnection?.sendP2P({
        type: 'git_credentials',
        payload: {
          gitUrl: gitConfig.url,
          gitToken: gitConfig.token,
          tool: this.toolName,           // Base tool name (e.g., "codex")
          model: this.modelName,          // Optional model (e.g., "gpt-5-codex-high")
          taskDescription: this.options.task
        }
      });

      if (!this.jsonMode) {
        console.log(chalk.cyan('Waiting for provider to execute task on their machine...'));
      }

    } catch (error) {
      if (spinner) spinner.fail('Failed to setup git server');

      if (this.jsonMode) {
        console.log(JSON.stringify({ success: false, error: String(error) }));
      } else {
        console.error(chalk.red(error));
      }

      if (this.gitServer) {
        await this.gitServer.stop();
      }

      process.exit(1);
    }
  }


  private async handleP2PData(data: any) {
    switch (data.type) {
      case 'execution_complete':
        await this.handleExecutionComplete();
        break;

      case 'execution_failed':
        if (this.jsonMode) {
          console.log(JSON.stringify({ success: false, error: data.payload.error }));
        } else {
          console.error(chalk.red(`\nProvider execution failed: ${data.payload.error}`));
        }

        // Log task failure to backend
        if (this.taskId) {
          await this.logTask({
            id: this.taskId,
            tool: this.toolName,
            model: this.modelName,
            description: this.options.task,
            status: 'failed',
            completedAt: new Date()
          });
        }

        await this.cleanup();
        process.exit(1);
        break;

      case 'confirmation_ack':
        // Provider acknowledged our confirmation - safe to disconnect now
        if (!this.jsonMode) {
          console.log(chalk.gray('Provider acknowledged completion'));
        }
        await this.cleanup();
        process.exit(0);
        break;

      case 'error':
        if (this.jsonMode) {
          console.log(JSON.stringify({ success: false, error: data.payload.error }));
        } else {
          console.error(chalk.red(`\nProvider error: ${data.payload.error}`));
        }
        await this.cleanup();
        process.exit(1);
        break;
    }
  }

  /**
   * Handle execution completion - fetch changes from git
   */
  private async handleExecutionComplete() {
    const spinner = this.jsonMode ? null : ora('Fetching results from git...').start();

    try {
      if (!this.gitServer) {
        throw new Error('Git server not initialized');
      }

      // Get changes from git
      const changes = await this.gitServer.getChanges();

      if (spinner) spinner.succeed('Results received');

      if (changes && changes.trim()) {
        // Check if this includes AI review output
        const hasReviewOutput = changes.includes('AI_OUTPUT.md');

        // Check if there are actual code changes (not just AI_OUTPUT.md)
        const codeChanges = this.extractCodeChanges(changes);
        const hasCodeChanges = codeChanges.trim().length > 0;

        // Extract AI review output if present
        let aiOutput = '';
        if (hasReviewOutput) {
          const outputMatch = changes.match(/\+## Output\n\+([\s\S]*?)(?=diff --git|$)/);
          if (outputMatch && outputMatch[1]) {
            aiOutput = outputMatch[1].split('\n')
              .filter(line => line.startsWith('+'))
              .map(line => line.substring(1))
              .join('\n');

            if (!this.jsonMode) {
              console.log(chalk.bold.cyan('\n📝 AI Review Results:\n'));
              console.log(chalk.white(aiOutput));
            }
          }
        }

        // If there are code changes, offer to review and apply them
        if (hasCodeChanges) {
          if (!this.jsonMode) {
            console.log(chalk.bold.cyan('\n📝 Code Changes:\n'));
          }
          await this.reviewSolution({ diff: codeChanges, aiReview: aiOutput });
          return; // Exit early - reviewSolution handles cleanup
        }

        // If only review output (no code changes), auto-accept
        if (hasReviewOutput && !hasCodeChanges) {
          // Log task completion to backend (before sending confirmation)
          if (this.taskId) {
            await this.logTask({
              id: this.taskId,
              tool: this.toolName,
              model: this.modelName,
              description: this.options.task,
              status: 'completed',
              credits: 2.5,
              completedAt: new Date()
            });
          }

          this.p2pConnection?.sendP2P({
            type: 'confirmation',
            payload: {
              accepted: true,
              credits: 2.5,
              taskId: this.taskId
            }
          });

          if (this.jsonMode) {
            console.log(JSON.stringify({
              success: true,
              hasCodeChanges: false,
              aiReview: aiOutput,
              credits: 2.5
            }));
          } else {
            console.log(chalk.green('\n✅ Review received from provider'));
            console.log(chalk.green('💰 2.5 credits transferred to provider'));
            console.log(chalk.gray('Waiting for provider acknowledgment...'));
          }

          // Don't cleanup/exit here - wait for confirmation_ack in handleP2PData
          return;
        }

      } else {
        // No changes - still log completion and wait for ack
        if (this.taskId) {
          await this.logTask({
            id: this.taskId,
            tool: this.toolName,
            model: this.modelName,
            description: this.options.task,
            status: 'completed',
            credits: 2.5,
            completedAt: new Date()
          });
        }

        this.p2pConnection?.sendP2P({
          type: 'confirmation',
          payload: {
            accepted: true,
            credits: 2.5,
            taskId: this.taskId
          }
        });

        if (this.jsonMode) {
          console.log(JSON.stringify({
            success: true,
            hasCodeChanges: false,
            credits: 2.5
          }));
        } else {
          console.log(chalk.yellow('\nNo changes were made'));
          console.log(chalk.green('💰 2.5 credits transferred to provider'));
          console.log(chalk.gray('Waiting for provider acknowledgment...'));
        }

        // Don't cleanup/exit here - wait for confirmation_ack in handleP2PData
        return;
      }

    } catch (error) {
      if (spinner) spinner.fail('Failed to fetch results');

      if (this.jsonMode) {
        console.log(JSON.stringify({ success: false, error: String(error) }));
      } else {
        console.error(chalk.red(error));
      }

      await this.cleanup();
      process.exit(1);
    }
  }

  /**
   * Wait for confirmation_ack with a timeout fallback
   * This prevents hanging forever if provider doesn't respond
   */
  private async waitForAckWithTimeout(timeoutMs: number = 5000): Promise<void> {
    return new Promise((resolve) => {
      const timeout = setTimeout(async () => {
        // Timeout reached - cleanup and exit anyway
        if (!this.jsonMode) {
          console.log(chalk.gray('Provider ack timeout - cleaning up...'));
        }
        await this.cleanup();
        process.exit(0);
      }, timeoutMs);

      // The actual ack handler in handleP2PData will call cleanup and exit
      // This timeout is just a fallback safety net
      // Clear timeout if we're somehow still running after ack
      // (shouldn't happen since handleP2PData calls process.exit)
    });
  }

  /**
   * Cleanup git server and temp files
   */
  private async cleanup() {
    if (this.gitServer) {
      await this.gitServer.stop();
    }
  }

  private async reviewSolution(payload: any) {
    try {
      // Detect new files in the diff
      const newFiles = this.detectNewFiles(payload.diff);

      // Auto-create new files before patch processing
      if (newFiles.length > 0) {
        console.log(chalk.cyan(`\n📄 Detected ${newFiles.length} new file(s):`));

        for (const filename of newFiles) {
          const content = this.extractNewFileContent(payload.diff, filename);
          if (content) {
            const filepath = path.join(process.cwd(), filename);

            // Create directory if needed
            const dir = path.dirname(filepath);
            await fs.mkdir(dir, { recursive: true });

            // Write the file
            await fs.writeFile(filepath, content, 'utf8');
            console.log(chalk.green(`   ✅ Created: ${filename}`));
          }
        }
        console.log('');
      }

      // Save patch file
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const patchFileName = `hokipoki-${this.taskId}-${timestamp}.patch`;
      const patchDir = path.join(process.cwd(), 'patches');
      const patchFilePath = path.join(patchDir, patchFileName);

      // Create patches directory if it doesn't exist
      await fs.mkdir(patchDir, { recursive: true });

      await fs.writeFile(patchFilePath, payload.diff, 'utf8');

      // Extract diff summary for JSON output
      const summary = this.parseDiffSummary(payload.diff);

      if (this.jsonMode) {
        // Log task completion to backend first
        if (this.taskId) {
          await this.logTask({
            id: this.taskId,
            tool: this.toolName,
            model: this.modelName,
            description: this.options.task,
            status: 'completed',
            credits: 2.5,
            completedAt: new Date()
          });
        }

        // Auto-save in JSON mode and output results
        this.p2pConnection?.sendP2P({
          type: 'confirmation',
          payload: {
            accepted: true,
            credits: 2.5,
            taskId: this.taskId
          }
        });

        console.log(JSON.stringify({
          success: true,
          hasCodeChanges: true,
          aiReview: payload.aiReview || '',
          patch: payload.diff,
          patchFile: patchFileName,
          summary: {
            filesChanged: summary.files.size,
            insertions: summary.insertions,
            deletions: summary.deletions
          },
          files: Array.from(summary.files),
          credits: 2.5
        }));

        // Notify MCP server
        this.send({
          type: 'task_complete',
          taskId: this.taskId
        });

        // Wait for confirmation_ack with timeout fallback
        await this.waitForAckWithTimeout();
        return;
      }

      // Interactive mode - display and prompt
      console.log(chalk.gray(`\n💾 Patch saved: patches/${patchFileName}\n`));

      // Display diff with summary
      console.log(chalk.bold.cyan('📝 Proposed changes:\n'));
      this.displayDiffSummary(payload.diff);
      this.displayDiff(payload.diff);

      // AI mode: output structured blocks and exit instead of prompting
      if (this.aiMode) {
        console.log('\n[HOKIPOKI_RESULT]');
        console.log(`status: success`);
        console.log(`patch_file: patches/${patchFileName}`);
        console.log(`files_changed: ${summary.files.size}`);
        console.log(`insertions: ${summary.insertions}`);
        console.log(`deletions: ${summary.deletions}`);
        console.log('[/HOKIPOKI_RESULT]');

        console.log('\n[HOKIPOKI_PATCH]');
        console.log(payload.diff);
        console.log('[/HOKIPOKI_PATCH]');

        // Log task completion to backend first (before confirmation)
        if (this.taskId) {
          await this.logTask({
            id: this.taskId,
            tool: this.toolName,
            model: this.modelName,
            description: this.options.task,
            status: 'completed',
            credits: 2.5,
            completedAt: new Date()
          });
        }

        // In AI mode: auto-apply patch by default (unless --no-auto-apply flag is set)
        if (this.noAutoApply) {
          // User explicitly disabled auto-apply
          console.log(chalk.cyan(`\n📄 Patch saved: patches/${patchFileName}`));
          console.log(chalk.gray('Apply it with:'), chalk.cyan(`git apply patches/${patchFileName}`));

          this.p2pConnection?.sendP2P({
            type: 'confirmation',
            payload: { accepted: true, credits: 2.5, taskId: this.taskId }
          });

          this.send({ type: 'task_complete', taskId: this.taskId });

          // Wait for confirmation_ack with timeout fallback
          await this.waitForAckWithTimeout();
          return;
        }

        // Auto-apply patch
        try {
          // Check if patch can be applied cleanly
          execSync(`git apply --check "${patchFilePath}"`, { stdio: 'pipe' });

          // Apply the patch
          execSync(`git apply "${patchFilePath}"`, { stdio: 'inherit' });

          console.log(chalk.green('\n✅ Changes applied successfully'));
          console.log(chalk.gray(`Patch file: patches/${patchFileName}`));

          // Clean up patch file after successful apply
          await fs.unlink(patchFilePath);

          // Confirm with provider
          this.p2pConnection?.sendP2P({
            type: 'confirmation',
            payload: { accepted: true, credits: 2.5, taskId: this.taskId }
          });

          console.log(chalk.green('💰 2.5 credits transferred to provider'));

        } catch (error: any) {
          console.error(chalk.red('\n❌ Failed to apply patch automatically'));
          console.error(chalk.yellow('The patch may have conflicts with your current code.'));
          console.log(chalk.gray(`\nPatch saved at: patches/${patchFileName}`));
          console.log(chalk.gray('Review and apply it manually with:'), chalk.cyan(`git apply patches/${patchFileName}`));

          // Still confirm with provider even if apply failed
          this.p2pConnection?.sendP2P({
            type: 'confirmation',
            payload: { accepted: true, credits: 2.5, taskId: this.taskId }
          });
          console.log(chalk.green('💰 2.5 credits transferred to provider'));
        }

        this.send({ type: 'task_complete', taskId: this.taskId });

        // Wait for confirmation_ack with timeout fallback
        await this.waitForAckWithTimeout();
        return;
      }

      // Interactive mode (human manually running CLI or --interactive flag)
      const { action } = await inquirer.prompt([
        {
          type: 'list',
          name: 'action',
          message: 'How would you like to proceed?',
          choices: [
            { name: 'Apply changes now (git apply)', value: 'apply' },
            { name: 'Keep patch file for manual review', value: 'save' },
            { name: 'Reject changes', value: 'reject' }
          ],
          default: 'apply'
        }
      ]);

      // Log task completion to backend first
      if (this.taskId) {
        await this.logTask({
          id: this.taskId,
          tool: this.toolName,
          model: this.modelName,
          description: this.options.task,
          status: action === 'reject' ? 'failed' : 'completed',
          credits: action === 'reject' ? 0 : 2.5,
          completedAt: new Date()
        });
      }

      if (action === 'apply') {
        // Check if patch can be applied cleanly
        try {
          execSync(`git apply --check "${patchFilePath}"`, { stdio: 'pipe' });

          // Apply the patch
          execSync(`git apply "${patchFilePath}"`, { stdio: 'inherit' });

          console.log(chalk.green('\n✅ Changes applied successfully'));
          console.log(chalk.gray(`Run 'git status' to see the changes`));

          // Clean up patch file after successful apply
          await fs.unlink(patchFilePath);

          // Confirm with provider
          this.p2pConnection?.sendP2P({
            type: 'confirmation',
            payload: {
              accepted: true,
              credits: 2.5,
              taskId: this.taskId
            }
          });

          console.log(chalk.green('💰 2.5 credits transferred to provider'));

        } catch (error: any) {
          console.error(chalk.red('\n❌ Failed to apply patch'));
          console.error(chalk.yellow('The patch may have conflicts with your current code.'));
          console.log(chalk.gray(`\nYou can manually apply it later with:`));
          console.log(chalk.cyan(`  git apply patches/${patchFileName}`));
          console.log(chalk.gray(`Or review it with:`));
          console.log(chalk.cyan(`  cat patches/${patchFileName}`));

          // Still confirm with provider even if apply failed
          this.p2pConnection?.sendP2P({
            type: 'confirmation',
            payload: {
              accepted: true,
              credits: 2.5,
              taskId: this.taskId
            }
          });
          console.log(chalk.green('💰 2.5 credits transferred to provider'));
        }

      } else if (action === 'save') {
        console.log(chalk.green('\n💾 Patch saved for later review'));
        console.log(chalk.gray(`\nTo apply manually:`));
        console.log(chalk.cyan(`  git apply patches/${patchFileName}`));

        // Confirm with provider
        this.p2pConnection?.sendP2P({
          type: 'confirmation',
          payload: {
            accepted: true,
            credits: 2.5,
            taskId: this.taskId
          }
        });
        console.log(chalk.green('💰 2.5 credits transferred to provider'));

      } else {
        console.log(chalk.yellow('\n❌ Changes rejected'));

        // Delete patch file if rejected
        await fs.unlink(patchFilePath);

        this.p2pConnection?.sendP2P({
          type: 'confirmation',
          payload: {
            accepted: false,
            taskId: this.taskId
          }
        });
      }

      // Notify MCP server of completion
      this.send({
        type: 'task_complete',
        taskId: this.taskId
      });

      console.log(chalk.gray('Waiting for provider acknowledgment...'));

      // Wait for confirmation_ack with timeout fallback
      await this.waitForAckWithTimeout();

    } catch (error) {
      console.error(chalk.red('Error reviewing solution:'), error);
      await this.cleanup();
      process.exit(1);
    }
  }

  private extractCodeChanges(fullDiff: string): string {
    // Extract only code changes, excluding AI_OUTPUT.md
    const lines = fullDiff.split('\n');
    const result: string[] = [];
    let inAIOutput = false;
    let inCodeChange = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Check if we're entering/exiting AI_OUTPUT.md section
      if (line.startsWith('diff --git') && line.includes('AI_OUTPUT.md')) {
        inAIOutput = true;
        inCodeChange = false;
        continue;
      } else if (line.startsWith('diff --git') && !line.includes('AI_OUTPUT.md')) {
        inAIOutput = false;
        inCodeChange = true;
      }

      // Include lines that are part of code changes
      if (inCodeChange || (!inAIOutput && line.startsWith('diff --git'))) {
        result.push(line);
      }
    }

    return result.join('\n');
  }

  private detectNewFiles(diff: string): string[] {
    // Detect new files from git diff (look for "new file mode" marker)
    const lines = diff.split('\n');
    const newFiles: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('new file mode')) {
        // Look backwards for the filename in the diff --git line
        for (let j = i - 1; j >= 0; j--) {
          if (lines[j].startsWith('diff --git')) {
            const match = lines[j].match(/diff --git a\/(.*) b\/(.*)/);
            if (match && match[2]) {
              newFiles.push(match[2]);
            }
            break;
          }
        }
      }
    }

    return newFiles;
  }

  private extractNewFileContent(diff: string, filename: string): string | null {
    // Extract content of a new file from the diff
    const lines = diff.split('\n');
    const content: string[] = [];
    let inTargetFile = false;
    let inContent = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Check if we're entering the target file's diff
      if (line.startsWith('diff --git') && line.includes(filename)) {
        inTargetFile = true;
        continue;
      }

      // Check if we're leaving this file's diff
      if (inTargetFile && line.startsWith('diff --git') && !line.includes(filename)) {
        break;
      }

      // Start capturing content after the @@ marker
      if (inTargetFile && line.startsWith('@@')) {
        inContent = true;
        continue;
      }

      // Capture lines that start with + (new content)
      if (inTargetFile && inContent && line.startsWith('+')) {
        content.push(line.substring(1)); // Remove the + prefix
      }
    }

    return content.length > 0 ? content.join('\n') : null;
  }

  private parseDiffSummary(diff: string): { files: Set<string>, insertions: number, deletions: number } {
    // Parse diff to extract file statistics
    const lines = diff.split('\n');
    const files = new Set<string>();
    let insertions = 0;
    let deletions = 0;

    for (const line of lines) {
      if (line.startsWith('diff --git')) {
        // Extract file name from diff header
        const match = line.match(/diff --git a\/(.*) b\//);
        if (match) {
          files.add(match[1]);
        }
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        insertions++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        deletions++;
      }
    }

    return { files, insertions, deletions };
  }

  private displayDiffSummary(diff: string) {
    const { files, insertions, deletions } = this.parseDiffSummary(diff);

    // Display summary
    const fileCount = files.size;
    const fileWord = fileCount === 1 ? 'file' : 'files';
    console.log(chalk.bold(`${fileCount} ${fileWord} changed`), chalk.green(`${insertions} insertions(+)`), chalk.red(`${deletions} deletions(-)`));

    if (files.size > 0) {
      console.log(chalk.gray('\nModified files:'));
      files.forEach(file => {
        console.log(chalk.gray(`  • ${file}`));
      });
    }
    console.log('');
  }

  private displayDiff(changes: string) {
    // Parse and colorize diff output
    const lines = changes.split('\n');
    for (const line of lines) {
      if (line.startsWith('+')) {
        console.log(chalk.green(line));
      } else if (line.startsWith('-')) {
        console.log(chalk.red(line));
      } else if (line.startsWith('@@')) {
        console.log(chalk.cyan(line));
      } else {
        console.log(line);
      }
    }
  }

  private send(message: MCPMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  /**
   * Get backend auth token from Keycloak
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
          providerId: taskData.providerId
        })
      });
    } catch (error) {
      // Silent fail - don't block the main workflow if backend logging fails
      console.error(chalk.dim('Note: Task logging to dashboard failed'));
    }
  }

  /**
   * Handle process interrupt (Ctrl+C or kill) - cancel task in database
   */
  private async handleInterrupt() {
    if (!this.jsonMode) {
      console.log(chalk.yellow('\n\n⚠️  Process interrupted - cancelling task...'));
    }

    // Cancel task in backend database if we have a task ID
    if (this.taskId) {
      try {
        const token = await this.keycloakManager.getToken();
        if (token) {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 3000);
          await fetch(`${this.backendUrl}/tasks/${this.taskId}/cancel`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({}),
            signal: controller.signal
          });
          clearTimeout(timeoutId);
          if (!this.jsonMode) {
            console.log(chalk.gray('Task cancelled in database'));
          }
        }
      } catch (error) {
        // Silent fail - process is exiting anyway
      }
    }

    // Cleanup resources
    await this.cleanup();

    if (!this.jsonMode) {
      console.log(chalk.gray('Cleanup complete'));
    }

    process.exit(130); // Standard exit code for SIGINT
  }
}