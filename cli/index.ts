#!/usr/bin/env node

// HokiPoki CLI - Main entry point
// Provides both provider and requester functionality

import { Command } from 'commander';
import chalk from 'chalk';
import { ProviderCommand } from './provider';
import { RequesterCommand } from './requester';
import { SecureProviderCLI } from './provider-secure';
import { KeycloakManager } from '../auth/keycloak-manager';
import { version } from '../package.json';
import { handleCompletion, installCompletion, uninstallCompletion } from './completion';

// Handle tab completion (must be before any output)
// tabtab requires all three: COMP_LINE, COMP_CWORD, and COMP_POINT
if (process.env.COMP_LINE && process.env.COMP_CWORD && process.env.COMP_POINT) {
  handleCompletion();
  process.exit(0);
}

const program = new Command();

// Combined logo and banner
const banner = `
       ${chalk.rgb(0, 232, 217)('●')}      ${chalk.rgb(0, 232, 217)('██╗  ██╗')} ${chalk.rgb(0, 232, 217)('██████╗')}  ${chalk.rgb(255, 100, 166)('██╗  ██╗')} ${chalk.rgb(255, 100, 166)('██╗')}     ${chalk.rgb(212, 255, 63)('██████╗')}  ${chalk.rgb(212, 255, 63)('██████╗')}  ${chalk.rgb(0, 232, 217)('██╗  ██╗')} ${chalk.rgb(0, 232, 217)('██╗')}
      ${chalk.rgb(0, 232, 217)('╱')} ${chalk.rgb(0, 232, 217)('╲')}     ${chalk.rgb(0, 232, 217)('██║  ██║')} ${chalk.rgb(0, 232, 217)('██╔═══██╗')} ${chalk.rgb(255, 100, 166)('██║ ██╔╝')} ${chalk.rgb(255, 100, 166)('██║')}     ${chalk.rgb(212, 255, 63)('██╔══██╗')} ${chalk.rgb(212, 255, 63)('██╔═══██╗')} ${chalk.rgb(0, 232, 217)('██║ ██╔╝')} ${chalk.rgb(0, 232, 217)('██║')}
     ${chalk.rgb(0, 232, 217)('╱')}   ${chalk.rgb(0, 232, 217)('╲')}    ${chalk.rgb(0, 232, 217)('███████║')} ${chalk.rgb(0, 232, 217)('██║   ██║')} ${chalk.rgb(255, 100, 166)('█████╔╝')}  ${chalk.rgb(255, 100, 166)('██║')} ${chalk.rgb(255, 100, 166)('━━━')} ${chalk.rgb(212, 255, 63)('██████╔╝')} ${chalk.rgb(212, 255, 63)('██║   ██║')} ${chalk.rgb(0, 232, 217)('█████╔╝')}  ${chalk.rgb(0, 232, 217)('██║')}
    ${chalk.rgb(255, 100, 166)('●')}─────${chalk.rgb(212, 255, 63)('●')}   ${chalk.rgb(0, 232, 217)('██╔══██║')} ${chalk.rgb(0, 232, 217)('██║   ██║')} ${chalk.rgb(255, 100, 166)('██╔═██╗')}  ${chalk.rgb(255, 100, 166)('██║')}     ${chalk.rgb(212, 255, 63)('██╔═══╝')}  ${chalk.rgb(212, 255, 63)('██║   ██║')} ${chalk.rgb(0, 232, 217)('██╔═██╗')}  ${chalk.rgb(0, 232, 217)('██║')}
     ${chalk.rgb(255, 100, 166)('╲')}   ${chalk.rgb(212, 255, 63)('╱')}    ${chalk.rgb(0, 232, 217)('██║  ██║')} ${chalk.rgb(0, 232, 217)('╚██████╔╝')} ${chalk.rgb(255, 100, 166)('██║  ██╗')} ${chalk.rgb(255, 100, 166)('██║')}     ${chalk.rgb(212, 255, 63)('██║')}      ${chalk.rgb(212, 255, 63)('╚██████╔╝')} ${chalk.rgb(0, 232, 217)('██║  ██╗')} ${chalk.rgb(0, 232, 217)('██║')} ${chalk.rgb(212, 255, 63).bold('.AI')}
      ${chalk.rgb(255, 100, 166)('╲')} ${chalk.rgb(212, 255, 63)('╱')}     ${chalk.rgb(0, 232, 217)('╚═╝  ╚═╝')} ${chalk.rgb(0, 232, 217)(' ╚═════╝')}  ${chalk.rgb(255, 100, 166)('╚═╝  ╚═╝')} ${chalk.rgb(255, 100, 166)('╚═╝')}     ${chalk.rgb(212, 255, 63)('╚═╝')}       ${chalk.rgb(212, 255, 63)('╚═════╝')}  ${chalk.rgb(0, 232, 217)('╚═╝  ╚═╝')} ${chalk.rgb(0, 232, 217)('╚═╝')}
       ${chalk.rgb(212, 255, 63)('●')}
`;

