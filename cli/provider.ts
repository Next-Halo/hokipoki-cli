// Provider CLI Command
// Handles provider-side operations: listening for tasks and executing them

import WebSocket from 'ws';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { MCPMessage, Task } from '../types';
import { P2PConnectionWS as P2PConnection } from '../p2p/connection-ws';
import { SecureProviderCLI } from './provider-secure';

// Supported tools whitelist
const SUPPORTED_TOOLS = ['claude', 'codex', 'gemini'];

interface ProviderOptions {
  tools?: string[];
  port: string;
  server: string;
}

export class ProviderCommand {
  private ws?: WebSocket;
  private peerId?: string;
  private p2pConnection?: P2PConnection;
  private availableTools: string[];
  private isListening = false;
  private secureProvider: SecureProviderCLI;
  private currentTask?: any;
  private keycloakManager?: any;
  private workspaceId?: string; // User's active workspace ID
  private workspaceIds: string[] = []; // All workspace IDs user is a member of
  private userId?: string; // User's ID

  constructor(private options: ProviderOptions) {
    this.availableTools = options.tools || [];
    this.secureProvider = new SecureProviderCLI();
  }

  private async detectAvailableTools(): Promise<string[]> {
    // Get tools that user has registered via OAuth
    const { OAuthManager } = await import('../auth/oauth-manager');
    const oauthManager = new OAuthManager();
    const authenticatedTools = await oauthManager.getAuthenticatedTools();

    if (authenticatedTools.length === 0) {
      console.log(chalk.yellow('\n⚠️  No registered AI tools found!'));
      console.log(chalk.gray('Please register your tools first:'));
      console.log(chalk.cyan('  hokipoki register --as-provider --tools claude codex gemini\n'));
      process.exit(1);
    }

    console.log(chalk.green(`✓ Found ${authenticatedTools.length} registered tool(s): ${authenticatedTools.join(', ')}`));
    return authenticatedTools;
  }

