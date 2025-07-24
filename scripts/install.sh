#!/bin/bash

# Batman Mesh Network Installation Script
# Supports Debian Buster and Bookworm

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging
LOG_FILE="/var/log/batman-install.log"
exec 1> >(tee -a "$LOG_FILE")
exec 2> >(tee -a "$LOG_FILE" >&2)

log() {
    echo -e "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')] ✓${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[$(date +'%Y-%m-%d %H:%M:%S')] ⚠${NC} $1"
}

log_error() {
    echo -e "${RED}[$(date +'%Y-%m-%d %H:%M:%S')] ✗${NC} $1"
}

# Check if running as root
check_root() {
    if [[ $EUID -ne 0 ]]; then
        log_error "This script must be run as root"
        exit 1
    fi
}

# Detect OS version
detect_os() {
    if [[ -f /etc/os-release ]]; then
        . /etc/os-release
        OS_ID=$ID
        OS_VERSION_ID=$VERSION_ID
        OS_CODENAME=$VERSION_CODENAME
    else
        log_error "Cannot detect OS version"
        exit 1
    fi
    
    log "Detected OS: $OS_ID $OS_VERSION_ID ($OS_CODENAME)"
    
    # Validate supported OS
    case "$OS_CODENAME" in
        "buster"|"bullseye"|"bookworm")
            log_success "Supported OS detected"
            ;;
        *)
            log_warning "OS not officially supported, continuing anyway..."
            ;;
    esac
}

# Update package lists
update_system() {
    log "Updating package lists..."
    apt update
    log_success "Package lists updated"
}

# Install base dependencies
install_base_dependencies() {
    log "Installing base dependencies..."
    
    local packages=(
        "curl"
        "wget"
        "gnupg2"
        "software-properties-common"
        "apt-transport-https"
        "ca-certificates"
        "git"
        "build-essential"
    )
    
    apt install -y "${packages[@]}"
    log_success "Base dependencies installed"
}

# Install networking tools
install_networking() {
    log "Installing networking tools..."
    
    local packages=(
        "iw"
        "wireless-tools"
        "wpasupplicant"
        "bridge-utils"
        "iptables"
        "netfilter-persistent"
        "iptables-persistent"
    )
    
    # Add nftables for Bookworm
    if [[ "$OS_CODENAME" == "bookworm" ]]; then
        packages+=("nftables")
    fi
    
    apt install -y "${packages[@]}"
    log_success "Networking tools installed"
}

# Install batman-adv
install_batman() {
    log "Installing batman-adv..."
    
    # Install batman-adv and batctl
    apt install -y batman-adv-dkms batctl
    
    # Load batman-adv module
    modprobe batman-adv || log_warning "Failed to load batman-adv module (may need reboot)"
    
    # Enable batman-adv on boot
    echo "batman-adv" >> /etc/modules
    
    log_success "Batman-adv installed"
}

# Install Node.js
install_nodejs() {
    log "Installing Node.js..."
    
    # Add NodeSource repository
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
    
    # Install Node.js
    apt install -y nodejs
    
    # Verify installation
    node_version=$(node --version)
    npm_version=$(npm --version)
    
    log_success "Node.js installed: $node_version, npm: $npm_version"
}

# Install ZeroTier
install_zerotier() {
    log "Installing ZeroTier..."
    
    # Install ZeroTier
    curl -s https://install.zerotier.com | bash
    
    # Enable and start ZeroTier service
    systemctl enable zerotier-one
    systemctl start zerotier-one
    
    # Wait for service to start
    sleep 3
    
    # Verify installation
    if zerotier-cli status >/dev/null 2>&1; then
        log_success "ZeroTier installed and running"
    else
        log_warning "ZeroTier installed but may not be running properly"
    fi
}

# Configure kernel modules
configure_kernel() {
    log "Configuring kernel modules..."
    
    # Create modules configuration
    cat > /etc/modules-load.d/batman.conf << EOF
# Batman-adv mesh networking
batman-adv
EOF
    
    # Create batman-adv configuration
    cat > /etc/modprobe.d/batman.conf << EOF
# Batman-adv module configuration
options batman-adv routing_algo BATMAN_IV
EOF
    
    log_success "Kernel modules configured"
}

# Configure network forwarding
configure_forwarding() {
    log "Configuring network forwarding..."
    
    # Create sysctl configuration
    cat > /etc/sysctl.d/99-batman-forwarding.conf << EOF
# Enable IP forwarding for batman mesh
net.ipv4.ip_forward=1
net.ipv6.conf.all.forwarding=1

# Network security hardening
net.ipv4.conf.all.send_redirects=0
net.ipv4.conf.default.send_redirects=0
net.ipv4.conf.all.accept_redirects=0
net.ipv4.conf.default.accept_redirects=0
net.ipv4.conf.all.accept_source_route=0
net.ipv4.conf.default.accept_source_route=0
net.ipv4.conf.all.log_martians=1
net.ipv4.conf.default.log_martians=1
net.ipv4.icmp_echo_ignore_broadcasts=1
net.ipv4.icmp_ignore_bogus_error_responses=1
net.ipv4.tcp_syncookies=1
EOF
    
    # Apply configuration
    sysctl -p /etc/sysctl.d/99-batman-forwarding.conf
    
    log_success "Network forwarding configured"
}

