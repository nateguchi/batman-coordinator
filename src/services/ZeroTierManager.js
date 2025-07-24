const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const axios = require('axios');
const logger = require('../utils/logger');

const execAsync = promisify(exec);

class ZeroTierManager {
    constructor() {
        this.networkId = process.env.ZEROTIER_NETWORK_ID;
        this.authToken = process.env.ZEROTIER_AUTH_TOKEN;
        this.allowedSubnets = (process.env.ALLOWED_ZEROTIER_SUBNETS || '').split(',').filter(s => s.trim());
        this.zerotierInterface = null;
        this.containerName = 'zerotier-batman';
        this.dockerNetworkName = 'batman-zerotier';
    }

    async executeCommand(command, options = {}) {
        try {
            logger.debug(`Executing ZeroTier command: ${command}`);
            const { stdout, stderr } = await execAsync(command, { timeout: 30000, ...options });
            if (stderr && !options.ignoreStderr && !command.includes('2>/dev/null')) {
                // Ignore common expected stderr messages
                if (!stderr.includes('not a dynamic executable') && 
                    !stderr.includes('No such file or directory') &&
                    !stderr.includes('cannot access')) {
                    logger.warn(`ZeroTier command stderr: ${stderr}`);
                }
            }
            return stdout.trim();
        } catch (error) {
            // Don't log errors for commands that are expected to potentially fail
            if (!command.includes('2>/dev/null') && !command.includes('|| true')) {
                logger.error(`ZeroTier command failed: ${command}`, error);
            } else {
                logger.debug(`ZeroTier command failed (expected): ${command} - ${error.message}`);
            }
            throw error;
        }
    }

    async initialize(config) {
        this.config = config;
        this.networkId = config && config.zerotier && config.zerotier.networkId;
        
        if (!this.networkId) {
            logger.warn('No ZeroTier network ID configured - ZeroTier will not be initialized');
            return;
        }
        
        logger.info(`Initializing ZeroTier with Docker isolation for network: ${this.networkId}`);
        
        try {
            // Check if Docker is available
            await this.checkDockerAvailability();
            
            // Disable system ZeroTier service to prevent conflicts
            await this.disableSystemZeroTier();
            
            // Configure using Docker + bridge networking
            await this.configureDockerBasedRouting();
            
            logger.info('✅ ZeroTier Docker isolation configured successfully');
            
        } catch (error) {
            logger.error('Failed to initialize ZeroTier:', error);
            throw error;
        }
    }
    
    async disableSystemZeroTier() {
        try {
            logger.info('Disabling system ZeroTier service...');
            
            // Stop and disable original ZeroTier service
            await this.executeCommand('systemctl stop zerotier-one 2>/dev/null || true');
            await this.executeCommand('systemctl disable zerotier-one 2>/dev/null || true');
            
            // Kill any running ZeroTier processes using multiple methods
            try {
                await this.executeCommand('pkill -f zerotier-one 2>/dev/null || true');
            } catch (error) {
                logger.debug('pkill failed, trying killall...');
                try {
                    await this.executeCommand('killall zerotier-one 2>/dev/null || true');
                } catch (error2) {
                    logger.debug('killall failed, trying ps + kill...');
                    try {
                        const pids = await this.executeCommand('pgrep -f zerotier-one 2>/dev/null || echo ""');
                        if (pids.trim()) {
                            await this.executeCommand(`kill -TERM ${pids.trim().split('\n').join(' ')} 2>/dev/null || true`);
                        }
                    } catch (error3) {
                        logger.debug('All process killing methods failed, continuing...');
                    }
                }
            }
            
            // Wait for processes to stop
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            logger.info('System ZeroTier service disabled');
            
        } catch (error) {
            logger.warn('Failed to disable system ZeroTier:', error.message);
        }
    }
    
    async checkDockerAvailability() {
        try {
            // Check if Docker is installed and running
            await this.executeCommand('docker --version');
            await this.executeCommand('docker info');
            
            logger.debug('Docker is available and running');
            
        } catch (error) {
            throw new Error('Docker is not available. Please install and start Docker first.');
        }
    }

    async configureDockerBasedRouting(batmanInterface = 'bat0') {
        try {
            logger.info('Setting up Docker-based ZeroTier isolation...');
            
            // 1. Create Docker network connected to batman interface
            await this.setupDockerNetwork(batmanInterface);
            
            // 2. Start ZeroTier container with proper networking
            await this.startZeroTierContainer();
            
            // 3. Join ZeroTier network and wait for readiness
            if (this.networkId) {
                await this.joinZeroTierNetwork();
                await this.waitForZeroTierReady();
            }
            
            logger.info('✅ Docker-based ZeroTier routing configured successfully');
            
        } catch (error) {
            logger.error('Failed to configure Docker-based routing:', error);
            throw error;
        }
    }

