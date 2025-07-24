# Batman Mesh Network Coordinator

A secure mesh network system for Raspberry Pi devices using batman-adv and ZeroTier, with a Node.js coordinator for management and monitoring.

## Features

- **Secure mesh networking** using batman-adv protocol
- **ZeroTier integration** for secure internet access
- **Master/Node architecture** with one internet-connected master
- **Traffic isolation** - only ZeroTier traffic allowed on mesh
- **Real-time monitoring** via web GUI
- **Automatic node setup** with single command
- **Security hardening** to minimize attack surface
- **Support for Debian Buster and Bookworm**

## Architecture

```
Internet ← → Master Pi (Coordinator) ← → Mesh Network ← → Node Pis
                ↓                           ↓
            ZeroTier Planet            ZeroTier Clients
```

## Prerequisites

### Hardware Requirements
- Raspberry Pi 4 or newer (recommended)
- WiFi adapter capable of monitor/ad-hoc mode
- SD card (16GB+ recommended)
- Network connectivity for initial setup

### Software Dependencies

#### For Debian Buster (Raspbian Buster)
```bash
sudo apt update
sudo apt install -y curl wget gnupg2 software-properties-common
sudo apt install -y batctl bridge-utils
sudo apt install -y iptables iptables-persistent
sudo apt install -y iw wireless-tools wpasupplicant
sudo apt install -y nodejs npm git
```

#### For Debian Bookworm (Raspbian Bookworm)
```bash
sudo apt update
sudo apt install -y curl wget gnupg2 software-properties-common
sudo apt install -y batctl bridge-utils
sudo apt install -y iptables iptables-persistent nftables
sudo apt install -y iw wireless-tools wpasupplicant
sudo apt install -y nodejs npm git
```

#### Install ZeroTier
```bash
curl -s https://install.zerotier.com | sudo bash
```

#### Install Node.js (if not available in repos)
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
```

## Installation

### 1. Clone and Setup
```bash
git clone <repository-url>
cd batman-coordinator
npm install
```

### 2. Configuration
Copy the example environment file and configure:
```bash
cp .env.example .env
nano .env
```

### 3. Network Configuration
Edit `.env` file with your settings:
```env
# Network Configuration
MESH_INTERFACE=wlan1
MESH_SSID=batman-mesh
MESH_CHANNEL=6
MESH_FREQUENCY=2437

# ZeroTier Configuration
ZEROTIER_NETWORK_ID=your_network_id_here
ZEROTIER_AUTH_TOKEN=your_auth_token_here

# Coordinator Configuration
COORDINATOR_PORT=3000
COORDINATOR_HOST=0.0.0.0
LOG_LEVEL=info

# Security Configuration
ALLOWED_ZEROTIER_SUBNETS=10.147.0.0/16
MESH_SUBNET=192.168.100.0/24
MASTER_IP=192.168.100.1

# Node Configuration
NODE_CHECK_INTERVAL=30000
PING_TIMEOUT=5000
STATS_COLLECTION_INTERVAL=10000
```

## Usage

### Running the Coordinator (Master Node)
On the master Raspberry Pi that has internet access:
```bash
npm run coordinator
```

The web interface will be available at `http://<master-ip>:3000`

### Setting up Mesh Nodes
On each node Raspberry Pi:
```bash
npm run mesh-node
```

This will automatically:
- Configure the wireless interface for ad-hoc mode
- Set up batman-adv
- Connect to ZeroTier network
- Configure firewall rules
- Start monitoring services

### Development Mode
For development with auto-restart:
```bash
npm run dev
```

## Web Interface

The coordinator provides a real-time web dashboard showing:
- Mesh topology and node status
- Network traffic statistics
- ZeroTier connection status
- Security alerts and logs
- Node performance metrics

Access via: `http://<coordinator-ip>:3000`

## Security Features

The SecurityManager provides targeted protection for the batman mesh network while preserving system services:

