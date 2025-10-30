# HokiPoki CLI

The command-line interface for the HokiPoki P2P AI marketplace. This CLI allows developers to request AI assistance from various providers and to provide their own AI tools to the network.

## Installation

```bash
npm install -g hokipoki-cli
```

## Usage

### As a Requester

Request help from specific AI tools:

```bash
hokipoki request --tool claude --task "Refactor this function for better performance"
```

### As a Provider

Share your AI subscriptions and earn credits:

```bash
# Register your tools
hokipoki register --as-provider --tools claude gemini codex

# Start listening for requests
hokipoki listen --tools claude gemini
```

### Check Status

```bash
hokipoki status
```

## Docker Support

The CLI includes support for secure containerized execution of tasks:

```bash
# Build the secure executor image
npm run build-docker
```

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build
```

## Architecture

The CLI consists of:
- **CLI Interface** (`cli/`): Command parsing and user interaction
- **Authentication** (`auth/`): OAuth and Keycloak authentication managers
- **Container** (`container/`): Secure Docker-based task execution
- **Docker** (`docker/`): Container configurations for secure execution

## Security

All task execution happens in isolated Docker containers with:
- Read-only filesystem
- Memory-only workspace (tmpfs)
- No shell access
- Automatic cleanup after task completion

## License

MIT