#!/bin/bash

# Exit on error
set -e

# Check if version argument is provided
if [ -z "$1" ]; then
    echo "❌ Error: Version number required"
    echo "Usage: ./publish.sh <version>"
    echo "Example: ./publish.sh 0.1.0"
    exit 1
fi

VERSION=$1

# Ensure we have a clean working directory
if [ -n "$(git status --porcelain)" ]; then
    echo "❌ Error: Working directory not clean"
    echo "Please commit or stash changes first"
    exit 1
fi

echo "🔄 Updating version to $VERSION..."
npm version $VERSION --no-git-tag-version

# Update version in package.json and create commit
git add package.json
git commit -m "chore: bump version to $VERSION"

# Build and package
./scripts/build.sh

# Get publisher from package.json
PUBLISHER=$(node -p "require('./package.json').publisher")

echo "📤 Creating GitHub release..."
gh release create v$VERSION now-playing-lyrics-$VERSION.vsix \
    --title "Now Playing Lyrics v$VERSION" \
    --notes "## Installation

### VSCode
Install from [VSCode Marketplace](https://marketplace.visualstudio.com/items?itemName=$PUBLISHER.now-playing-lyrics)

### Manual Installation
1. Download the VSIX file from this release
2. In VSCode, go to Extensions (Cmd+Shift+X)
3. Click ... menu (top-right)
4. Select 'Install from VSIX...'
5. Choose the downloaded file"

echo "📦 Publishing to VSCode Marketplace..."
vsce publish

echo "✅ Publication complete!"
echo "🌟 Don't forget to:"
echo "1. Update README if needed"
echo "2. Push the version bump commit: git push"