# Install additional security tools
install_security_tools() {
    log "Installing security tools..."
    
    local packages=(
        "fail2ban"
        "ufw"
        "rkhunter"
        "chkrootkit"
    )
    
    # Install packages (some may not be available)
    for package in "${packages[@]}"; do
        if apt install -y "$package" 2>/dev/null; then
            log_success "Installed $package"
        else
            log_warning "Could not install $package"
        fi
    done
}

# Configure fail2ban
configure_fail2ban() {
    if command -v fail2ban-server >/dev/null 2>&1; then
        log "Configuring fail2ban..."
        
        cat > /etc/fail2ban/jail.local << EOF
[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 3

[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log
maxretry = 3
EOF
        
        systemctl enable fail2ban
        systemctl restart fail2ban
        
        log_success "Fail2ban configured"
    fi
}

# Create batman mesh directories
create_directories() {
    log "Creating batman mesh directories..."
    
    local directories=(
        "/etc/batman-coordinator"
        "/var/lib/batman-coordinator"
        "/var/log/batman-coordinator"
    )
    
    for dir in "${directories[@]}"; do
        mkdir -p "$dir"
        chmod 755 "$dir"
    done
    
    log_success "Directories created"
}

# Setup batman mesh user
setup_user() {
    log "Setting up batman mesh user..."
    
    # Create batman user if it doesn't exist
    if ! id "batman" >/dev/null 2>&1; then
        useradd -r -s /bin/false -d /var/lib/batman-coordinator batman
        log_success "Batman user created"
    else
        log_success "Batman user already exists"
    fi
}

# Install systemd services
install_services() {
    log "Installing systemd services..."
    
    # Create coordinator service
    cat > /etc/systemd/system/batman-coordinator.service << EOF
[Unit]
Description=Batman Mesh Network Coordinator
After=network.target zerotier-one.service
Wants=zerotier-one.service

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=/opt/batman-coordinator
ExecStart=/usr/bin/node src/coordinator.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=batman-coordinator
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

    # Create node service
    cat > /etc/systemd/system/batman-node.service << EOF
[Unit]
Description=Batman Mesh Network Node
After=network.target zerotier-one.service
Wants=zerotier-one.service

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=/opt/batman-coordinator
ExecStart=/usr/bin/node src/mesh-node.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=batman-node
Environment=NODE_ENV=node

[Install]
WantedBy=multi-user.target
EOF

    # Reload systemd
    systemctl daemon-reload
    
    log_success "Systemd services installed"
}

# Setup log rotation
setup_logrotate() {
    log "Setting up log rotation..."
    
    cat > /etc/logrotate.d/batman-coordinator << EOF
/var/log/batman-coordinator/*.log {
    daily
    missingok
    rotate 14
    compress
    delaycompress
    notifempty
    create 0644 batman batman
    postrotate
        systemctl reload batman-coordinator 2>/dev/null || true
        systemctl reload batman-node 2>/dev/null || true
    endscript
}
EOF
    
    log_success "Log rotation configured"
}

# Cleanup
cleanup() {
    log "Cleaning up..."
    
    apt autoremove -y
    apt autoclean
    
    log_success "Cleanup completed"
}

# Print installation summary
print_summary() {
    log_success "Batman Mesh Network installation completed!"
    echo ""
    echo "================================================================"
    echo "Installation Summary"
    echo "================================================================"
    echo "OS: $OS_ID $OS_VERSION_ID ($OS_CODENAME)"
    echo "Node.js: $(node --version)"
    echo "NPM: $(npm --version)"
    echo ""
    echo "Services installed:"
    echo "  - batman-coordinator.service (disabled by default)"
    echo "  - batman-node.service (disabled by default)"
    echo ""
    echo "Next steps:"
    echo "1. Clone the batman-coordinator project to /opt/batman-coordinator"
    echo "2. Configure the .env file"
    echo "3. Install NPM dependencies: npm install"
    echo "4. Enable and start services:"
    echo "   - For coordinator: systemctl enable --now batman-coordinator"
    echo "   - For nodes: systemctl enable --now batman-node"
    echo ""
    echo "Configuration files:"
    echo "  - /etc/batman-coordinator/"
    echo "  - /etc/modules-load.d/batman.conf"
    echo "  - /etc/sysctl.d/99-batman-forwarding.conf"
    echo ""
    echo "Log files:"
    echo "  - /var/log/batman-coordinator/"
    echo "  - Installation log: $LOG_FILE"
    echo "================================================================"
}

# Main installation function
main() {
    log "Starting Batman Mesh Network installation..."
    
    check_root
    detect_os
    update_system
    install_base_dependencies
    install_networking
    install_batman
    install_nodejs
    install_zerotier
    configure_kernel
    configure_forwarding
    install_security_tools
    configure_fail2ban
    create_directories
    setup_user
    install_services
    setup_logrotate
    cleanup
    print_summary
    
    log_success "Installation completed successfully!"
}

# Run main function
main "$@"