    async setupDockerNetwork(batmanInterface) {
        try {
            logger.debug('Setting up Docker network for ZeroTier...');
            
            // Remove existing network if it exists
            await this.executeCommand(`docker network rm ${this.dockerNetworkName} 2>/dev/null || true`);
            
            // Get batman interface subnet for Docker network  
            const batmanSubnet = await this.getBatmanSubnet(batmanInterface);
            
            // Create Docker bridge network that will be connected to batman
            await this.executeCommand(`docker network create --driver bridge --subnet=${batmanSubnet} ${this.dockerNetworkName}`);
            
            // Get the Docker bridge interface name by inspecting the network
            const dockerNetworkInfo = await this.executeCommand(`docker network inspect ${this.dockerNetworkName} --format '{{.Id}}'`);
            const bridgeInterface = `br-${dockerNetworkInfo.substring(0, 12)}`;
            
            logger.debug(`Docker bridge interface: ${bridgeInterface}`);
            
            // Connect Docker bridge to batman interface via host routing
            await this.setupBridgeRouting(bridgeInterface, batmanInterface);
            
            logger.debug('✅ Docker network setup complete');
            
        } catch (error) {
            logger.error('Failed to setup Docker network:', error);
            throw error;
        }
    }

    async getBatmanSubnet(batmanInterface) {
        try {
            // Get batman interface IP and calculate a non-conflicting subnet for Docker
            const batmanIp = await this.executeCommand(`ip route show dev ${batmanInterface} | head -1 | awk '{print $1}' || echo "172.30.0.0/16"`);
            
            // Use a different subnet that won't conflict
            // If batman is 192.168.100.0/24, use 172.31.0.0/16 for Docker
            return "172.31.0.0/16";
            
        } catch (error) {
            logger.warn('Could not determine batman subnet, using default');
            return "172.31.0.0/16";
        }
    }

    async setupBridgeRouting(dockerBridge, batmanInterface) {
        try {
            logger.debug('Setting up routing between Docker bridge and batman interface...');
            
            // Enable IP forwarding
            await this.executeCommand('echo 1 > /proc/sys/net/ipv4/ip_forward');
            
            // Get batman interface IP and network
            const batmanGateway = await this.executeCommand(`ip route show dev ${batmanInterface} | grep 'proto kernel' | awk '{print $1}' | head -1 || echo "192.168.100.0/24"`);
            const batmanGatewayIP = await this.executeCommand(`ip addr show ${batmanInterface} | grep 'inet ' | awk '{print $2}' | cut -d'/' -f1 || echo "192.168.100.1"`);
            
            logger.debug(`Batman network: ${batmanGateway}, Batman IP: ${batmanGatewayIP}`);
            
            // Block Docker containers from using default ethernet route
            await this.executeCommand(`iptables -I FORWARD 1 -s 172.31.0.0/16 ! -d ${batmanGateway} -j DROP 2>/dev/null || true`);
            
            // Allow traffic between Docker bridge and batman network only
            await this.executeCommand(`iptables -I FORWARD 1 -i ${dockerBridge} -o ${batmanInterface} -j ACCEPT 2>/dev/null || true`);
            await this.executeCommand(`iptables -I FORWARD 1 -i ${batmanInterface} -o ${dockerBridge} -j ACCEPT 2>/dev/null || true`);
            
            // NAT traffic from Docker containers through batman interface ONLY
            await this.executeCommand(`iptables -t nat -A POSTROUTING -s 172.31.0.0/16 -o ${batmanInterface} -j MASQUERADE 2>/dev/null || true`);
            
            // Set up custom routing table for Docker containers to force batman routing
            await this.setupDockerRouting(dockerBridge, batmanInterface, batmanGatewayIP);
            
            logger.debug('✅ Bridge routing setup complete - traffic forced through batman interface');
            
        } catch (error) {
            logger.error('Failed to setup bridge routing:', error);
            throw error;
        }
    }