// Show banner if no arguments or only --help
function showBanner() {
  if (process.argv.length === 2 || process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(banner);

    console.log(chalk.dim.italic('\n  ♫ You put your model in,'));
    console.log(chalk.dim.italic('     You pull your prompt out,'));
    console.log(chalk.dim.italic('     You share it all around,'));
    console.log(chalk.dim.italic('     That\'s what it\'s all about! ♫\n'));

    console.log(chalk.rgb(0, 232, 217).bold('          P2P AI MARKETPLACE'));
    console.log(chalk.gray('     Share AI tools, get AI help'));
    console.log(chalk.dim('     ( serious tech, silly soul )\n'));

    // Helpful tip for getting detailed help
    console.log(chalk.yellow('     💡 Tip: Use ') + chalk.bold.cyan('hokipoki <command> --help') + chalk.yellow(' for detailed options\n'));
    console.log(chalk.dim('     Examples:'));
    console.log(chalk.dim('       hokipoki request --help'));
    console.log(chalk.dim('       hokipoki listen --help\n'));
  }
}

// Show banner before parsing
showBanner();

program
  .name('hokipoki')
  .description(chalk.bold('Decentralized P2P marketplace for AI CLI tools') + '\n\n' +
    chalk.dim('  Share your idle AI subscriptions.\n') +
    chalk.dim('  Request help from any AI tool, pay per use.\n'))
  .version(version);

// Provider registration
program
  .command('register')
  .description(chalk.cyan('👤 Register as a provider') + '\n' +
    chalk.dim('   Authenticate your AI tools and register them with the backend') + '\n\n' +
    chalk.yellow('   What this does:') + '\n' +
    chalk.dim('   1. Opens browser for each tool to authenticate (if needed)') + '\n' +
    chalk.dim('   2. Stores encrypted tokens locally (~/.hokipoki/)') + '\n' +
    chalk.dim('   3. Registers your tools in the backend database') + '\n\n' +
    chalk.yellow('   Auth commands triggered:') + '\n' +
    chalk.dim('   • claude → runs "claude setup-token"') + '\n' +
    chalk.dim('   • codex  → runs "codex login"') + '\n' +
    chalk.dim('   • gemini → runs "gemini" (Google OAuth)'))
  .requiredOption('--as-provider', 'Register as a provider')
  .requiredOption('--tools <tools...>', 'AI tools to authenticate (e.g., claude codex)')
  .action(async (options) => {
    const secureProvider = new SecureProviderCLI();
    await secureProvider.register(options.tools);
  });

// Provider commands
program
  .command('listen')
  .description(chalk.magenta('🎧 Start listening for task requests') + '\n' +
    chalk.dim('   Run this to accept tasks from your idle AI tools') + '\n' +
    chalk.dim('   Tasks execute on the provider\'s configured AI CLI') + '\n\n' +
    chalk.yellow('   Token validation:') + '\n' +
    chalk.dim('   • Checks tokens for specified --tools only') + '\n' +
    chalk.dim('   • If expired/missing → auto-triggers auth (opens browser)') + '\n' +
    chalk.dim('   • Valid tokens → proceeds without interruption') + '\n\n' +
    chalk.yellow('   Example:') + '\n' +
    chalk.dim('   hokipoki listen --tools gemini') + '\n' +
    chalk.dim('   → Only checks gemini token, opens browser if expired'))
  .requiredOption('-t, --tools <tools...>', 'AI tools to offer this session (e.g., claude codex gemini)')
  .option('-p, --port <port>', 'P2P connection port (default: 9090)', '9090')
  .option('-s, --server <url>', 'Relay server (default: wss://relay.hoki-poki.ai)', 'wss://relay.hoki-poki.ai')
  .option('--secure', 'Use LUKS-encrypted Docker sandbox (production mode)')
  .action(async (options) => {
    if (options.secure) {
      console.log(chalk.yellow('Secure mode coming soon - use demo mode for now'));
    }

    const provider = new ProviderCommand(options);
    await provider.start();
  });