  async start() {
    // Check Keycloak authentication first
    const { KeycloakManager } = await import('../auth/keycloak-manager');
    this.keycloakManager = new KeycloakManager();

    if (!await this.keycloakManager.isAuthenticated()) {
      console.log(chalk.red('\n❌ Not authenticated.'));
      console.log(chalk.yellow('Please run: hokipoki login\n'));
      process.exit(1);
    }

    const userEmail = await this.keycloakManager.getUserEmail();
    console.log(chalk.green(`✅ Authenticated as: ${userEmail}\n`));

    // Fetch user's workspace IDs from profile
    try {
      const backendUrl = process.env.BACKEND_URL || 'https://api.hoki-poki.ai';
      const token = await this.keycloakManager.getToken();
      const response = await fetch(`${backendUrl}/api/profile`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      if (!response.ok) throw new Error('Failed to fetch profile');
      const data = await response.json() as {
        workspaceId?: string;
        id: string;
        workspaces?: Array<{ id: string }>;
      };
      this.workspaceId = data.workspaceId || undefined;
      this.userId = data.id;

      // Extract ALL workspace IDs from memberships
      if (data.workspaces && Array.isArray(data.workspaces)) {
        this.workspaceIds = data.workspaces.map((ws) => ws.id);
        console.log(chalk.gray(`Member of ${this.workspaceIds.length} workspace(s)\n`));
      } else if (this.workspaceId) {
        // Fallback to active workspace only
        this.workspaceIds = [this.workspaceId];
      }

      if (this.workspaceIds.length === 0) {
        console.log(chalk.yellow('⚠️  Warning: No workspaces found for user\n'));
      }
    } catch (error) {
      console.log(chalk.yellow('⚠️  Warning: Could not fetch workspace information\n'));
    }

    console.log(chalk.bold.cyan('🌐 HokiPoki Provider Mode\n'));

    // --tools flag is REQUIRED
    if (this.availableTools.length === 0) {
      console.log(chalk.red('\n❌ No tools specified!'));
      console.log(chalk.yellow('The --tools flag is required.'));
      console.log(chalk.gray('Example: hokipoki listen --tools gemini claude\n'));
      process.exit(1);
    }

    // Normalize tool names to lowercase
    this.availableTools = this.availableTools.map(t => t.toLowerCase());

    // Validate all requested tools are in SUPPORTED_TOOLS
    const unsupportedTools = this.availableTools.filter(t => !SUPPORTED_TOOLS.includes(t));
    if (unsupportedTools.length > 0) {
      console.log(chalk.red(`\n❌ Unsupported tool(s): ${unsupportedTools.join(', ')}`));
      console.log(chalk.yellow(`Supported tools: ${SUPPORTED_TOOLS.join(', ')}`));
      process.exit(1);
    }

    // Fetch user's registered tools from database and validate
    try {
      const backendUrl = process.env.BACKEND_URL || 'https://api.hoki-poki.ai';
      const token = await this.keycloakManager.getToken();

      const response = await fetch(`${backendUrl}/api/provider/tools`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) throw new Error('Failed to fetch registered tools');

      const data = await response.json() as { tools: string[] };
      const registeredTools = data.tools || [];

      // Check that all requested tools are registered
      const unregisteredTools = this.availableTools.filter(t => !registeredTools.includes(t));
      if (unregisteredTools.length > 0) {
        console.log(chalk.red(`\n❌ Tool(s) not registered: ${unregisteredTools.join(', ')}`));
        console.log(chalk.yellow('Please register your tools first:'));
        console.log(chalk.cyan(`  hokipoki register --as-provider --tools ${unregisteredTools.join(' ')}\n`));
        process.exit(1);
      }

      console.log(chalk.green(`✓ Validated ${this.availableTools.length} tool(s) against database`));
    } catch (error) {
      console.log(chalk.yellow('⚠️  Warning: Could not validate tools against database'));
      console.log(chalk.gray('   Continuing with local token validation only...'));
    }

    // Also validate local OAuth tokens exist
    const locallyValidatedTools = await this.detectAvailableTools();
    const missingLocalTokens = this.availableTools.filter(t => !locallyValidatedTools.includes(t));
    if (missingLocalTokens.length > 0) {
      console.log(chalk.red(`\n❌ Missing local tokens for: ${missingLocalTokens.join(', ')}`));
      console.log(chalk.yellow('Please refresh your local tokens:'));
      console.log(chalk.cyan(`  hokipoki register --as-provider --tools ${missingLocalTokens.join(' ')}\n`));
      process.exit(1);
    }

    console.log(chalk.gray('Available tools:'), this.availableTools.join(', '));
    console.log(chalk.gray('Relay Server:'), this.options.server);
    console.log(chalk.gray('P2P Port:'), this.options.port);
    console.log();

    const spinner = ora('Connecting to relay server...').start();

    try {
      await this.connectToMCP();
      spinner.succeed('Connected to relay server');

      // Fun random verbs
      const verbs = [
        'Shaking it all about',
        'Doing the HokiPoki',
        'Putting models in',
        'Pulling prompts out',
        'Sharing all around',
        'Vibing with AI'
      ];
      const randomVerb = verbs[Math.floor(Math.random() * verbs.length)];

      console.log(chalk.green(`\n✨ ${randomVerb}...`));
      console.log(chalk.gray('Press Ctrl+C to stop\n'));

      this.isListening = true;
    } catch (error) {
      spinner.fail('Failed to connect to relay server');
      console.error(chalk.red(error));
      process.exit(1);
    }
  }

  private async connectToMCP() {
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

          // STEP 2: After authentication succeeds, register as provider
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

            // Now that we're authenticated, register as provider
            const token = await this.keycloakManager.getToken();
            this.send({
              type: 'register_provider',
              payload: {
                tools: this.availableTools,
                workspaceIds: this.workspaceIds,  // Send array of all workspace IDs
                workspaceId: this.workspaceId,    // Keep for backward compatibility
                userId: this.userId,
                token: token  // Include token for relay server to verify with backend
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
        if (this.isListening) {
          console.log(chalk.yellow('\nConnection to relay server lost. Reconnecting...'));
          setTimeout(() => this.connectToMCP(), 5000);
        }
      });
    });
  }

