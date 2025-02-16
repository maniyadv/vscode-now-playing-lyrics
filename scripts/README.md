# Development Scripts

This directory contains helpful scripts for building, testing, and publishing the extension.

## Prerequisites

1. Install required tools:
```bash
npm install -g @vscode/vsce
npm install -g @vscode/test-cli
```

2. Make scripts executable:
```bash
chmod +x scripts/*.sh
```

## Available Scripts

### 1. Build (`build.sh`)
Builds and packages the extension into a VSIX file:
```bash
./scripts/build.sh
```

### 2. Test Publish (`test-publish.sh`)
Tests the extension by installing it locally:
```bash
./scripts/test-publish.sh <version>
# Example: ./scripts/test-publish.sh 0.1.0
```
Note: This will modify package.json version. Reset it if this is just a test.

### 3. Publish (`publish.sh`)
Publishes a new version to GitHub and VSCode Marketplace:
```bash
./scripts/publish.sh <version>
# Example: ./scripts/publish.sh 0.1.0
```

This script will:
1. Update version in package.json
2. Create a commit for version bump
3. Build and package VSIX
4. Create GitHub release
5. Publish to VSCode Marketplace

## Development Workflow

1. Make your changes
2. Test locally:
   ```bash
   ./scripts/test-publish.sh 0.1.0-test
   ```
3. Reset package.json version
4. When ready to publish:
   ```bash
   ./scripts/publish.sh 0.1.0
   ```

## Notes

- Always test with `test-publish.sh` before actual publication
- Keep your access tokens secure
- The scripts require a clean working directory for publishing
- Version numbers should follow semver (X.Y.Z)
