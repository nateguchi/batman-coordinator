#!/bin/bash

# Quick deployment script for Batman Mesh Coordinator
# Usage: ./deploy.sh [coordinator|node]

set -e

ROLE=${1:-coordinator}
PROJECT_DIR="/opt/batman-coordinator"
SERVICE_NAME="batman-${ROLE}"

echo "🚀 Deploying Batman Mesh ${ROLE}..."

# Check if running as root
if [[ $EUID -ne 0 ]]; then
    echo "❌ This script must be run as root"
    exit 1
fi

# Create project directory
if [[ ! -d "$PROJECT_DIR" ]]; then
    echo "📁 Creating project directory..."
    mkdir -p "$PROJECT_DIR"
fi

# Copy project files
echo "📋 Copying project files..."
rsync -av --exclude=node_modules --exclude=.git --exclude=logs . "$PROJECT_DIR/"

# Set permissions
chown -R root:root "$PROJECT_DIR"
chmod +x "$PROJECT_DIR/scripts/"*.sh
chmod +x "$PROJECT_DIR/scripts/"*.js

# Install dependencies
echo "📦 Installing dependencies..."
cd "$PROJECT_DIR"
npm install --production

# Setup environment
if [[ ! -f "$PROJECT_DIR/.env" ]]; then
    echo "⚙️ Creating environment file..."
    cp "$PROJECT_DIR/.env.example" "$PROJECT_DIR/.env"
    echo "⚠️  Please edit $PROJECT_DIR/.env with your configuration"
fi

# Enable and start service
echo "🔧 Configuring service..."
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"

# Check if service should be started
read -p "Start the $SERVICE_NAME service now? (y/N): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    systemctl start "$SERVICE_NAME"
    echo "✅ Service started"
    
    # Show status
    systemctl status "$SERVICE_NAME" --no-pager
else
    echo "ℹ️  Service enabled but not started"
    echo "   Start with: systemctl start $SERVICE_NAME"
fi

echo ""
echo "🎉 Deployment complete!"
echo ""
echo "Useful commands:"
echo "  Status:  systemctl status $SERVICE_NAME"
echo "  Logs:    journalctl -fu $SERVICE_NAME"
echo "  Stop:    systemctl stop $SERVICE_NAME"
echo "  Restart: systemctl restart $SERVICE_NAME"
echo ""

if [[ "$ROLE" == "coordinator" ]]; then
    echo "Web interface will be available at: http://$(hostname -I | awk '{print $1}'):3000"
fi