### Firewall Configuration
- **Interface-specific rules**: Only secures batman interfaces (`bat0`, `wlan0/wlan1`)
- **System service preservation**: Maintains access to Bluetooth, SSH, and other services through ethernet (`eth1`)
- **ZeroTier integration**: Allows encrypted traffic through ZeroTier tunnels
- **Coordinator NAT**: Only the coordinator node configures NAT for internet sharing
- **Automatic detection**: Supports both iptables (Buster) and nftables (Bookworm)

### Security Options
- `DISABLE_SYSTEM_HARDENING=true`: Preserves all system services (recommended)
- `ETHERNET_INTERFACE=eth1`: Specifies which interface to preserve for system access
- Blocks direct mesh communication while allowing batman-adv protocol
- Real-time security monitoring and threat detection

### Network Isolation
- **Security focus**: Prevents unauthorized users from accessing internet through the mesh network
- **Node access**: All nodes have full ethernet access for legitimate operations and management
- **Gateway routing**: Mesh nodes route all internet traffic through batman mesh to coordinator
- **Mesh isolation**: Batman mesh traffic is isolated and cannot be forwarded to ethernet interfaces
- **Coordinator gateway**: Coordinator acts as full internet gateway for all mesh node traffic
- **Default routing**: All node internet traffic (including ZeroTier) goes through coordinator via batman interface

### Encryption
- ZeroTier provides end-to-end encryption
- Batman-adv mesh uses ZeroTier for all data
- No unencrypted traffic on mesh network

## Network Topology

### Master Node (Coordinator)
- Connected to internet via eth0/wlan0
- Runs batman-adv on mesh interface
- ZeroTier client for secure routing
- Web interface for monitoring
- Traffic analysis and filtering

### Mesh Nodes
- Batman-adv mesh participation only
- ZeroTier client for internet access
- All traffic routed through ZeroTier
- No direct mesh communication (security)

### IP Address Assignment

The system automatically assigns unique IP addresses within the mesh network:

#### Coordinator (Master Node)
- **Fixed IP**: `192.168.100.1` (set by `MASTER_IP` environment variable)
- **Role**: Gateway for all mesh nodes
- **Batman Interface**: `bat0` with coordinator IP

#### Mesh Nodes  
- **Dynamic IP**: Automatically generated based on hardware MAC address
- **Range**: `192.168.100.2` to `192.168.100.254` (avoids coordinator IP)
- **Uniqueness**: Each node gets a consistent, unique IP based on its MAC address
- **Batman Interface**: `bat0` with auto-assigned IP

#### IP Generation Algorithm
```javascript
// Example: MAC aa:bb:cc:dd:ee:ff generates IP 192.168.100.171
1. Extract hardware MAC address from primary network interface
2. Create MD5 hash of MAC address
3. Convert first 2 bytes of hash to decimal (0-255)
4. Map to valid IP range (2-254, avoiding .1 and .255)
5. Handle conflicts with coordinator IP automatically
```

#### Testing IP Assignment
```bash
# Test IP generation for current system
node test-node-ip.js

# Check current batman interface IP
ip addr show bat0 | grep "inet "

# View all mesh node IPs
sudo batctl meshif bat0 neighbors
```

## Troubleshooting

### NetworkManager Conflicts

NetworkManager can interfere with manual wireless configuration. Here are solutions:

#### Disable NetworkManager for mesh interface
```bash
# Check if NetworkManager is installed and running
if systemctl is-active --quiet NetworkManager; then
    echo "NetworkManager is running, configuring ignore rules..."
    
    # Create configuration directory if it doesn't exist
    sudo mkdir -p /etc/NetworkManager/conf.d/
    
    # Create NetworkManager ignore rule
    sudo tee /etc/NetworkManager/conf.d/99-unmanaged-devices.conf << EOF
[keyfile]
unmanaged-devices=interface-name:wlan0;interface-name:wlan1;interface-name:bat0
EOF

    # Restart NetworkManager
    sudo systemctl restart NetworkManager
else
    echo "NetworkManager not running - no configuration needed"
fi

# Alternative: temporarily stop NetworkManager if running
sudo systemctl stop NetworkManager 2>/dev/null || echo "NetworkManager not running"
```

