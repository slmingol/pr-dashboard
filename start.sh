#!/bin/bash

# Quick start script for PR Dashboard

echo "🔀 Starting PR Dashboard..."

# Detect container runtime (Docker or Podman)
if command -v podman &> /dev/null && podman info > /dev/null 2>&1; then
    CONTAINER_CMD="podman"
    COMPOSE_CMD="podman compose"
    echo "Using Podman"
elif command -v docker &> /dev/null && docker info > /dev/null 2>&1; then
    CONTAINER_CMD="docker"
    COMPOSE_CMD="docker-compose"
    echo "Using Docker"
else
    echo "❌ Neither Docker nor Podman is running. Please start one and try again."
    exit 1
fi

# Check if ghreport output directory exists
GHREPORT_DIR="${GHREPORT_OUTPUT_DIR:-$HOME/ghreport-output}"
if [ ! -d "$GHREPORT_DIR" ]; then
    echo "⚠️  ghreport output directory not found: $GHREPORT_DIR"
    echo "Creating directory..."
    mkdir -p "$GHREPORT_DIR"
    echo "Please configure your ghreport to output to: $GHREPORT_DIR/ghreport.txt"
fi

# Check if gh CLI is authenticated
if ! gh auth status > /dev/null 2>&1; then
    echo "❌ GitHub CLI not authenticated. Please run: gh auth login"
    exit 1
fi

# Build and start containers
echo "Building and starting containers..."
$COMPOSE_CMD up -d --build

# Wait for health check
echo "Waiting for service to be ready..."
sleep 3

# Check if service is running
if $COMPOSE_CMD ps | grep -q "Up"; then
    echo "✅ PR Dashboard is running!"
    echo "🌐 Open http://localhost:3000 in your browser"
    echo ""
    echo "View logs: $COMPOSE_CMD logs -f"
    echo "Stop: ./stop.sh"
else
    echo "⚠️  Service may not have started properly. Check logs with:"
    echo "   $COMPOSE_CMD logs -f"
fi
