# HokiPoki CLI

> Switch models, not tabs. When your AI gets stuck, hop to another.

A P2P marketplace for AI CLI tools. Request help from any AI model, or share your idle subscriptions to earn credits.

## Prerequisites

- **Node.js** 18+
- **Docker** (required for secure task execution)
- **Git**
- **HokiPoki account** - Sign up at [hoki-poki.ai](https://hoki-poki.ai)

## Installation

```bash
npm install -g @next-halo/hokipoki-cli
```

## Quick Start

```bash
# 1. Login to your account
hokipoki login

# 2. Request help from an AI tool (pick one approach):

# Option A: Include specific files
hokipoki request --tool claude --task "Fix the bug in auth logic" --files src/auth.ts src/utils.ts

# Option B: Include entire directories
hokipoki request --tool codex --task "Add error handling" --dir src/services/

# Option C: Include your whole project (respects .gitignore)
hokipoki request --tool gemini --task "Review code for security issues" --all

# 3. That's it! The result will be applied automatically as a patch
```

## Commands

### Authentication

```bash
hokipoki login      # Authenticate with your account
hokipoki logout     # Remove local authentication
hokipoki whoami     # Show current user info
```

### Request Help (Requester)

```bash
hokipoki request --tool <tool> --task "<description>" [options]
```

**Options:**
| Option | Description |
|--------|-------------|
| `--tool <tool>` | AI tool to use (claude, codex, gemini) |
| `--task <task>` | Task description |
| `--files <files...>` | Specific files to include |
| `--dir <directories...>` | Directories to include recursively |
| `--all` | Include entire repository (respects .gitignore) |
| `--no-auto-apply` | Don't auto-apply patches, just save them |
| `--json` | Output as JSON for programmatic use |

**Examples:**

```bash
# Fix a bug in specific files
hokipoki request --tool claude --task "Fix the memory leak" --files src/cache.ts

# Refactor an entire directory
hokipoki request --tool codex --task "Add TypeScript types" --dir src/

# Get help with the whole project
hokipoki request --tool gemini --task "Review for security issues" --all
```

### Provide Your Tools (Provider)

Share your AI subscriptions and earn credits:

```bash
# Register as a provider
hokipoki register --as-provider --tools claude codex gemini

# Start listening for requests
hokipoki listen --tools claude codex
```

### Account & Status

```bash
hokipoki status      # Check credits and account info
hokipoki dashboard   # Open web dashboard
```

## Supported AI Tools

- **Claude Code CLI** (Anthropic)
- **Codex CLI** (OpenAI)
- **Gemini CLI** (Google)

## How It Works

1. **Request**: You submit a task with context (files/directories)
2. **Match**: HokiPoki finds an available provider with the requested tool
3. **Execute**: The task runs securely on the provider's machine
4. **Return**: Results (patches, responses) are sent back to you
5. **Apply**: Patches are automatically applied to your codebase

## Security

All task execution happens in isolated Docker containers with:
- Read-only filesystem
- Memory-only workspace (tmpfs)
- No shell access
- Automatic cleanup after completion

Your API keys never leave your machine. Providers only share compute, not credentials.

## Help

```bash
hokipoki --help              # General help
hokipoki <command> --help    # Command-specific help
```

## Links

- Website: [hoki-poki.ai](https://hoki-poki.ai)
- Support: office@next-halo.com

## License

MIT