#### Alternative: Use systemd-networkd
```bash
# Disable NetworkManager
sudo systemctl disable NetworkManager
sudo systemctl stop NetworkManager

# Enable systemd-networkd
sudo systemctl enable systemd-networkd
sudo systemctl start systemd-networkd
```

#### Manual interface management
```bash
# Take control of interface from NetworkManager
sudo nmcli device set <interface> managed no

# Verify it's unmanaged
nmcli device status
```

### Common Issues

#### Batman interface not coming up
```bash
# Check batman module
sudo modprobe batman-adv
sudo batctl if add <interface>
sudo ip link set up dev bat0
```

#### ZeroTier not connecting
```bash
# Check ZeroTier status
sudo zerotier-cli status
sudo zerotier-cli listnetworks

# Rejoin network
sudo zerotier-cli leave <network-id>
sudo zerotier-cli join <network-id>
```

#### Wireless interface issues

##### "Operation already in progress (-114)" Error
This error occurs when the interface is stuck in a transition state or already connected:

```bash
# Step 1: Disconnect from any existing networks
sudo iw <interface> disconnect

# Step 2: Leave any existing IBSS networks
sudo iw <interface> ibss leave

# Step 3: Kill any conflicting processes
sudo pkill wpa_supplicant
sudo pkill NetworkManager

# Step 4: Reset the interface completely
sudo ip link set <interface> down
sudo rfkill unblock wifi
sudo ip link set <interface> up

# Step 5: Set to IBSS mode and join
sudo iw <interface> set type ibss
sudo iw <interface> ibss join <ssid> <frequency>
```

##### "Connection timed out (-110)" Error
This indicates hardware or driver issues:

```bash
# Check if interface supports IBSS mode
iw <interface> info | grep -i ibss

# Check available channels
iw phy phy0 channels | grep -E "(MHz|disabled)"

# Reset wireless hardware
sudo modprobe -r brcmfmac  # For Raspberry Pi WiFi
sudo modprobe brcmfmac

# Try different frequency/channel
sudo iw <interface> ibss join <ssid> 2462  # Channel 11
sudo iw <interface> ibss join <ssid> 2437  # Channel 6
```

##### General wireless interface reset
```bash
# Complete interface reset
sudo ip link set <interface> down
sudo iw <interface> set type ibss
sudo ip link set <interface> up
sudo iw <interface> ibss join <ssid> <frequency>
```

##### Check interface status
```bash
# View current interface state
iw <interface> info
iw <interface> link

# Check for errors in system logs
sudo dmesg | tail -20
sudo journalctl -u NetworkManager | tail -20
```

### Quick Fix Script

For immediate resolution of the "Operation already in progress" error:

```bash
#!/bin/bash
# Quick fix for wireless interface issues
INTERFACE=${1:-wlan0}
SSID=${2:-batman-mesh}
FREQ=${3:-2437}

echo "Resetting wireless interface $INTERFACE..."

# Stop conflicting services (only if they exist)
sudo pkill wpa_supplicant 2>/dev/null || true
if systemctl is-active --quiet NetworkManager; then
    sudo systemctl stop NetworkManager
    echo "Stopped NetworkManager"
else
    echo "NetworkManager not running"
fi

# Take control from NetworkManager if it exists
if command -v nmcli >/dev/null 2>&1; then
    sudo nmcli device set $INTERFACE managed no 2>/dev/null || true
fi

# Reset interface
sudo iw $INTERFACE disconnect 2>/dev/null || true
sudo iw $INTERFACE ibss leave 2>/dev/null || true
sudo ip link set $INTERFACE down
sudo rfkill unblock wifi
sleep 2

# Configure for IBSS
sudo ip link set $INTERFACE up
sudo iw $INTERFACE set type ibss
sudo iw $INTERFACE ibss join $SSID $FREQ

echo "Interface status:"
iw $INTERFACE info
```

Save this as `fix-wireless.sh` and run: `chmod +x fix-wireless.sh && sudo ./fix-wireless.sh wlan0 oobnet 2412`

### Log Files
- Coordinator logs: `logs/coordinator.log`
- Node logs: `logs/node.log`
- System logs: `journalctl -u batman-coordinator`

