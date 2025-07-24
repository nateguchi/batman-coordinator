const { exec } = require('child_process');
const { promisify } = require('util');
const ping = require('ping');
const logger = require('../utils/logger');

const execAsync = promisify(exec);

class NetworkManager {
    constructor() {
        this.meshInterface = process.env.MESH_INTERFACE || 'wlan1';
        this.batmanInterface = 'bat0';
        this.meshSubnet = process.env.MESH_SUBNET || '192.168.100.0/24';
        this.masterIp = process.env.MASTER_IP || '192.168.100.1';
    }

    async executeCommand(command, options = {}) {
        try {
            logger.debug(`Executing command: ${command}`);
            const { stdout, stderr } = await execAsync(command, { timeout: 30000, ...options });
            if (stderr && !options.ignoreStderr) {
                logger.warn(`Command stderr: ${stderr}`);
            }
            return stdout.trim();
        } catch (error) {
            logger.error(`Command failed: ${command}`, error);
            throw error;
        }
    }

    async getBatmanVersion() {
        try {
            // Try different version commands
            let version;
            try {
                version = await this.executeCommand('batctl -v');
            } catch (error) {
                try {
                    version = await this.executeCommand('batctl version');
                } catch (error2) {
                    version = 'unknown';
                }
            }
            return version;
        } catch (error) {
            logger.error('Failed to get batman version:', error);
            return 'unknown';
        }
    }

    async initializeBatman() {
        logger.info('Initializing batman-adv...');
        
        try {
            // Load batman-adv kernel module
            await this.executeCommand('modprobe batman-adv');
            
            // Remove any existing batman interface
            await this.executeCommand(`batctl if del ${this.meshInterface} 2>/dev/null || true`);
            await this.executeCommand(`ip link delete ${this.batmanInterface} 2>/dev/null || true`);
            
            // Add mesh interface to batman-adv
            await this.executeCommand(`batctl if add ${this.meshInterface}`);
            
            // Bring up batman interface
            await this.executeCommand(`ip link set up dev ${this.batmanInterface}`);
            
            // Configure batman interface IP (only on coordinator)
            if (process.env.NODE_ENV !== 'node') {
                await this.executeCommand(`ip addr add ${this.masterIp}/24 dev ${this.batmanInterface} 2>/dev/null || true`);
            }
            
            // Optimize batman-adv settings
            await this.optimizeBatmanSettings();
            
            logger.info('Batman-adv initialized successfully');
            
        } catch (error) {
            logger.error('Failed to initialize batman-adv:', error);
            throw error;
        }
    }

    async optimizeBatmanSettings() {
        try {
            const hopPenalty = process.env.BATMAN_HOP_PENALTY || '5000';
            const origInterval = process.env.BATMAN_ORIG_INTERVAL || '1000';
            
            // Set hop penalty for better route selection
            await this.executeCommand(`echo ${hopPenalty} > /sys/class/net/${this.batmanInterface}/mesh/hop_penalty`);
            
            // Set originator interval for faster topology updates
            await this.executeCommand(`echo ${origInterval} > /sys/class/net/${this.batmanInterface}/mesh/orig_interval`);
            
            // Enable distributed ARP table
            await this.executeCommand(`echo 1 > /sys/class/net/${this.batmanInterface}/mesh/distributed_arp_table`);
            
            // Enable bridge loop avoidance
            await this.executeCommand(`echo 1 > /sys/class/net/${this.batmanInterface}/mesh/bridge_loop_avoidance`);
            
            logger.info('Batman-adv settings optimized');
            
        } catch (error) {
            logger.warn('Failed to optimize batman settings:', error);
        }
    }

