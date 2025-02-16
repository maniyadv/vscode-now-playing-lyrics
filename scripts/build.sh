#!/bin/bash

# Exit on error
set -e

echo "🏗️ Building extension..."
npm run compile

echo "📦 Packaging VSIX..."
vsce package

echo "✅ Build complete!"