    async setupDockerRouting(dockerBridge, batmanInterface, batmanGatewayIP) {
        try {
            logger.debug('Setting up custom routing for Docker containers...');
            
            // Add custom routing table for Docker traffic
            await this.executeCommand('echo "201 docker_batman" >> /etc/iproute2/rt_tables 2>/dev/null || true');
            
            // Remove any existing routes in the custom table
            await this.executeCommand('ip route flush table docker_batman 2>/dev/null || true');
            
            // Add default route for Docker containers through batman interface
            await this.executeCommand(`ip route add default via ${batmanGatewayIP} dev ${batmanInterface} table docker_batman`);
            
            // Add local network route
            await this.executeCommand(`ip route add 172.31.0.0/16 dev ${dockerBridge} table docker_batman`);
            
            // Add routing rule for Docker container traffic
            await this.executeCommand('ip rule del from 172.31.0.0/16 table docker_batman 2>/dev/null || true');
            await this.executeCommand('ip rule add from 172.31.0.0/16 table docker_batman priority 100');
            
            // Also add rule for traffic TO Docker containers that should route back through batman
            await this.executeCommand('ip rule del to 172.31.0.0/16 table docker_batman 2>/dev/null || true');
            await this.executeCommand('ip rule add to 172.31.0.0/16 table docker_batman priority 100');
            
            logger.debug('✅ Custom Docker routing table configured - all traffic will use batman interface');
            
        } catch (error) {
            logger.error('Failed to setup Docker routing:', error);
            throw error;
        }
    }

    async startZeroTierContainer() {
        try {
            logger.debug('Starting ZeroTier Docker container...');
            
            // Stop and remove existing container
            await this.executeCommand(`docker stop ${this.containerName} 2>/dev/null || true`);
            await this.executeCommand(`docker rm ${this.containerName} 2>/dev/null || true`);
            
            // Start ZeroTier container with privileged mode and custom network
            const dockerCmd = [
                'docker', 'run', '-d',
                '--name', this.containerName,
                '--network', this.dockerNetworkName,
                '--privileged',
                '--cap-add=NET_ADMIN',
                '--cap-add=SYS_ADMIN',
                '--device=/dev/net/tun',
                '-v', '/var/lib/zerotier-one:/var/lib/zerotier-one',
                'zerotier/zerotier:latest'
            ];
            
            await this.executeCommand(dockerCmd.join(' '));
            
            // Wait for container to start
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            // Verify container is running
            const containerStatus = await this.executeCommand(`docker ps --filter name=${this.containerName} --format "{{.Status}}"`);
            if (!containerStatus.includes('Up')) {
                throw new Error('ZeroTier container failed to start');
            }
            
            logger.debug('✅ ZeroTier container started successfully');
            
        } catch (error) {
            logger.error('Failed to start ZeroTier container:', error);
            throw error;
        }
    }

    async joinZeroTierNetwork() {
        try {
            logger.info(`Joining ZeroTier network ${this.networkId}...`);
            
            // Join the network inside the container
            const joinResult = await this.executeCommand(`docker exec ${this.containerName} zerotier-cli join ${this.networkId}`);
            logger.debug(`ZeroTier join result: ${joinResult}`);
            
        } catch (error) {
            logger.error('Failed to join ZeroTier network:', error);
            throw error;
        }
    }

    async waitForZeroTierReady(maxAttempts = 30) {
        logger.info('Waiting for ZeroTier network to be ready...');
        
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                // Check ZeroTier status inside container
                const infoOutput = await this.executeCommand(`docker exec ${this.containerName} zerotier-cli info`);
                logger.debug(`ZeroTier info (attempt ${attempt}): ${infoOutput}`);
                
                const networks = await this.getDockerZeroTierNetworks();
                logger.debug(`ZeroTier networks (attempt ${attempt}):`, networks);
                
                const targetNetwork = networks.find(n => n.id === this.networkId);
                
                if (targetNetwork && 
                    targetNetwork.status === 'OK' && 
                    targetNetwork.assignedAddresses.length > 0) {
                    logger.info(`ZeroTier network ready with IP: ${targetNetwork.assignedAddresses[0]}`);
                    this.zerotierInterface = targetNetwork.interface;
                    return targetNetwork;
                }
                
                if (targetNetwork) {
                    logger.debug(`⏳ ZeroTier network found but not ready yet (status: ${targetNetwork.status}, IPs: ${targetNetwork.assignedAddresses.length}), attempt ${attempt}/${maxAttempts}`);
                } else {
                    logger.debug(`⏳ ZeroTier network ${this.networkId} not found yet, attempt ${attempt}/${maxAttempts}`);
                }
                
                await new Promise(resolve => setTimeout(resolve, 2000));
                
            } catch (error) {
                logger.debug(`ZeroTier check failed on attempt ${attempt}:`, error.message);
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        
        throw new Error('ZeroTier network ready timeout - check network authorization on ZeroTier Central');
    }