  private async handleMCPMessage(message: any) {
    switch (message.type) {
      case 'new_task':
        await this.handleNewTask(message.task);
        break;

      case 'available_tasks':
        if (message.tasks.length > 0) {
          console.log(chalk.cyan(`\n${message.tasks.length} pending tasks available`));
          for (const task of message.tasks) {
            await this.handleNewTask(task);
          }
        }
        break;

      case 'task_matched':
      case 'task_accepted':
        await this.handleTaskMatched(message);
        break;

      case 'peer_signal':
        if (this.p2pConnection) {
          this.p2pConnection.handleSignal(message.payload);
        }
        break;

      case 'task_cancelled':
        console.log(chalk.red('\n' + '='.repeat(60)));
        console.log(chalk.bold.red('❌ TASK CANCELLED'));
        console.log(chalk.red('='.repeat(60)));
        console.log(chalk.yellow(`\nTask ID: ${message.taskId}`));
        console.log(chalk.yellow(`Reason: ${message.reason || 'Requester disconnected'}`));
        console.log(chalk.gray('\nThe requester has cancelled this task.'));
        console.log(chalk.gray('Stopping container and cleaning up...'));

        // Kill running container if there is one
        if (this.currentTask?.id) {
          await this.secureProvider.killContainer(this.currentTask.id);
        }

        // Update task status in database
        await this.markTaskAsCancelled(message.taskId);

        this.currentTask = undefined;
        this.cleanup();
        console.log(chalk.green('\n✨ Ready for new tasks...\n'));
        break;
    }
  }