// Requester commands
program
  .command('request')
  .description(chalk.green('🚀 Request help from an AI tool') + '\n' +
    chalk.dim('   Submit a task to the network and get solutions from available providers') + '\n\n' +
    chalk.yellow('   Prerequisites for auto-apply:') + '\n' +
    chalk.dim('   • Directory must be a git repository (run: git init)') + '\n' +
    chalk.dim('   • Target files must be committed (git add + git commit)') + '\n' +
    chalk.dim('   • Without these, patches are saved but NOT auto-applied') + '\n\n' +
    chalk.yellow('   For AI CLIs (Claude Code, Codex, Gemini):') + '\n' +
    chalk.red('   ⚠️  DO NOT use --interactive (causes hang/timeout)') + '\n' +
    chalk.dim('   AI mode auto-detected (non-TTY = AI mode)') + '\n' +
    chalk.dim('   Patches auto-applied, results in parseable format') + '\n\n' +
    chalk.yellow('   Available tools:') + '\n' +
    chalk.dim('   --tool claude              # Anthropic Claude Code') + '\n' +
    chalk.dim('   --tool codex               # OpenAI Codex CLI') + '\n' +
    chalk.dim('   --tool gemini              # Google Gemini CLI') + '\n\n' +
    chalk.yellow('   Codex CLI sandbox configuration:') + '\n' +
    chalk.dim('   Codex sandbox blocks .git/ writes by default.') + '\n' +
    chalk.dim('   To enable auto-apply, add to ~/.codex/config.toml:') + '\n' +
    chalk.dim('     [sandbox_workspace_write]') + '\n' +
    chalk.dim('     writable_roots = [".git"]'))
  .option('--tool <tool>', 'AI tool to use (claude, codex, or gemini)')
  .requiredOption('--task <task>', 'Task description (what you need help with)')
  .option('--files <files...>', 'Specific files to include (e.g., src/main.ts)')
  .option('--dir <directories...>', 'Directories to include recursively')
  .option('--all', 'Include entire repository (respects .gitignore)')
  .option('--workspace <name>', 'Workspace to publish task to (default: personal workspace)')
  .option('-s, --server <url>', 'Relay server URL (default: wss://relay.hoki-poki.ai)', 'wss://relay.hoki-poki.ai')
  .option('--git-host <host>', 'Git server host/IP (auto-detected if not specified)')
  .option('--json', 'Output as JSON (for AI CLI parsing)')
  .option('--interactive', 'Force interactive prompts (HUMAN USE ONLY - breaks AI CLIs)')
  .option('--no-auto-apply', 'Don\'t auto-apply patches (just save them)')
  .action(async (options) => {
    const requester = new RequesterCommand(options);
    await requester.execute();
  });

// Authentication commands
program
  .command('login')
  .description(chalk.cyan('🔐 Authenticate with HokiPoki') + '\n' +
    chalk.dim('   Required before using any other command'))
  .action(async () => {
    try {
      const keycloak = new KeycloakManager();
      await keycloak.login();
    } catch (error: any) {
      // Check if error is about email verification
      if (error.message?.includes('not verified')) {
        // Error already printed in keycloak-manager
        process.exit(1);
      }

      console.error(chalk.red('\n❌ Login failed:'), error.message);
      console.log(chalk.yellow('\n💡 Don\'t have an account?'));
      console.log(chalk.cyan('   Create one at: https://app.hoki-poki.ai/register\n'));
      process.exit(1);
    }
  });

program
  .command('logout')
  .description(chalk.cyan('🚪 Logout from HokiPoki') + '\n' +
    chalk.dim('   Remove local authentication token'))
  .action(async () => {
    try {
      const keycloak = new KeycloakManager();
      await keycloak.logout();
    } catch (error: any) {
      console.error(chalk.red('Logout failed:'), error.message);
      process.exit(1);
    }
  });

