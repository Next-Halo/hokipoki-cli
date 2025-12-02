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
    console.log(chalk.gray('     Rent AI tools, earn credits'));
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
    chalk.dim('  Share your idle AI subscriptions, earn credits.\n') +
    chalk.dim('  Request help from any AI tool, pay per use.\n'))
  .version(version);

// Provider registration
program
  .command('register')
  .description(chalk.cyan('👤 Register as a provider') + '\n' +
    chalk.dim('   Authenticate your AI tools (Claude, Codex, Gemini) to start earning'))
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
    chalk.dim('   Run this to accept tasks and earn credits from your idle AI tools') + '\n' +
    chalk.dim('   Tasks will specify which model to use (e.g., claude:model-name)'))
  .option('-t, --tools <tools...>', 'AI tools available (e.g., claude codex gemini)')
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
    chalk.yellow('   Model selection syntax:') + '\n' +
    chalk.dim('   --tool <tool>:<model>      # Specify tool and model') + '\n' +
    chalk.dim('   --tool <tool>              # Use default model') + '\n\n' +
    chalk.yellow('   Examples:') + '\n' +
    chalk.dim('   --tool claude:sonnet-4') + '\n' +
    chalk.dim('   --tool gemini:gemini-2.5-flash') + '\n' +
    chalk.dim('   --tool codex:gpt-5-codex-high') + '\n' +
    chalk.dim('   --tool claude              # default model') + '\n\n' +
    chalk.yellow('   Discover available models:') + '\n' +
    chalk.dim('   claude /model              # List Claude models') + '\n' +
    chalk.dim('   gemini --list-models       # List Gemini models') + '\n' +
    chalk.dim('   codex /model               # List Codex models'))
  .option('--tool <tool>', 'AI tool with optional model (e.g., claude:sonnet-4, gemini:gemini-2.5-flash)')
  .requiredOption('--task <task>', 'Task description (what you need help with)')
  .option('--files <files...>', 'Specific files to include (e.g., src/main.ts)')
  .option('--dir <directories...>', 'Directories to include recursively')
  .option('--all', 'Include entire repository (respects .gitignore)')
  .option('--workspace <name>', 'Workspace to publish task to (default: personal workspace)')
  .option('-s, --server <url>', 'Relay server URL (default: wss://relay.hoki-poki.ai)', 'wss://relay.hoki-poki.ai')
  .option('--git-host <host>', 'Git server host/IP (auto-detected if not specified)')
  .option('--json', 'Output as JSON (for programmatic use)')
  .option('--interactive', 'Force interactive prompts (even in AI CLI mode)')
  .option('--no-auto-apply', 'Don\'t auto-apply patches (just save them)')
  .action(async (options) => {
    const requester = new RequesterCommand(options);
    await requester.execute();
  });

// Authentication commands
program
  .command('login')
  .description(chalk.cyan('🔐 Authenticate with Keycloak') + '\n' +
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
  .description(chalk.cyan('🚪 Logout from Keycloak') + '\n' +
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
        console.log(chalk.yellow('❌ Not authenticated'));
        console.log(chalk.gray('Please run: hokipoki login\n'));
        process.exit(1);
      }

      const email = await keycloak.getUserEmail();
      console.log(chalk.green('\n✅ Authenticated'));
      console.log(chalk.cyan(`📧 Email: ${email}\n`));
    } catch (error: any) {
      console.error(chalk.red('Error:'), error.message);
      process.exit(1);
    }
  });

// Dashboard command
program
  .command('dashboard')
  .description(chalk.yellow('📊 Open the web dashboard') + '\n' +
    chalk.dim('   View your stats, credits, and transaction history'))
  .action(() => {
    const dashboardUrl = 'http://localhost:3000';
    console.log(chalk.cyan(`Opening dashboard at ${dashboardUrl}`));

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
  .description(chalk.blue('💳 Check account status and credits') + '\n' +
    chalk.dim('   See your balance, completed tasks, and reputation'))
  .option('--provider', 'Show provider-specific stats')
  .action(async (options) => {
    if (options.provider) {
      const secureProvider = new SecureProviderCLI();
      await secureProvider.status();
    } else {
      console.log(chalk.cyan('\n📊 Account Status:'));
      console.log(chalk.green('  Credits: ') + chalk.bold('150'));
      console.log(chalk.magenta('  Tasks completed: ') + chalk.bold('23'));
      console.log(chalk.blue('  Tasks requested: ') + chalk.bold('15') + '\n');
    }
  });

// Parse arguments
program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}