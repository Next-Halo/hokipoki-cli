#!/bin/bash

# HokiPoki CLI - Setup script for npm authentication
# This script configures npm to authenticate with GitHub Packages

NPMRC_FILE="$HOME/.npmrc"
GITHUB_TOKEN="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"

echo "🔧 Setting up npm authentication for @actserbia/hokipoki-cli..."

# Backup existing .npmrc if it exists
if [ -f "$NPMRC_FILE" ]; then
    echo "📋 Backing up existing .npmrc to .npmrc.backup"
    cp "$NPMRC_FILE" "$NPMRC_FILE.backup"
fi

# Check if GitHub Packages registry is already configured
if grep -q "@actserbia:registry=https://npm.pkg.github.com/" "$NPMRC_FILE" 2>/dev/null; then
    echo "✅ GitHub Packages registry already configured"
else
    echo "📝 Adding GitHub Packages registry configuration..."
    echo "@actserbia:registry=https://npm.pkg.github.com/" >> "$NPMRC_FILE"
fi

# Check if auth token is already configured
if grep -q "//npm.pkg.github.com/:_authToken=" "$NPMRC_FILE" 2>/dev/null; then
    echo "✅ Auth token already configured"
    # Update the token if it's different
    sed -i.tmp "s|//npm.pkg.github.com/:_authToken=.*|//npm.pkg.github.com/:_authToken=$GITHUB_TOKEN|" "$NPMRC_FILE"
    rm -f "$NPMRC_FILE.tmp"
else
    echo "📝 Adding auth token..."
    echo "//npm.pkg.github.com/:_authToken=$GITHUB_TOKEN" >> "$NPMRC_FILE"
fi

echo ""
echo "✅ Setup complete! You can now install HokiPoki CLI:"
echo ""
echo "   npm install -g @actserbia/hokipoki-cli@1.0.0"
echo ""
echo "After installation, verify with:"
echo "   hokipoki --version"
echo ""