    async getBatmanNeighbors() {
        try {
            // Try new meshif command format first, fallback to old format
            let output;
            try {
                output = await this.executeCommand(`batctl ${this.batmanInterface} neighbors`);
            } catch (error) {
                try {
                    output = await this.executeCommand(`batctl ${this.batmanInterface} n`);
                } catch (error2) {
                    try {
                        // Try old format without meshif
                        output = await this.executeCommand('batctl neighbors');
                    } catch (error3) {
                        // Last resort - old single letter command
                        output = await this.executeCommand('batctl n');
                    }
                }
            }
            
            const neighbors = [];
            
            const lines = output.split('\n');
            for (const line of lines) {
                if (line.includes('(') && line.includes(')')) {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length >= 4) {
                        neighbors.push({
                            address: parts[0],
                            lastSeen: parts[1],
                            quality: parts[2],
                            interface: parts[3]
                        });
                    }
                }
            }
            
            return neighbors;
            
        } catch (error) {
            logger.error('Failed to get batman neighbors:', error);
            return [];
        }
    }

    async getBatmanRoutes() {
        try {
            // Batman-adv doesn't have a "routes" table, use originators table instead
            let output;
            try {
                // Try new meshif command format for originators
                output = await this.executeCommand(`batctl ${this.batmanInterface} originators`);
            } catch (error) {
                try {
                    output = await this.executeCommand(`batctl ${this.batmanInterface} o`);
                } catch (error2) {
                    try {
                        // Try old format without meshif
                        output = await this.executeCommand('batctl originators');
                    } catch (error3) {
                        // Last resort - old single letter command
                        output = await this.executeCommand('batctl o');
                    }
                }
            }
            
            const routes = [];
            
            const lines = output.split('\n');
            for (const line of lines) {
                if (line.includes('(') && line.includes(')')) {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length >= 4) {
                        routes.push({
                            originator: parts[0],
                            lastSeen: parts[1],
                            quality: parts[2],
                            nextHop: parts[3],
                            interface: parts[4] || 'unknown'
                        });
                    }
                }
            }
            
            return routes;
            
        } catch (error) {
            logger.error('Failed to get batman routes:', error);
            return [];
        }
    }

    async getBatmanStatus() {
        try {
            // Check if batman interface exists and is up
            const interfaceStatus = await this.executeCommand(`ip link show ${this.batmanInterface}`);
            const isUp = interfaceStatus.includes('state UP');
            
            // Check batman-adv version
            let version = 'unknown';
            try {
                version = await this.getBatmanVersion();
            } catch (error) {
                // Version check failed
            }
            
            // Get interface statistics
            const neighbors = await this.getBatmanNeighbors();
            const routes = await this.getBatmanRoutes();
            
            return {
                active: isUp,
                version: version,
                interface: this.batmanInterface,
                meshInterface: this.meshInterface,
                neighborCount: neighbors.length,
                routeCount: routes.length,
                neighbors: neighbors,
                routes: routes
            };
            
        } catch (error) {
            logger.error('Failed to get batman status:', error);
            return {
                active: false,
                error: error.message
            };
        }
    }

    async pingNode(address, timeout = 5000) {
        try {
            const result = await ping.promise.probe(address, {
                timeout: timeout,
                min_reply: 1
            });
            return result.alive;
        } catch (error) {
            logger.error(`Failed to ping ${address}:`, error);
            return false;
        }
    }

    async getInterfaceStats(interfaceName) {
        try {
            const rxBytes = await this.executeCommand(`cat /sys/class/net/${interfaceName}/statistics/rx_bytes`);
            const txBytes = await this.executeCommand(`cat /sys/class/net/${interfaceName}/statistics/tx_bytes`);
            const rxPackets = await this.executeCommand(`cat /sys/class/net/${interfaceName}/statistics/rx_packets`);
            const txPackets = await this.executeCommand(`cat /sys/class/net/${interfaceName}/statistics/tx_packets`);
            const rxErrors = await this.executeCommand(`cat /sys/class/net/${interfaceName}/statistics/rx_errors`);
            const txErrors = await this.executeCommand(`cat /sys/class/net/${interfaceName}/statistics/tx_errors`);
            
            return {
                interface: interfaceName,
                rxBytes: parseInt(rxBytes) || 0,
                txBytes: parseInt(txBytes) || 0,
                rxPackets: parseInt(rxPackets) || 0,
                txPackets: parseInt(txPackets) || 0,
                rxErrors: parseInt(rxErrors) || 0,
                txErrors: parseInt(txErrors) || 0,
                timestamp: new Date()
            };
            
        } catch (error) {
            logger.error(`Failed to get stats for ${interfaceName}:`, error);
            return null;
        }
    }

    async getWirelessInfo() {
        try {
            const iwconfig = await this.executeCommand(`iwconfig ${this.meshInterface}`);
            const info = {
                interface: this.meshInterface,
                mode: 'unknown',
                frequency: 'unknown',
                accessPoint: 'unknown',
                bitRate: 'unknown',
                signalLevel: 'unknown'
            };
            
            // Parse iwconfig output
            if (iwconfig.includes('Mode:')) {
                const modeMatch = iwconfig.match(/Mode:(\S+)/);
                if (modeMatch) info.mode = modeMatch[1];
            }
            
            if (iwconfig.includes('Frequency:')) {
                const freqMatch = iwconfig.match(/Frequency:(\S+)/);
                if (freqMatch) info.frequency = freqMatch[1];
            }
            
            if (iwconfig.includes('Access Point:')) {
                const apMatch = iwconfig.match(/Access Point: (\S+)/);
                if (apMatch) info.accessPoint = apMatch[1];
            }
            
            if (iwconfig.includes('Bit Rate')) {
                const rateMatch = iwconfig.match(/Bit Rate[=:](\S+)/);
                if (rateMatch) info.bitRate = rateMatch[1];
            }
            
            if (iwconfig.includes('Signal level')) {
                const signalMatch = iwconfig.match(/Signal level[=:](\S+)/);
                if (signalMatch) info.signalLevel = signalMatch[1];
            }
            
            return info;
            
        } catch (error) {
            logger.error('Failed to get wireless info:', error);
            return null;
        }
    }

    getStatus() {
        return {
            meshInterface: this.meshInterface,
            batmanInterface: this.batmanInterface,
            meshSubnet: this.meshSubnet,
            masterIp: this.masterIp
        };
    }

    async cleanup() {
        logger.info('Cleaning up network configuration...');
        
        try {
            // Remove batman interface
            await this.executeCommand(`batctl if del ${this.meshInterface} 2>/dev/null || true`);
            await this.executeCommand(`ip link set down dev ${this.batmanInterface} 2>/dev/null || true`);
            
            // Reset wireless interface
            await this.executeCommand(`ip link set down dev ${this.meshInterface} 2>/dev/null || true`);
            await this.executeCommand(`iw ${this.meshInterface} ibss leave 2>/dev/null || true`);
            
            logger.info('Network cleanup complete');
            
        } catch (error) {
            logger.error('Error during network cleanup:', error);
        }
    }
}

module.exports = NetworkManager;
