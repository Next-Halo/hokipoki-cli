#!/bin/bash

# HokiPoki Universal Wrapper
# Can be called from any AI CLI to request help from another tool
#
# Usage: hokipoki-request <tool> "<task>" [files...]
#
# Examples:
#   hokipoki-request codex "optimize this function" main.js utils.js
#   hokipoki-request claude "explain this algorithm" algorithm.py
#   hokipoki-request gemini "create unit tests" src/app.ts

# Check if we have minimum arguments
if [ $# -lt 2 ]; then
    echo "Usage: hokipoki-request <tool> \"<task>\" [files...]"
    echo ""
    echo "Available tools: claude, codex, gemini, gpt4, llama"
    echo ""
    echo "Examples:"
    echo "  hokipoki-request codex \"optimize this function\" main.js"
    echo "  hokipoki-request claude \"explain this complex algorithm\""
    exit 1
fi

TOOL=$1
TASK=$2
shift 2
FILES=$@

# Determine the HokiPoki installation directory
HOKIPOKI_DIR="$(dirname "$(dirname "$(dirname "$0")")")"

# Check if HokiPoki is installed
if [ ! -f "$HOKIPOKI_DIR/package.json" ]; then
    echo "Error: HokiPoki not found. Please install HokiPoki first:"
    echo "  npm install -g hokipoki"
    exit 1
fi

# Build the command
CMD="npm run cli request --"
CMD="$CMD --tool \"$TOOL\""
CMD="$CMD --task \"$TASK\""

# Add files if provided
if [ -n "$FILES" ]; then
    CMD="$CMD --files $FILES"
fi

# Add server URL if set in environment
if [ -n "$HOKIPOKI_SERVER" ]; then
    CMD="$CMD --server $HOKIPOKI_SERVER"
fi

# Change to HokiPoki directory and execute
cd "$HOKIPOKI_DIR"

echo "[HokiPoki] Requesting help from $TOOL..."
echo "[HokiPoki] Task: $TASK"

# Execute the command
eval $CMD

# Capture and return the exit code
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
    echo "[HokiPoki] Request completed successfully"
else
    echo "[HokiPoki] Request failed with code $EXIT_CODE"
fi

exit $EXIT_CODE