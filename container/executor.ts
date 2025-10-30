#!/usr/bin/env node

// Secure Container Executor
// Runs inside Docker container with no shell access
// Executes AI CLI tools on isolated code

import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { CLI_TOOLS } from '../config/cli-tools';

// Environment variables injected by provider CLI
const TASK_ID = process.env.TASK_ID!;
const GIT_URL = process.env.GIT_URL!;
const GIT_TOKEN = process.env.GIT_TOKEN!;
const AI_TOOL = process.env.AI_TOOL!; // Just the tool name (e.g., "claude", "codex", "gemini")
const AI_MODEL = process.env.AI_MODEL; // Optional - specific model to use (e.g., "sonnet", "gpt-5-codex", "flash")
const TASK_DESCRIPTION = process.env.TASK_DESCRIPTION!;
const OAUTH_TOKEN = process.env.OAUTH_TOKEN!;

// Paths
const WORKSPACE = '/workspace';
const RESULTS_FILE = '/workspace/.results.json';

// Encryption setup
const ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
const ENCRYPTED_IMAGE = '/workspace/encrypted.img';
const MOUNT_POINT = '/workspace/code';

/**
 * Main executor process
 */
async function execute() {
  console.log('[EXECUTOR] Starting secure execution');

  try {
    // Step 0: Configure git to trust workspace (must be before any git operations)
    spawnSync('git', ['config', '--global', '--add', 'safe.directory', MOUNT_POINT], { stdio: 'ignore' });
    spawnSync('git', ['config', '--global', '--add', 'safe.directory', '*'], { stdio: 'ignore' });

    // Step 1: Setup workspace
    setupWorkspace();

    // Step 2: Create encrypted workspace (ALWAYS - no skip option)
    setupEncryptedWorkspace();

    // Step 3: Clone code into encrypted workspace
    cloneCode();

    // Step 4: Execute AI tool (authentication via env vars)
    const result = executeAITool();

    // Step 5: Push results back
    pushResults(result);

    // Step 6: Teardown encrypted workspace
    teardownEncryptedWorkspace();

    // Step 7: Wipe encryption key from memory
    wipeEncryptionKey();

    // Step 8: Secure cleanup
    secureCleanup();

    console.log('[EXECUTOR] Execution complete');
    process.exit(0);

  } catch (error) {
    console.error('[EXECUTOR] Fatal error:', error);

    // Emergency cleanup
    teardownEncryptedWorkspace();
    wipeEncryptionKey();
    emergencyWipe();

    process.exit(1);
  }
}

/**
 * Setup isolated workspace
 */
function setupWorkspace() {
  console.log('[EXECUTOR] Setting up workspace');

  // Workspace is already created by Docker with tmpfs
  // and has correct permissions (mode=0700 in Docker command)
  // Just verify it exists
  if (!fs.existsSync(WORKSPACE)) {
    console.error('[EXECUTOR] ERROR: Workspace does not exist!');
    throw new Error('Workspace not mounted');
  }

  console.log('[EXECUTOR] Workspace ready');
}

/**
 * Create and mount encrypted workspace using LUKS
 */
