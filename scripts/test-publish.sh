#!/bin/bash

# Exit on error
set -e

# Check if version argument is provided
if [ -z "$1" ]; then
    echo "❌ Error: Version number required"
    echo "Usage: ./test-publish.sh <version>"
    echo "Example: ./test-publish.sh 0.1.0"
    exit 1
fi

VERSION=$1

# Update version in package.json
npm version $VERSION --no-git-tag-version

# Build and package
./scripts/build.sh

echo "🧪 Testing VSIX installation..."
code --install-extension now-playing-lyrics-$VERSION.vsix

echo "✅ Test installation complete!"
echo "🔍 Check VSCode for the extension"
echo "⚠️ Remember to reset package.json version if this is just a test"
