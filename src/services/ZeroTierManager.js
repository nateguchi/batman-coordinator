const { exec } = require('child_process');
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
    }

    async executeCommand(command, options = {}) {
        try {
            logger.debug(`Executing ZeroTier command: ${command}`);
            const { stdout, stderr } = await execAsync(command, { timeout: 30000, ...options });
            if (stderr && !options.ignoreStderr) {
                logger.warn(`ZeroTier command stderr: ${stderr}`);
            }
            return stdout.trim();
        } catch (error) {
            logger.error(`ZeroTier command failed: ${command}`, error);
            throw error;
        }
    }

    async initialize() {
        logger.info('Initializing ZeroTier...');
        
        try {
            // Check if ZeroTier service is running
            await this.ensureServiceRunning();
            
            // Join the network if not already joined
            if (this.networkId) {
                await this.joinNetwork(this.networkId);
                
                // Wait for network to be ready
                await this.waitForNetworkReady();
                
                // Get ZeroTier interface name
                this.zerotierInterface = await this.getZeroTierInterface();
                
                logger.info(`ZeroTier initialized with interface: ${this.zerotierInterface}`);
            } else {
                logger.warn('No ZeroTier network ID specified');
            }
            
        } catch (error) {
            logger.error('Failed to initialize ZeroTier:', error);
            throw error;
        }
    }

    async ensureServiceRunning() {
        try {
            // Check if zerotier service is running
            const status = await this.executeCommand('systemctl is-active zerotier-one', { ignoreStderr: true });
            
            if (status !== 'active') {
                logger.info('Starting ZeroTier service...');
                await this.executeCommand('systemctl start zerotier-one');
                
                // Wait for service to start
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
            
            // Verify the service is accessible
            await this.executeCommand('zerotier-cli status');
            
        } catch (error) {
            logger.error('Failed to ensure ZeroTier service is running:', error);
            throw error;
        }
    }

    async joinNetwork(networkId) {
        try {
            logger.info(`Joining ZeroTier network: ${networkId}`);
            
            // Check if already joined
            const networks = await this.getNetworks();
            const existingNetwork = networks.find(n => n.id === networkId);
            
            if (existingNetwork) {
                logger.info(`Already joined network ${networkId}`);
                return;
            }
            
            // Join the network
            await this.executeCommand(`zerotier-cli join ${networkId}`);
            
            logger.info(`Joined ZeroTier network: ${networkId}`);
            
        } catch (error) {
            logger.error(`Failed to join ZeroTier network ${networkId}:`, error);
            throw error;
        }
    }

    async waitForNetworkReady() {
        const maxAttempts = 60; // 60 seconds
        let attempts = 0;
        
        logger.info('Waiting for ZeroTier network to be ready...');
        
        while (attempts < maxAttempts) {
            try {
                const networks = await this.getNetworks();
                const targetNetwork = networks.find(n => n.id === this.networkId);
                
                if (targetNetwork && 
                    targetNetwork.status === 'OK' && 
                    targetNetwork.assignedAddresses.length > 0) {
                    logger.info(`ZeroTier network ready with IP: ${targetNetwork.assignedAddresses[0]}`);
                    return targetNetwork;
                }
                
            } catch (error) {
                // Continue trying
            }
            
            attempts++;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        throw new Error('ZeroTier network ready timeout');
    }

    async getStatus() {
        try {
            const statusOutput = await this.executeCommand('zerotier-cli status');
            const lines = statusOutput.split('\n');
            
            const status = {
                online: false,
                version: 'unknown',
                address: 'unknown',
                networks: []
            };
            
            // Parse status line
            if (lines.length > 0) {
                const statusLine = lines[0];
                status.online = statusLine.includes('ONLINE');
                
                const parts = statusLine.split(/\s+/);
                if (parts.length >= 3) {
                    status.address = parts[2];
                    status.version = parts[3];
                }
            }
            
            // Get network information
            status.networks = await this.getNetworks();
            
            return status;
            
        } catch (error) {
            logger.error('Failed to get ZeroTier status:', error);
            return {
                online: false,
                error: error.message
            };
        }
    }

    async getNetworks() {
        try {
            const output = await this.executeCommand('zerotier-cli listnetworks');
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
            logger.error('Failed to get ZeroTier networks:', error);
            return [];
        }
    }

    async getPeers() {
        try {
            const output = await this.executeCommand('zerotier-cli peers');
            const peers = [];
            
            const lines = output.split('\n');
            for (const line of lines) {
                if (line.length > 0 && line.startsWith('200 peers') && !line.includes('<ztaddr>')) {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length >= 6) {
                        peers.push({
                            address: parts[2],      // ZT address
                            version: parts[3],      // Version
                            latency: parts[4],      // Latency
                            role: parts[5],         // Role (PLANET, LEAF, etc.)
                            paths: parts.slice(6)   // Connection paths
                        });
                    }
                }
            }
            
            return peers;
            
        } catch (error) {
            logger.error('Failed to get ZeroTier peers:', error);
            return [];
        }
    }

    async getZeroTierInterface() {
        try {
            // First try to get from network list (more reliable)
            const networks = await this.getNetworks();
            if (networks.length > 0 && networks[0].interface) {
                return networks[0].interface;
            }
            
            // Fallback to parsing ip link output
            const interfaces = await this.executeCommand('ip link show | grep zt');
            const lines = interfaces.split('\n');
            
            for (const line of lines) {
                const match = line.match(/\d+:\s+(zt\w+):/);
                if (match) {
                    return match[1];
                }
            }
            
            return null;
            
        } catch (error) {
            logger.error('Failed to get ZeroTier interface:', error);
            return null;
        }
    }

    async getNetworkTrafficStats() {
        if (!this.zerotierInterface) {
            return null;
        }
        
        try {
            const rxBytes = await this.executeCommand(`cat /sys/class/net/${this.zerotierInterface}/statistics/rx_bytes`);
            const txBytes = await this.executeCommand(`cat /sys/class/net/${this.zerotierInterface}/statistics/tx_bytes`);
            const rxPackets = await this.executeCommand(`cat /sys/class/net/${this.zerotierInterface}/statistics/rx_packets`);
            const txPackets = await this.executeCommand(`cat /sys/class/net/${this.zerotierInterface}/statistics/tx_packets`);
            
            return {
                interface: this.zerotierInterface,
                rxBytes: parseInt(rxBytes) || 0,
                txBytes: parseInt(txBytes) || 0,
                rxPackets: parseInt(rxPackets) || 0,
                txPackets: parseInt(txPackets) || 0,
                timestamp: new Date()
            };
            
        } catch (error) {
            logger.error('Failed to get ZeroTier traffic stats:', error);
            return null;
        }
    }

    async reconnect() {
        logger.info('Attempting to reconnect ZeroTier...');
        
        try {
            // Restart ZeroTier service
            await this.executeCommand('systemctl restart zerotier-one');
            
            // Wait for service to restart
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            // Rejoin network if needed
            if (this.networkId) {
                await this.joinNetwork(this.networkId);
                await this.waitForNetworkReady();
            }
            
            logger.info('ZeroTier reconnected successfully');
            
        } catch (error) {
            logger.error('Failed to reconnect ZeroTier:', error);
            throw error;
        }
    }

    async authorizeNode(nodeId) {
        if (!this.authToken || !this.networkId) {
            throw new Error('ZeroTier auth token or network ID not configured');
        }
        
        try {
            const url = `https://my.zerotier.com/api/network/${this.networkId}/member/${nodeId}`;
            
            const response = await axios.post(url, {
                config: {
                    authorized: true,
                    ipAssignments: []
                }
            }, {
                headers: {
                    'Authorization': `Bearer ${this.authToken}`,
                    'Content-Type': 'application/json'
                }
            });
            
            logger.info(`Authorized ZeroTier node: ${nodeId}`);
            return response.data;
            
        } catch (error) {
            logger.error(`Failed to authorize ZeroTier node ${nodeId}:`, error);
            throw error;
        }
    }

    async getNetworkMembers() {
        if (!this.authToken || !this.networkId) {
            return [];
        }
        
        try {
            const url = `https://my.zerotier.com/api/network/${this.networkId}/member`;
            
            const response = await axios.get(url, {
                headers: {
                    'Authorization': `Bearer ${this.authToken}`
                }
            });
            
            return response.data;
            
        } catch (error) {
            logger.error('Failed to get ZeroTier network members:', error);
            return [];
        }
    }

    getNetworkId() {
        return this.networkId;
    }

    getInterface() {
        return this.zerotierInterface;
    }
}

module.exports = ZeroTierManager;
