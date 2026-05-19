#!/bin/bash

# Stop PR Dashboard

echo "🛑 Stopping PR Dashboard..."

# Detect container runtime
if command -v podman &> /dev/null; then
    podman compose down
elif command -v docker &> /dev/null; then
    docker-compose down
else
    echo "❌ Neither Docker nor Podman found"
    exit 1
fi

echo "✅ PR Dashboard stopped"
