// Tab completion for HokiPoki CLI
// Uses tabtab package (same approach as npm)

import tabtab from 'tabtab';

const COMMANDS = ['register', 'listen', 'request', 'login', 'logout', 'whoami', 'dashboard', 'status', 'completion', 'help'];
const TOOLS = ['claude', 'codex', 'gemini'];

// Model selection disabled for now - will be added later
// const MODELS: Record<string, string[]> = {
//   claude: ['sonnet', 'opus'],
//   gemini: ['flash', 'pro', 'flash-lite'],
//   codex: ['gpt-5.1-codex-max', 'gpt-5.1-codex', 'gpt-5.1-codex-mini', 'gpt-5.1']
// };

const OPTIONS: Record<string, string[]> = {
  register: ['--as-provider', '--tools', '--help'],
  listen: ['--tools', '-t', '--port', '-p', '--server', '-s', '--secure', '--help'],
  request: ['--tool', '--task', '--files', '--dir', '--all', '--workspace', '--server', '-s', '--git-host', '--json', '--interactive', '--no-auto-apply', '--help'],
  login: ['--help'],
  logout: ['--help'],
  whoami: ['--help'],
  dashboard: ['--help'],
  status: ['--provider', '--help'],
  completion: ['--install', '--uninstall', '--help'],
  help: []
};

export function handleCompletion(): void {
  const env = tabtab.parseEnv(process.env);
  if (!env.complete) return;

  const { prev } = env;

  // Complete commands
  if (prev === 'hokipoki') {
    tabtab.log(COMMANDS);
    return;
  }

  // Complete options for commands
  if (COMMANDS.includes(prev)) {
    tabtab.log(OPTIONS[prev] || ['--help']);
    return;
  }

  // Complete tool names
  if (prev === '--tool' || prev === '--tools' || prev === '-t') {
    tabtab.log(TOOLS);
    return;
  }

  // Default: show commands
  tabtab.log(COMMANDS);
}

export async function installCompletion(): Promise<void> {
  await tabtab.install({
    name: 'hokipoki',
    completer: 'hokipoki'
  });
  console.log('✅ Completion installed! Restart your shell or run: source ~/.bashrc (or ~/.zshrc)');
}

export async function uninstallCompletion(): Promise<void> {
  await tabtab.uninstall({ name: 'hokipoki' });
  console.log('✅ Completion removed!');
}