### Network Debugging
```bash
# Check batman neighbors
sudo batctl n

# Check batman routing table
sudo batctl rt

# Check ZeroTier routes
ip route show

# Monitor traffic
sudo tcpdump -i bat0
```

## OS-Specific Notes

### Debian Buster
- Uses legacy iptables by default
- Requires batman-adv-dkms package
- May need wireless firmware updates

### Debian Bookworm
- Uses nftables by default (script handles both)
- Native batman-adv support
- Updated wireless stack

## Performance Tuning

### Batman-adv Parameters
```bash
# Optimize for mesh performance
echo 5000 > /sys/class/net/bat0/mesh/hop_penalty
echo 1000 > /sys/class/net/bat0/mesh/orig_interval
```

### ZeroTier Optimization
```bash
# Enable flow hashing for better performance
echo 'net.core.rps_sock_flow_entries = 32768' >> /etc/sysctl.conf
```

## Troubleshooting

### ZeroTier Connectivity Issues

### ZeroTier Connectivity Issues

#### Check Gateway Routing (New Approach)
```bash
# Test the new gateway routing configuration script
node test-gateway-routing.js

# Check gateway routing status
node test-gateway-routing.js --status

# Check if coordinator has NAT configured
sudo iptables -t nat -L POSTROUTING -n -v | grep MASQUERADE

# Check if node has default route via coordinator
ip route show | grep "default via 192.168.100.1 dev bat0"

# Check IP forwarding on coordinator
cat /proc/sys/net/ipv4/ip_forward

# Test internet connectivity through mesh
ping -c 3 8.8.8.8

# Check batman interface status
sudo batctl n
sudo batctl rt
```

#### Legacy Process-Based Routing (Old Approach)
```bash
# Test the old routing configuration script (deprecated)
node test-zerotier-routing.js

# Check for conflicting rules
node test-conflict-check.js

# Verify iptables marking rules (old method)
sudo iptables -t mangle -L OUTPUT -n -v | grep -E "(zerotier|9993|0x100)"

# Check custom routing table (old method)
ip route show table 100

# Verify IP rules (old method)
ip rule show | grep 0x100
```

#### Debug ZeroTier Routing
```bash
# Enable debug logging
LOG_LEVEL=debug npm run mesh-node

# Manual routing verification (try different marking methods)
# Method 1: UID-based (if zerotier-one user exists)
sudo iptables -t mangle -A OUTPUT -m owner --uid-owner $(id -u zerotier-one) -j MARK --set-mark 0x100

# Method 2: Port-based (fallback method)
sudo iptables -t mangle -A OUTPUT -p udp --dport 9993 -j MARK --set-mark 0x100

# Method 3: Interface-based (if ZeroTier interface identified)
sudo iptables -t mangle -A OUTPUT -o zt+ -j MARK --set-mark 0x100

# Setup routing table
ip rule add fwmark 0x100 table 100
ip route add default via 192.168.100.1 dev bat0 table 100
```

#### Common Issues
- **ZeroTier shows "[B.A.T.M.A.N." as node name**: Fixed in batman-adv output parsing
- **ZeroTier not connecting through mesh**: Check if process-based routing is configured
- **"unknown option --cmd-owner" error**: Fixed by using UID/port-based marking instead
- **Missing iptables rules**: Ensure script runs with root privileges
- **Custom routing table empty**: Verify batman interface has valid gateway IP
- **ZeroTier UID not found**: System falls back to port-based marking (UDP 9993)
- **Conflicting firewall rules**: Run `node test-conflict-check.js` to identify and clean up conflicts
- **DROP rules for port 9993**: Remove old SecurityManager rules that block ZeroTier

### Batman-adv Issues
```bash
# Check batman status
batctl meshif bat0 neighbors
batctl meshif bat0 originators

# Verify interface configuration
ip link show bat0
iw wlan1 info
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## License

MIT License - see LICENSE file for details

## Support

For issues and questions:
1. Check the troubleshooting section
2. Review logs for error messages
3. Open an issue with detailed information