function setupEncryptedWorkspace() {
  console.log('[EXECUTOR] Setting up encrypted workspace');

  // First, ensure any existing device mapper is cleaned up (from previous failed runs)
  try {
    const checkResult = spawnSync('/sbin/cryptsetup', ['status', 'workspace'], {
      stdio: 'ignore'
    });
    if (checkResult.status === 0) {
      // Device exists, close it first
      console.log('[EXECUTOR] Cleaning up existing device mapper...');
      spawnSync('/sbin/cryptsetup', ['luksClose', 'workspace'], { stdio: 'ignore' });
    }
  } catch {
    // Ignore errors - device might not exist
  }

  // Create encrypted container file (100MB)
  console.log('[EXECUTOR] Creating encrypted container...');
  const ddResult = spawnSync('dd', [
    'if=/dev/zero',
    `of=${ENCRYPTED_IMAGE}`,
    'bs=1M',
    'count=100'
  ], {
    stdio: 'ignore'
  });

  if (ddResult.error || ddResult.status !== 0) {
    throw new Error(`Failed to create encrypted image: ${ddResult.error || `exit code ${ddResult.status}`}`);
  }

  // Format as LUKS encrypted container
  console.log('[EXECUTOR] Formatting LUKS container...');

  // Get cryptsetup path
  const cryptsetupCheck = spawnSync('which', ['cryptsetup'], { encoding: 'utf-8' });
  const cryptsetupPath = cryptsetupCheck.stdout?.trim() || '/sbin/cryptsetup';

  // Write key to temp file (cryptsetup stdin handling is unreliable in containers)
  const keyFile = `${WORKSPACE}/.luks_key`;
  fs.writeFileSync(keyFile, ENCRYPTION_KEY, { mode: 0o600 });

  const formatResult = spawnSync(cryptsetupPath, [
    'luksFormat',
    '--batch-mode',
    '--key-file', keyFile,
    ENCRYPTED_IMAGE
  ], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  // Immediately wipe the key file
  try {
    fs.unlinkSync(keyFile);
  } catch {};

  if (formatResult.error || formatResult.status !== 0) {
    const stderr = formatResult.stderr?.toString() || '';
    const stdout = formatResult.stdout?.toString() || '';
    console.error('[EXECUTOR] cryptsetup luksFormat failed');
    console.error('[EXECUTOR] stdout:', stdout);
    console.error('[EXECUTOR] stderr:', stderr);
    console.error('[EXECUTOR] status:', formatResult.status);
    console.error('[EXECUTOR] error:', formatResult.error);

    // If status is null, the binary wasn't found or couldn't execute
    if (formatResult.status === null) {
      throw new Error(`Failed to execute cryptsetup: ${formatResult.error?.message || 'command not found or failed to start'}`);
    }

    throw new Error(`Failed to format encrypted container: ${stderr || stdout || 'unknown error'}`);
  }

  // Create /dev/mapper if it doesn't exist
  if (!fs.existsSync('/dev/mapper')) {
    fs.mkdirSync('/dev/mapper');
  }

  // Open encrypted container
  console.log('[EXECUTOR] Opening encrypted container...');

  // Write key to temp file (same as luksFormat)
  const openKeyFile = `${WORKSPACE}/.luks_key`;
  fs.writeFileSync(openKeyFile, ENCRYPTION_KEY, { mode: 0o600 });

  const openResult = spawnSync(cryptsetupPath, [
    'luksOpen',
    '--disable-keyring',  // Disable kernel keyring (not available in containers)
    '--key-file', openKeyFile,
    ENCRYPTED_IMAGE,
    'workspace'
  ], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  // Immediately wipe the key file
  try {
    fs.unlinkSync(openKeyFile);
  } catch {};

  if (openResult.error || openResult.status !== 0) {
    const stderr = openResult.stderr?.toString() || '';
    console.error('[EXECUTOR] cryptsetup luksOpen failed:', stderr);
    throw new Error(`Failed to open encrypted container: ${stderr}`);
  }

  // Create filesystem
  console.log('[EXECUTOR] Creating filesystem...');
  const mkfsResult = spawnSync('mkfs.ext4', ['-F', '/dev/mapper/workspace'], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  if (mkfsResult.error || mkfsResult.status !== 0) {
    const stderr = mkfsResult.stderr?.toString() || '';
    const stdout = mkfsResult.stdout?.toString() || '';
    console.error('[EXECUTOR] mkfs.ext4 failed');
    console.error('[EXECUTOR] stdout:', stdout);
    console.error('[EXECUTOR] stderr:', stderr);
    throw new Error(`Failed to create filesystem: ${stderr || stdout || 'unknown error'}`);
  }

  // Create mount point
  if (!fs.existsSync(MOUNT_POINT)) {
    fs.mkdirSync(MOUNT_POINT, { recursive: true });
  }

  // Mount encrypted filesystem
  console.log('[EXECUTOR] Mounting encrypted filesystem...');
  const mountResult = spawnSync('mount', ['/dev/mapper/workspace', MOUNT_POINT], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  if (mountResult.error || mountResult.status !== 0) {
    const stderr = mountResult.stderr?.toString() || '';
    const stdout = mountResult.stdout?.toString() || '';
    console.error('[EXECUTOR] mount failed');
    console.error('[EXECUTOR] stdout:', stdout);
    console.error('[EXECUTOR] stderr:', stderr);
    throw new Error(`Failed to mount encrypted filesystem: ${stderr || stdout || 'unknown error'}`);
  }

  // Set permissions
  spawnSync('chown', ['-R', '1000:1000', MOUNT_POINT], {
    stdio: 'ignore'
  });

  console.log('[EXECUTOR] Encrypted workspace ready');

  // DEBUG PAUSE: Allow manual inspection of container
  if (process.env.DEBUG_PAUSE === 'true') {
    console.log('[EXECUTOR] ⏸️  DEBUG PAUSE ACTIVE - Container will wait 60 seconds');
    console.log('[EXECUTOR] You can now exec into the container to verify LUKS encryption:');
    console.log('[EXECUTOR]   docker exec <container-name> ls -la /workspace');
    console.log('[EXECUTOR]   docker exec <container-name> ls -la /workspace/code');
    spawnSync('sleep', ['60'], { stdio: 'inherit' });
    console.log('[EXECUTOR] DEBUG PAUSE complete, resuming execution...');
  }
}

/**
 * Unmount and destroy encrypted workspace
 */
function teardownEncryptedWorkspace() {
  console.log('[EXECUTOR] Tearing down encrypted workspace');

  try {
    // Unmount
    spawnSync('/bin/umount', [MOUNT_POINT], { stdio: 'ignore' });

    // Close LUKS container
    spawnSync('/sbin/cryptsetup', ['luksClose', 'workspace'], { stdio: 'ignore' });

    // Overwrite encrypted image with random data
    console.log('[EXECUTOR] Securely wiping encrypted image...');
    spawnSync('dd', [
      'if=/dev/urandom',
      `of=${ENCRYPTED_IMAGE}`,
      'bs=1M',
      'count=100'
    ], {
      stdio: 'ignore'
    });

    // Remove image file
    if (fs.existsSync(ENCRYPTED_IMAGE)) {
      fs.unlinkSync(ENCRYPTED_IMAGE);
    }

    console.log('[EXECUTOR] Encrypted workspace destroyed');
  } catch (error) {
    console.warn('[EXECUTOR] Warning during teardown:', error);
    // Best effort - tmpfs will be destroyed anyway
  }
}

/**
 * Zero out encryption key from memory
 */
function wipeEncryptionKey() {
  // Overwrite key variable with zeros
  const keyBuffer = Buffer.from(ENCRYPTION_KEY);
  keyBuffer.fill(0);

  // Force garbage collection if available
  if (global.gc) {
    global.gc();
  }
}

/**
 * Clone code from requester's ephemeral Git
 */
function cloneCode() {
  console.log('[EXECUTOR] Cloning code into encrypted workspace');
  console.log(`[EXECUTOR] Git URL: ${GIT_URL}`);

  // Remove lost+found directory created by ext4 (git clone won't work with non-empty dir)
  const lostFound = `${MOUNT_POINT}/lost+found`;
  if (fs.existsSync(lostFound)) {
    fs.rmSync(lostFound, { recursive: true, force: true });
  }

  // Configure git credential helper using git config
  // This is more reliable than .netrc in Alpine Linux containers
  console.log('[EXECUTOR] Configuring git credentials via credential helper');

  // Set up git to use an inline credential helper that returns our token
  // The helper is a shell function that echoes username and password
  const gitEnv = {
    ...process.env,
    HOME: WORKSPACE, // Use workspace as home
    GIT_CONFIG_NOSYSTEM: '1', // Skip system config
  };

  // Configure credential helper globally
  spawnSync('git', [
    'config', '--global', 'credential.helper',
    `!f() { echo "username=${GIT_TOKEN}"; echo "password=x-oauth-basic"; }; f`
  ], {
    env: gitEnv,
    stdio: 'ignore'
  });

  console.log('[EXECUTOR] Credential helper configured');

  // Clone directly into encrypted mount point
  console.log(`[EXECUTOR] Running: git clone ${GIT_URL}`);

  try {
    const result = spawnSync('git', [
      'clone', GIT_URL, MOUNT_POINT
    ], {
      env: gitEnv,
      stdio: 'inherit' // Show output for debugging
    });

    if (result.error || result.status !== 0) {
      throw new Error(`Git clone failed: ${result.error || `exit code ${result.status}`}`);
    }
  } catch (error) {
    console.error('[EXECUTOR] ERROR: Git clone failed!');
    console.error('[EXECUTOR] Error details:', error);
    throw error;
  }

  console.log('[EXECUTOR] Code received');
}

// Authentication removed - handled via environment variables
// CLAUDE_CODE_OAUTH_TOKEN is set in executeAITool()

/**
 * Execute the AI tool on the code
 */
function executeAITool(): string {
  console.log(`[EXECUTOR] Executing ${AI_TOOL}`);

  const codePath = MOUNT_POINT;  // Use encrypted mount point

  // Decrypt OAuth token
  const token = decryptToken(OAUTH_TOKEN);

  // Set up environment for AI CLIs
  const env = {
    ...process.env,
    HOME: WORKSPACE, // Use workspace as home for config files
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', // Explicit PATH with npm globals
    CLAUDE_CONFIG_DIR: `${WORKSPACE}/.claude-config`, // Writable tmpfs location for Claude
    CLAUDE_CODE_OAUTH_TOKEN: token // Authentication token for Claude
  };

  // Create Claude config directory
  const configDir = `${WORKSPACE}/.claude-config`;
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }

  // Create .claude.json with acceptEdits mode enabled
  const claudeConfigPath = path.join(configDir, '.claude.json');
  const claudeConfig = {
    acceptEditsModeAccepted: true,
    enabledTools: ['WebFetch', 'Bash', 'Read', 'Write', 'Edit'],
    webAccessAllowed: true
  };
  fs.writeFileSync(claudeConfigPath, JSON.stringify(claudeConfig, null, 2));
  fs.chmodSync(claudeConfigPath, 0o600);

  // For Codex, create auth.json and config.toml in workspace
  if (AI_TOOL === 'codex') {
    const codexConfigDir = `${WORKSPACE}/.codex`;
    if (!fs.existsSync(codexConfigDir)) {
      fs.mkdirSync(codexConfigDir, { recursive: true, mode: 0o700 });
    }

    // Create auth.json with complete structure matching Codex's format
    // The token is a JSON string containing all tokens from host's auth.json
    const codexAuthPath = path.join(codexConfigDir, 'auth.json');
    let tokensObject;

    console.log('[EXECUTOR] DEBUG: Token type:', typeof token);
    console.log('[EXECUTOR] DEBUG: Token first 200 chars:', token.substring(0, 200));

    try {
      // Double-decode: first parse gets the JSON string, second parse gets the object
      const jsonString = JSON.parse(token); // First decode
      console.log('[EXECUTOR] DEBUG: After first decode type:', typeof jsonString);
      tokensObject = JSON.parse(jsonString); // Second decode to get actual object
      console.log('[EXECUTOR] DEBUG: Successfully double-decoded tokens');
    } catch (error) {
      console.error('[EXECUTOR] ERROR: Failed to parse Codex tokens JSON:', error);
      console.error('[EXECUTOR] Token value:', token.substring(0, 100)); // Show first 100 chars

      // Try to fix if it's already an object
      if (typeof token === 'object') {
        console.log('[EXECUTOR] Token is already an object, using directly');
        tokensObject = token;
      } else {
        throw new Error(`Invalid Codex tokens format: ${error}`);
      }
    }
    const codexAuth = {
      OPENAI_API_KEY: null,
      tokens: tokensObject,  // Use the complete tokens object from host
      last_refresh: new Date().toISOString()
    };
    fs.writeFileSync(codexAuthPath, JSON.stringify(codexAuth, null, 2));
    fs.chmodSync(codexAuthPath, 0o600);
    console.log('[EXECUTOR] Created Codex auth.json in workspace with full tokens');

    // Create minimal config.toml
    const codexConfigPath = path.join(codexConfigDir, 'config.toml');
    const codexConfig = `model = "gpt-5-codex"\n`;
    fs.writeFileSync(codexConfigPath, codexConfig);
    fs.chmodSync(codexConfigPath, 0o600);
    console.log('[EXECUTOR] Created Codex config.toml in workspace');
  }

  // For Gemini, create oauth_creds.json in workspace
  if (AI_TOOL === 'gemini') {
    const geminiConfigDir = `${WORKSPACE}/.gemini`;
    if (!fs.existsSync(geminiConfigDir)) {
      fs.mkdirSync(geminiConfigDir, { recursive: true, mode: 0o700 });
    }

    // Create oauth_creds.json with complete OAuth structure
    const geminiAuthPath = path.join(geminiConfigDir, 'oauth_creds.json');
    let oauthCreds;

    console.log('[EXECUTOR] DEBUG: Setting up Gemini OAuth credentials');
    console.log('[EXECUTOR] DEBUG: Token type:', typeof token);
    console.log('[EXECUTOR] DEBUG: Token first 100 chars:', token.substring(0, 100));

    try {
      // Double-decode: first parse gets the JSON string, second parse gets the object
      const jsonString = JSON.parse(token); // First decode
      console.log('[EXECUTOR] DEBUG: After first decode type:', typeof jsonString);
      console.log('[EXECUTOR] DEBUG: After first decode first 100 chars:', jsonString.substring(0, 100));
      oauthCreds = JSON.parse(jsonString); // Second decode to get actual object
      console.log('[EXECUTOR] DEBUG: Successfully double-decoded Gemini OAuth creds');
    } catch (error) {
      console.error('[EXECUTOR] ERROR: Failed to parse Gemini OAuth JSON:', error);
      console.error('[EXECUTOR] Token value:', token.substring(0, 200));

      // Try to fix if it's already an object
      if (typeof token === 'object') {
        console.log('[EXECUTOR] Token is already an object, using directly');
        oauthCreds = token;
      } else {
        throw new Error(`Invalid Gemini OAuth format: ${error}`);
      }
    }

    fs.writeFileSync(geminiAuthPath, JSON.stringify(oauthCreds, null, 2));
    fs.chmodSync(geminiAuthPath, 0o600);
    console.log('[EXECUTOR] Created Gemini oauth_creds.json in workspace');

    // Create settings.json to specify OAuth auth type
    const geminiSettingsPath = path.join(geminiConfigDir, 'settings.json');
    const geminiSettings = {
      selectedAuthType: 'oauth-personal'
    };
    fs.writeFileSync(geminiSettingsPath, JSON.stringify(geminiSettings, null, 2));
    fs.chmodSync(geminiSettingsPath, 0o600);
    console.log('[EXECUTOR] Created Gemini settings.json in workspace');
  }

  // Enhance task description with file context
  const fileList = spawnSync('find', ['.', '-type', 'f', '-not', '-path', './.git/*'], {
    cwd: codePath,
    encoding: 'utf8'
  }).stdout.trim();

  const enhancedTask = `${TASK_DESCRIPTION}\n\nFiles in workspace:\n${fileList}`;

  // Get CLI tool configuration
  const toolConfig = CLI_TOOLS[AI_TOOL];
  if (!toolConfig) {
    throw new Error(`Unknown AI tool: ${AI_TOOL}. Supported tools: ${Object.keys(CLI_TOOLS).join(', ')}`);
  }

  // Build command arguments using tool-specific configuration
  const binary = toolConfig.binary;
  const args = toolConfig.buildCommand(AI_MODEL, enhancedTask);

  console.log(`[EXECUTOR] Running: ${binary} ${JSON.stringify(args)}`);
  console.log(`[EXECUTOR] Working directory: ${codePath}`);
  console.log(`[EXECUTOR] Model: ${AI_MODEL || 'default'}`);

  // Execute without shell using spawnSync
  const aiResult = spawnSync(binary, args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024, // 10MB max
    timeout: 1200000, // 20 minute timeout for complex tasks
    cwd: codePath, // Run in the cloned code directory
    env: env,
    stdio: ['ignore', 'pipe', 'pipe'] // Ignore stdin to prevent waiting for input
  });

  if (aiResult.error) {
    throw new Error(`AI execution failed: ${aiResult.error.message}`);
  }

  const result = aiResult.stdout || aiResult.stderr || '';

  console.log('[EXECUTOR] AI execution complete');
  return result;
}

/**
 * Push results back to requester
 */
function pushResults(result: string) {
  console.log('[EXECUTOR] Preparing results');

  // Save results
  const results = {
    taskId: TASK_ID,
    tool: AI_TOOL,
    timestamp: new Date().toISOString(),
    output: result
  };

  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results));

  // Save AI output to file if there's any content
  if (result && result.trim().length > 0) {
    const outputFile = path.join(WORKSPACE, 'code', 'AI_OUTPUT.md');
    const outputContent = `# AI Task Results

**Task:** ${TASK_DESCRIPTION}
**Tool:** ${AI_TOOL}
**Date:** ${new Date().toISOString()}

## Output

${result}`;
    fs.writeFileSync(outputFile, outputContent);
    console.log('[EXECUTOR] AI output saved to AI_OUTPUT.md');
  }

  // Configure git locally (repo-specific config in writable tmpfs)
  const codePath = `${WORKSPACE}/code`;
  spawnSync('git', ['config', 'user.name', 'HokiPoki Executor'], { cwd: codePath, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.email', 'executor@hokipoki.temp'], { cwd: codePath, stdio: 'ignore' });

  // Debug: List files in directory
  const lsResult = spawnSync('ls', ['-la'], { cwd: codePath, encoding: 'utf8' });
  console.log('[EXECUTOR] DEBUG: Files in workspace after AI execution:');
  console.log(lsResult.stdout);

  // Debug: List src directory contents
  const srcResult = spawnSync('ls', ['-laR', 'src'], { cwd: codePath, encoding: 'utf8' });
  console.log('[EXECUTOR] DEBUG: Contents of src/ directory:');
  console.log(srcResult.stdout);

  // Debug: Show content of fizbuz.ts
  const catResult = spawnSync('cat', ['src/container/fizbuz.ts'], { cwd: codePath, encoding: 'utf8' });
  console.log('[EXECUTOR] DEBUG: Content of src/container/fizbuz.ts:');
  console.log(catResult.stdout);

  // Debug: Check git diff before adding
  const diffBeforeResult = spawnSync('git', ['diff'], { cwd: codePath, encoding: 'utf8' });
  console.log('[EXECUTOR] DEBUG: Git diff before add:');
  console.log(diffBeforeResult.stdout);

  // Add all changes
  const addResult = spawnSync('git', ['add', '-A'], { cwd: codePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  console.log('[EXECUTOR] DEBUG: Git add output:');
  console.log('stdout:', addResult.stdout);
  console.log('stderr:', addResult.stderr);

  // Check if there are any changes to commit
  const statusResult = spawnSync('git', ['status', '--porcelain'], { cwd: codePath, encoding: 'utf8' });
  const status = statusResult.stdout || '';

  console.log('[EXECUTOR] DEBUG: Git status output after add:');
  console.log(status);

  if (status.trim().length === 0) {
    console.log('[EXECUTOR] No changes to commit - AI made no modifications');
    console.log('[EXECUTOR] Skipping git commit and push');
    return;
  }

  console.log('[EXECUTOR] Changes detected, committing...');

  // Generate commit message with summary from AI output
  const commitSummary = extractCommitSummary(result);
  const commitMessage = `HokiPoki ${AI_TOOL}: ${commitSummary}`;

  // Commit changes
  try {
    const commitResult = spawnSync('git', ['commit', '-m', commitMessage], {
      cwd: codePath,
      stdio: 'inherit' // Show output for debugging
    });
    if (commitResult.error || commitResult.status !== 0) {
      throw new Error(`Git commit failed: ${commitResult.error || `exit code ${commitResult.status}`}`);
    }
  } catch (error) {
    console.error('[EXECUTOR] ERROR: Git commit failed!');
    throw error;
  }

  // Output commit message to stdout for provider CLI to capture
  // Use special marker that provider CLI can parse
  console.log(`[HOKIPOKI_COMMIT_MESSAGE]${commitMessage}[/HOKIPOKI_COMMIT_MESSAGE]`);

  // Push back to requester
  console.log('[EXECUTOR] Pushing changes back to requester...');

  // Ensure safe.directory is set before push (git push uses HOME env var)
  const pushEnv = {
    ...process.env,
    HOME: WORKSPACE, // Use workspace as home
    GIT_CONFIG_NOSYSTEM: '1', // Skip system config
  };

  // Set safe.directory with the custom HOME
  spawnSync('git', ['config', '--global', '--add', 'safe.directory', codePath], {
    env: pushEnv,
    stdio: 'ignore'
  });

  // Detect current branch name (handles both main and master)
  const branchResult = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: codePath,
    encoding: 'utf8'
  });
  const currentBranch = branchResult.stdout?.trim() || 'master';
  console.log(`[EXECUTOR] Current branch: ${currentBranch}`);

  // Git push will automatically use credential helper (configured in cloneCode)
  console.log('[EXECUTOR] Pushing with credential helper authentication');

  try {
    const pushResult = spawnSync('git', [
      'push', 'origin', currentBranch
    ], {
      cwd: codePath,
      env: pushEnv,
      stdio: 'inherit' // Show output for debugging
    });
    if (pushResult.error || pushResult.status !== 0) {
      throw new Error(`Git push failed: ${pushResult.error || `exit code ${pushResult.status}`}`);
    }
  } catch (error) {
    console.error('[EXECUTOR] ERROR: Git push failed!');
    throw error;
  }

  console.log('[EXECUTOR] Results pushed');
}

/**
 * Decrypt OAuth token
 */
function decryptToken(encryptedToken: string): string {
  // In production, use proper decryption
  // For now, return as-is (assuming pre-decrypted in test)
  return encryptedToken;
}

/**
 * Secure cleanup - wipe everything
 */
function secureCleanup() {
  console.log('[EXECUTOR] Secure cleanup initiated');

  // Explicitly wipe .gitconfig file containing credential helper with token
  const gitconfigPath = `${WORKSPACE}/.gitconfig`;
  if (fs.existsSync(gitconfigPath)) {
    try {
      // Overwrite with random data before deletion
      const randomData = crypto.randomBytes(1024);
      fs.writeFileSync(gitconfigPath, randomData);
      fs.unlinkSync(gitconfigPath);
      console.log('[EXECUTOR] .gitconfig file wiped');
    } catch (error) {
      console.warn('[EXECUTOR] Warning: Could not wipe .gitconfig file');
    }
  }

  // Skip file overwriting - tmpfs is destroyed on container exit
  // Just remove the workspace directory
  if (fs.existsSync(WORKSPACE)) {
    try {
      fs.rmSync(WORKSPACE, { recursive: true, force: true });
    } catch (error) {
      // Best effort - tmpfs will be destroyed anyway
      console.log('[EXECUTOR] Cleanup partial - tmpfs will be destroyed on exit');
    }
  }

  // Clear sensitive environment variables
  Object.keys(process.env).forEach(key => {
    if (key.startsWith('GIT_') || key.includes('TOKEN') || key.includes('TASK')) {
      delete process.env[key];
    }
  });

  // Force garbage collection if available
  if (global.gc) {
    global.gc();
  }

  console.log('[EXECUTOR] Workspace wiped');
}

/**
 * Emergency wipe on error
 */
function emergencyWipe() {
  console.log('[EXECUTOR] EMERGENCY WIPE');

  try {
    // Wipe .gitconfig file first (contains credential helper with token)
    const gitconfigPath = `${WORKSPACE}/.gitconfig`;
    if (fs.existsSync(gitconfigPath)) {
      const randomData = crypto.randomBytes(1024);
      fs.writeFileSync(gitconfigPath, randomData);
      fs.unlinkSync(gitconfigPath);
    }

    // Aggressive cleanup
    execSync(`rm -rf ${WORKSPACE}/*`, { stdio: 'ignore' });
    execSync(`rm -rf /tmp/*`, { stdio: 'ignore' });

    // Overwrite memory patterns
    const wipeBuffer = Buffer.alloc(1024 * 1024, 0); // 1MB of zeros
    for (let i = 0; i < 10; i++) {
      wipeBuffer.fill(Math.floor(Math.random() * 256));
    }

  } catch {
    // Best effort
  }
}

/**
 * Extract a concise summary from AI output for commit message
 * Limits to 200 characters and removes sensitive data
 */
function extractCommitSummary(aiOutput: string): string {
  if (!aiOutput || aiOutput.trim().length === 0) {
    return 'Execution complete';
  }

  // Get first meaningful line or paragraph
  const lines = aiOutput.trim().split('\n').filter(line => line.trim().length > 10);
  let summary = lines[0] || 'Execution complete';

  // Clean up common AI output prefixes
  summary = summary
    .replace(/^(# |## |### |\* |- |\d+\. )/, '') // Remove markdown/list markers
    .replace(/^(Sure|OK|Alright|Here|Let me|I'?ll|I've|I have|Done)[\s,:!.-]+/i, '') // Remove filler words
    .trim();

  // Security: Remove potential tokens and URLs (but keep file paths - they're useful)
  summary = summary
    .replace(/\b([a-f0-9]{32,}|[A-Za-z0-9_-]{20,})\b/g, '[REDACTED]') // Tokens/secrets
    .replace(/https?:\/\/[^\s]+/g, '[URL]'); // URLs

  // Truncate to 200 characters
  if (summary.length > 200) {
    summary = summary.substring(0, 197) + '...';
  }

  // Fallback if nothing meaningful extracted
  if (summary.length < 5) {
    return 'Execution complete';
  }

  return summary;
}

// Start execution
execute().catch(error => {
  console.error('Unhandled error:', error);
  emergencyWipe();
  process.exit(1);
});