    async getDockerZeroTierNetworks() {
        try {
            const output = await this.executeCommand(`docker exec ${this.containerName} zerotier-cli listnetworks`);
            logger.debug(`Raw ZeroTier listnetworks output: ${output}`);
            
            const networks = [];
            
            const lines = output.split('\n');
            for (const line of lines) {
                if (line.length > 0 && line.startsWith('200 listnetworks') && !line.includes('<nwid>')) {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length >= 7) {
                        networks.push({
                            id: parts[2],           // Network ID
                            name: parts[3] || '',   // Network name
                            mac: parts[4] || '',    // MAC address
                            status: parts[5],       // Status (OK, etc.)
                            type: parts[6],         // Type (PRIVATE/PUBLIC)
                            interface: parts[7] || '', // Interface name (ztuga3ckpj)
                            assignedAddresses: parts.slice(8) || [] // IP addresses
                        });
                    }
                }
            }
            
            return networks;
            
        } catch (error) {
            logger.error('Failed to get Docker ZeroTier networks:', error);
            return [];
        }
    }
    
    async getStatus() {
        try {
            // Check if Docker container is running
            const containerStatus = await this.executeCommand(`docker ps --filter name=${this.containerName} --format "{{.Status}}" 2>/dev/null || echo "not running"`);
            
            if (!containerStatus.includes('Up')) {
                return {
                    online: false,
                    networks: []
                };
            }
            
            const networks = await this.getDockerZeroTierNetworks();
            return {
                online: networks.length > 0 && networks.some(n => n.status === 'OK'),
                networks: networks
            };
            
        } catch (error) {
            logger.error('Failed to get ZeroTier status:', error);
            return {
                online: false,
                networks: []
            };
        }
    }
    
    async reconnect() {
        try {
            logger.info('Attempting to reconnect ZeroTier...');
            
            // Check if container is still running
            const containerStatus = await this.executeCommand(`docker ps --filter name=${this.containerName} --format "{{.Status}}" 2>/dev/null || echo "not running"`);
            
            if (containerStatus.includes('Up')) {
                logger.debug('ZeroTier container still running, checking network status...');
                const status = await this.getStatus();
                if (status.online) {
                    logger.info('ZeroTier reconnection successful');
                    return;
                }
            }
            
            // If container died or not connected, restart it
            logger.info('Restarting ZeroTier Docker setup...');
            await this.cleanupDockerRouting();
            await this.configureDockerBasedRouting();
            
        } catch (error) {
            logger.error('Failed to reconnect ZeroTier:', error);
            throw error;
        }
    }

    async cleanupDockerRouting() {
        try {
            logger.info('Cleaning up Docker-based routing...');
            
            // Stop and remove ZeroTier container
            await this.executeCommand(`docker stop ${this.containerName} 2>/dev/null || true`);
            await this.executeCommand(`docker rm ${this.containerName} 2>/dev/null || true`);
            
            // Remove Docker network
            await this.executeCommand(`docker network rm ${this.dockerNetworkName} 2>/dev/null || true`);
            
            // Clean up custom routing rules
            await this.executeCommand('ip rule del from 172.31.0.0/16 table docker_batman 2>/dev/null || true');
            await this.executeCommand('ip rule del to 172.31.0.0/16 table docker_batman 2>/dev/null || true');
            await this.executeCommand('ip route flush table docker_batman 2>/dev/null || true');
            
            // Clean up iptables rules (try to remove, ignore errors)
            await this.executeCommand('iptables -D FORWARD -s 172.31.0.0/16 ! -d 192.168.100.0/24 -j DROP 2>/dev/null || true');
            await this.executeCommand('iptables -D FORWARD -i br-* -o bat0 -j ACCEPT 2>/dev/null || true');
            await this.executeCommand('iptables -D FORWARD -i bat0 -o br-* -j ACCEPT 2>/dev/null || true');
            await this.executeCommand('iptables -t nat -D POSTROUTING -s 172.31.0.0/16 -o bat0 -j MASQUERADE 2>/dev/null || true');
            
            logger.info('✅ Docker routing cleanup completed');
            
        } catch (error) {
            logger.error('Failed to cleanup Docker routing:', error);
        }
    }

    async cleanup() {
        logger.info('Cleaning up ZeroTier...');
        
        try {
            // Clean up Docker-based routing
            await this.cleanupDockerRouting();
            
            logger.info('✅ ZeroTier cleanup completed');
            
        } catch (error) {
            logger.error('Failed to cleanup ZeroTier:', error);
            // Don't throw on cleanup errors
        }
    }
}

module.exports = ZeroTierManager;
