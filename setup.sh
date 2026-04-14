#!/bin/bash

# Brain System Setup Script

set -e

BRAIN_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "Setting up Brain System in: $BRAIN_DIR"

# Check Node.js
echo "Checking Node.js..."
if ! command -v node &> /dev/null; then
  echo "Error: Node.js is not installed"
  exit 1
fi

NODE_VERSION=$(node --version)
echo "Node.js version: $NODE_VERSION"

# Check npm
echo "Checking npm..."
if ! command -v npm &> /dev/null; then
  echo "Error: npm is not installed"
  exit 1
fi

# Install dependencies
echo "Installing dependencies..."
cd "$BRAIN_DIR"
if [ ! -f "package.json" ]; then
  echo "Error: package.json not found"
  exit 1
fi

npm install

# Create symlinks if in path
if [ -n "$PWD" ]; then
  echo "Setup complete!"
  echo ""
  echo "Add to PATH (optional):"
  echo "  export PATH=\"$BRAIN_DIR/bin:\$PATH\""
  echo ""
  echo "Test installation:"
  echo "  cd $BRAIN_DIR"
  echo "  ./bin/claude-brain --help"
fi
