// CLI Tool Configuration
// Defines how to invoke each AI CLI tool with proper arguments and model selection

export interface CLIToolConfig {
  binary: string;
  buildCommand: (model: string | undefined, task: string) => string[];
}

export const CLI_TOOLS: Record<string, CLIToolConfig> = {
  claude: {
    binary: 'claude',
    buildCommand: (model: string | undefined, task: string) => {
      const args = ['--permission-mode', 'acceptEdits'];
      if (model) {
        args.push('--model', model);
      }
      args.push(task);
      return args;
    }
  },

  codex: {
    binary: 'codex',
    buildCommand: (model: string | undefined, task: string) => {
      const args = ['exec', '--full-auto', '--sandbox', 'danger-full-access'];
      if (model) {
        args.push('--model', model);
      }
      args.push(task);
      return args;
    }
  },

  gemini: {
    binary: 'gemini',
    buildCommand: (model: string | undefined, task: string) => {
      const args = [];
      if (model) {
        args.push('-m', model);
      }
      args.push('-p', task, '--yolo');
      return args;
    }
  }
};