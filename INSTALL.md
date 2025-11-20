# HokiPoki CLI Installation Guide

## Prerequisites

You need a GitHub Personal Access Token with `read:packages` permission to install this package.

## Installation Steps

### Step 1: Configure npm to use GitHub Packages

Create or edit your global `.npmrc` file in your home directory:

```bash
# Open or create ~/.npmrc
nano ~/.npmrc
```

Add these lines:

```
@actserbia:registry=https://npm.pkg.github.com/
//npm.pkg.github.com/:_authToken=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
```

Save and exit (Ctrl+X, then Y, then Enter).

### Step 2: Install the package globally

```bash
npm install -g @actserbia/hokipoki-cli@1.0.0
```

### Step 3: Verify installation

```bash
hokipoki --version
hokipoki --help
```

## Alternative: Project-specific installation

If you want to install in a specific project instead of globally:

1. Navigate to your project directory
2. Create a `.npmrc` file in the project root with the same content as above
3. Run:
   ```bash
   npm install @actserbia/hokipoki-cli@1.0.0
   ```

## Usage

After installation, you can use the CLI:

```bash
hokipoki login          # Login to HokiPoki (uses production auth by default)
hokipoki request        # Request an AI tool
hokipoki provide        # Provide your tools to the marketplace
hokipoki logout         # Logout
```

### Production vs Local Development

By default, the CLI authenticates against the **production** Keycloak server (`https://auth.hoki-poki.ai`).

If you're developing locally and need to test against a local Keycloak instance, set the environment variable:

```bash
export HOKIPOKI_KEYCLOAK_ISSUER=http://localhost:9090/realms/hokipoki
hokipoki login
```

Or for a single command:

```bash
HOKIPOKI_KEYCLOAK_ISSUER=http://localhost:9090/realms/hokipoki hokipoki login
```

## Troubleshooting

### Error: "Unable to authenticate"
- Make sure your `.npmrc` file has the correct GitHub token
- Verify the token has `read:packages` permission

### Error: "Package not found"
- Ensure you're using the scoped package name: `@actserbia/hokipoki-cli`
- Check that you have access to the GitHub repository

### Error: "Permission denied"
- The package is private and requires authentication
- Make sure your GitHub token is valid and has the necessary permissions