program
  .command('whoami')
  .description(chalk.cyan('👤 Show current user information') + '\n' +
    chalk.dim('   Display logged-in user email and token status'))
  .action(async () => {
    try {
      const keycloak = new KeycloakManager();
      if (!await keycloak.isAuthenticated()) {
        console.log(chalk.yellow('\n❌ Not authenticated'));
        console.log(chalk.gray('Please run: hokipoki login\n'));
        process.exit(1);
      }

      const token = await keycloak.getToken();
      const response = await fetch('https://api.hoki-poki.ai/api/profile', {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (!response.ok) {
        throw new Error('Failed to fetch profile');
      }

      const profile: any = await response.json();
      const memberSince = new Date(profile.createdAt).toLocaleDateString();

      console.log(chalk.green('\n✅ Authenticated'));
      console.log(chalk.cyan(`📧 Email: ${profile.email}`));
      if (profile.workspace) {
        console.log(chalk.magenta(`🏢 Workspace: ${profile.workspace.name}`));
      }
      console.log(chalk.gray(`📅 Member since: ${memberSince}\n`));
    } catch (error: any) {
      console.error(chalk.red('Error:'), error.message);
      process.exit(1);
    }
  });

// Dashboard command
program
  .command('dashboard')
  .description(chalk.yellow('📊 Open the web dashboard') + '\n' +
    chalk.dim('   View your stats and task history'))
  .action(() => {
    const dashboardUrl = 'https://app.hoki-poki.ai/dashboard';
    console.log(chalk.cyan(`\n🌐 Opening dashboard at ${dashboardUrl}\n`));

    const { exec } = require('child_process');
    const command = process.platform === 'darwin' ? 'open' :
                   process.platform === 'win32' ? 'start' : 'xdg-open';

    exec(`${command} ${dashboardUrl}`, (error: Error | null) => {
      if (error) {
        console.error(chalk.red('Failed to open browser. Please navigate to:'), dashboardUrl);
      }
    });
  });

// Status command
program
  .command('status')
  .description(chalk.blue('📊 Check account status') + '\n' +
    chalk.dim('   See your completed tasks and reputation'))
  .option('--provider', 'Show provider-specific stats')
  .action(async (options) => {
    if (options.provider) {
      const secureProvider = new SecureProviderCLI();
      await secureProvider.status();
    } else {
      try {
        const keycloak = new KeycloakManager();
        if (!await keycloak.isAuthenticated()) {
          console.log(chalk.yellow('\n❌ Not authenticated'));
          console.log(chalk.gray('Please run: hokipoki login\n'));
          process.exit(1);
        }

        const token = await keycloak.getToken();
        const response = await fetch('https://api.hoki-poki.ai/api/profile', {
          headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!response.ok) {
          throw new Error('Failed to fetch profile');
        }

        const profile: any = await response.json();
        const requestedCount = profile.pagination?.requestedTasks?.total || 0;
        const providedCount = profile.pagination?.providedTasks?.total || 0;

        console.log(chalk.cyan('\n📊 Account Status\n'));
        console.log(chalk.white(`  📧 Email: ${chalk.bold(profile.email)}`));
        if (profile.workspace) {
          console.log(chalk.white(`  🏢 Workspace: ${chalk.bold(profile.workspace.name)}`));
        }
        console.log('');
        console.log(chalk.green(`  📤 Tasks Requested: ${chalk.bold(requestedCount)}`));
        console.log(chalk.magenta(`  📥 Tasks Provided: ${chalk.bold(providedCount)}`));
        console.log('');
      } catch (error: any) {
        console.error(chalk.red('Error:'), error.message);
        process.exit(1);
      }
    }
  });

// Shell completion
program
  .command('completion')
  .description(chalk.cyan('⌨️  Setup shell tab completion') + '\n' +
    chalk.dim('   Enable autocomplete for commands, options, and tool names'))
  .option('--install', 'Install completion for your shell (bash/zsh/fish)')
  .option('--uninstall', 'Remove completion from your shell')
  .action(async (options) => {
    if (options.install) {
      await installCompletion();
    } else if (options.uninstall) {
      await uninstallCompletion();
    } else {
      console.log(chalk.yellow('\nUsage:'));
      console.log(chalk.dim('  hokipoki completion --install    # Setup completion'));
      console.log(chalk.dim('  hokipoki completion --uninstall  # Remove completion\n'));
    }
  });

// Parse arguments
program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}