  private async handleNewTask(task: Task) {
    console.log(chalk.bold.white('\n📋 New task available:'));
    console.log(chalk.white(`   ID: ${task.id}`));
    console.log(chalk.white(`   Tool: ${chalk.cyan(task.tool)}`));
    if (task.model) {
      console.log(chalk.white(`   Model: ${chalk.cyan(task.model)}`));
    }
    console.log(chalk.white(`   Description: ${task.description}`));
    console.log(chalk.white(`   Est. Duration: ~${task.estimatedDuration} mins`));

    const { accept } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'accept',
        message: 'Accept this task?',
        default: false  // Require explicit 'y' to prevent auto-accept from buffered stdin
      }
    ]);

    if (accept) {
      console.log(chalk.green('\n✅ Task accepted'));
      this.send({
        type: 'accept_task',
        taskId: task.id
      });
    } else {
      console.log(chalk.gray('Task declined'));

      // Notify relay server so it can offer task to other providers
      this.send({
        type: 'decline_task',
        taskId: task.id
      });
    }
  }

  private async handleTaskMatched(message: any) {
    console.log(chalk.green(`\n🤝 Matched with requester: ${message.requesterId}`));
    console.log(chalk.cyan('Establishing secure P2P connection...'));

    // Update task in backend with provider ID
    await this.updateTaskWithProvider(message.taskId);

    // Initialize P2P connection - reuse existing WebSocket
    this.p2pConnection = new P2PConnection(
      this.peerId!,
      message.requesterId,
      'provider',
      this.ws! // Pass existing WebSocket instead of URL
    );

    this.p2pConnection.on('connected', () => {
      console.log(chalk.green('✅ Secure P2P connection established'));
    });

    this.p2pConnection.on('data', async (data: any) => {
      try {
        console.log(chalk.gray(`[DEBUG] Received P2P data:`, JSON.stringify(data, null, 2)));
        await this.handleP2PData(data, message.taskId);
      } catch (error) {
        console.error(chalk.red('[ERROR] Failed to handle P2P data:'), error);
        console.error(chalk.red('Stack:'), error instanceof Error ? error.stack : 'No stack trace');
      }
    });

    this.p2pConnection.on('error', (error: Error) => {
      console.error(chalk.red('P2P connection error:'), error);
      this.cleanup();
    });

    await this.p2pConnection.connect();
  }

  private async handleP2PData(data: any, taskId: string) {
    console.log(chalk.gray(`[DEBUG] handleP2PData called with type: ${data.type}`));

    switch (data.type) {
      case 'git_credentials':
        console.log(chalk.cyan('[DEBUG] Calling executeTaskSecurely...'));
        await this.executeTaskSecurely(data.payload, taskId);
        break;

      case 'confirmation':
        if (data.payload.accepted) {
          console.log(chalk.green(`\n✅ Task completed!`));
          console.log(chalk.gray('Session data erased. Ready for next task.'));

          // Send acknowledgment back to requester so they can safely disconnect
          this.p2pConnection?.sendP2P({
            type: 'confirmation_ack',
            payload: { taskId: data.payload.taskId || taskId }
          });
        } else {
          console.log(chalk.yellow('\n❌ Solution rejected by requester.'));
        }
        this.cleanup();
        console.log(chalk.green('\n✨ Listening for new tasks...\n'));
        break;

      default:
        console.log(chalk.yellow(`[WARN] Unknown P2P message type: ${data.type}`));
    }
  }

  /**
   * Execute task securely in Docker container
   */
  private async executeTaskSecurely(payload: any, taskId: string) {
    console.log(chalk.cyan('\n📦 Preparing secure execution...'));
    console.log(chalk.gray('[DEBUG] Payload received:'), JSON.stringify(payload, null, 2));

    try {
      // Store task info
      this.currentTask = {
        id: taskId,
        tool: payload.tool,
        model: payload.model, // Optional specific model
        description: payload.taskDescription || payload.task,
        gitUrl: payload.gitUrl,
        gitToken: payload.gitToken
      };

      console.log(chalk.gray('[DEBUG] Task stored:'), JSON.stringify(this.currentTask, null, 2));
      console.log(chalk.cyan('[DEBUG] Calling secureProvider.executeTaskInContainer...'));
      console.log(chalk.cyan('[DEBUG] SecureProvider exists?'), !!this.secureProvider);

      // Execute in secure container on provider's machine
      await this.secureProvider.executeTaskInContainer(this.currentTask);

      console.log(chalk.green('[DEBUG] Container execution completed successfully'));

      // Notify requester of completion
      this.p2pConnection?.sendP2P({
        type: 'execution_complete',
        payload: {
          taskId: taskId
        }
      });

      console.log(chalk.green('\n✅ Execution complete, waiting for requester confirmation...'));

    } catch (error) {
      console.error(chalk.red('\n❌ Execution failed:'), error);
      console.error(chalk.red('[DEBUG] Error details:'), error instanceof Error ? error.message : error);
      console.error(chalk.red('[DEBUG] Stack trace:'), error instanceof Error ? error.stack : 'No stack');

      // Notify requester of failure
      this.p2pConnection?.sendP2P({
        type: 'execution_failed',
        payload: {
          taskId: taskId,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      });

      this.cleanup();
      console.log(chalk.green('\n✨ Listening for new tasks...\n'));
    }
  }


  /**
   * Update task in backend with provider ID
   */
  private async updateTaskWithProvider(taskId: string) {
    try {
      if (!this.keycloakManager) {
        console.log(chalk.yellow('[WARN] Cannot update task: KeycloakManager not initialized'));
        return;
      }

      const token = await this.keycloakManager.getToken();
      const backendUrl = process.env.BACKEND_URL || 'https://api.hoki-poki.ai';

      const response = await fetch(`${backendUrl}/api/tasks/${taskId}/provider`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
      });
      if (!response.ok) throw new Error('Failed to update task');

      console.log(chalk.gray(`[DEBUG] Task ${taskId} updated with provider ID`));
    } catch (error) {
      console.log(chalk.yellow(`[WARN] Failed to update task with provider ID: ${error instanceof Error ? error.message : error}`));
    }
  }

  /**
   * Mark task as cancelled in backend database
   */
  private async markTaskAsCancelled(taskId: string) {
    try {
      if (!this.keycloakManager) {
        console.log(chalk.yellow('[WARN] Cannot cancel task in DB: KeycloakManager not initialized'));
        return;
      }

      const token = await this.keycloakManager.getToken();
      const backendUrl = process.env.BACKEND_URL || 'https://api.hoki-poki.ai';

      const response = await fetch(`${backendUrl}/api/tasks/${taskId}/cancel`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
      });
      if (!response.ok) throw new Error('Failed to cancel task');

      console.log(chalk.gray(`[DEBUG] Task ${taskId} marked as cancelled in database`));
    } catch (error) {
      console.log(chalk.yellow(`[WARN] Failed to cancel task in database: ${error instanceof Error ? error.message : error}`));
    }
  }

  private cleanup() {
    if (this.p2pConnection) {
      this.p2pConnection.disconnect();
      this.p2pConnection = undefined;
    }
  }

  private send(message: MCPMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  stop() {
    this.isListening = false;
    this.cleanup();
    if (this.ws) {
      this.ws.close();
    }
  }
}