#!/bin/bash

# Docker setup script for ZeroTier Batman mesh routing
# This script ensures Docker is installed and the ZeroTier container image is available

set -e

echo "🐳 Setting up Docker for ZeroTier mesh routing..."

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "📦 Installing Docker..."
    
    # Update package index
    sudo apt-get update
    
    # Install Docker
    sudo apt-get install -y docker.io
    
    # Start and enable Docker service
    sudo systemctl start docker
    sudo systemctl enable docker
    
    # Add current user to docker group
    sudo usermod -aG docker $USER
    
    echo "✅ Docker installed successfully"
    echo "⚠️  Please log out and back in for Docker group membership to take effect"
else
    echo "✅ Docker is already installed"
fi

# Check if Docker is running
if ! sudo systemctl is-active --quiet docker; then
    echo "🔄 Starting Docker service..."
    sudo systemctl start docker
fi

# Pull ZeroTier Docker image
echo "📥 Pulling ZeroTier Docker image..."
sudo docker pull zerotier/zerotier:latest

echo ""
echo "🎉 Docker setup complete!"
echo ""
echo "The ZeroTier manager will now use Docker containers instead of complex chroot setups."
echo "Benefits:"
echo "  ✅ Automatic process isolation"
echo "  ✅ Reliable container networking"
echo "  ✅ Easy cleanup and restart"
echo "  ✅ No manual binary copying or library dependencies"
echo "  ✅ Official ZeroTier Docker image"
echo ""
echo "Next: Run your batman coordinator/mesh node as usual."
