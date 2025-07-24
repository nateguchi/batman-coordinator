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

    async waitForMeshInterface() {
        logger.info(`Waiting for mesh interface ${this.meshInterface} to be ready...`);
        
        for (let i = 0; i < 30; i++) {
            try {
                // Check if interface exists and is up
                const output = await this.executeCommand(`ip link show ${this.meshInterface}`);
                if (output.includes('state UP')) {
                    // For wireless interfaces, also check if we're connected to ad-hoc network
                    try {
                        const iwOutput = await this.executeCommand(`iw ${this.meshInterface} info`);
                        if (iwOutput.includes('type IBSS')) {
                            logger.info(`Mesh interface ${this.meshInterface} is ready`);
                            return;
                        }
                    } catch (error) {
                        // Not a wireless interface or iw command failed
                        logger.info(`Mesh interface ${this.meshInterface} is ready (non-wireless)`);
                        return;
                    }
                }
            } catch (error) {
                // Interface not ready yet
            }
            
            logger.debug(`Waiting for mesh interface... attempt ${i + 1}/30`);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        throw new Error(`Mesh interface ${this.meshInterface} not ready after 30 seconds`);
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
            await this.executeCommand(`batctl meshif ${this.batmanInterface} interface del ${this.meshInterface} 2>/dev/null || true`);
            await this.executeCommand(`ip link delete ${this.batmanInterface} 2>/dev/null || true`);
            
            // Verify the mesh interface is up and ready
            await this.waitForMeshInterface();
            
            // Add mesh interface to batman-adv (use new syntax)
            await this.executeCommand(`batctl meshif ${this.batmanInterface} interface add ${this.meshInterface}`);
            
            // Wait for batman interface to be created
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            // Verify batman interface was created
            let batmanExists = false;
            for (let i = 0; i < 10; i++) {
                try {
                    await this.executeCommand(`ip link show ${this.batmanInterface}`);
                    batmanExists = true;
                    break;
                } catch (error) {
                    logger.debug(`Waiting for batman interface... attempt ${i + 1}`);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
            
            if (!batmanExists) {
                throw new Error(`Batman interface ${this.batmanInterface} was not created`);
            }
            
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
            
            // Wait a bit more for the mesh interface to be fully ready
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Check if batman interface exists before configuring
            try {
                await this.executeCommand(`ip link show ${this.batmanInterface}`);
            } catch (error) {
                logger.warn('Batman interface not ready, skipping optimization');
                return;
            }
            
            // Use batctl commands instead of direct sysfs writes (new syntax)
            try {
                await this.executeCommand(`batctl meshif ${this.batmanInterface} hop_penalty ${hopPenalty}`);
                logger.debug(`Set hop penalty to ${hopPenalty}`);
            } catch (error) {
                logger.warn('Failed to set hop penalty:', error.message);
            }
            
            try {
                await this.executeCommand(`batctl meshif ${this.batmanInterface} orig_interval ${origInterval}`);
                logger.debug(`Set originator interval to ${origInterval}`);
            } catch (error) {
                logger.warn('Failed to set orig interval:', error.message);
            }
            
            try {
                await this.executeCommand(`batctl meshif ${this.batmanInterface} distributed_arp_table 1`);
                logger.debug('Enabled distributed ARP table');
            } catch (error) {
                logger.warn('Failed to enable distributed ARP table:', error.message);
            }
            
            try {
                await this.executeCommand(`batctl meshif ${this.batmanInterface} bridge_loop_avoidance 1`);
                logger.debug('Enabled bridge loop avoidance');
            } catch (error) {
                logger.warn('Failed to enable bridge loop avoidance:', error.message);
            }
            
            // Configure gateway mode if this is the coordinator
            if (process.env.NODE_ENV !== 'node') {
                try {
                    await this.setupBatmanGateway();
                } catch (error) {
                    logger.warn('Failed to setup batman gateway:', error.message);
                }
            }
            
            logger.info('Batman-adv settings optimized');
            
        } catch (error) {
            logger.warn('Failed to optimize batman settings:', error);
        }
    }

    async setupBatmanGateway() {
        logger.info('Configuring batman-adv gateway mode...');
        
        try {
            // Set gateway mode to server (announces this node as gateway)
            await this.executeCommand(`batctl meshif ${this.batmanInterface} gw_mode server`);
            logger.debug('Set batman gateway mode to server');
            
            // Configure gateway bandwidth (optional - helps with gateway selection)
            const gwBandwidth = process.env.BATMAN_GW_BANDWIDTH || '10000/2000'; // 10Mbps down / 2Mbps up
            try {
                await this.executeCommand(`batctl meshif ${this.batmanInterface} gw_mode server ${gwBandwidth}`);
                logger.debug(`Set gateway bandwidth to ${gwBandwidth}`);
            } catch (error) {
                logger.debug('Failed to set gateway bandwidth (using default)');
            }
            
            // Enable IP forwarding for routing between mesh and internet
            await this.executeCommand('echo 1 > /proc/sys/net/ipv4/ip_forward');
            logger.debug('Enabled IP forwarding');
            
            // Setup NAT/masquerading for internet access
            await this.setupGatewayNAT();
            
            logger.info('Batman gateway configured successfully');
            
        } catch (error) {
            logger.error('Failed to setup batman gateway:', error);
            throw error;
        }
    }

    async setupGatewayNAT() {
        const ethernetInterface = process.env.ETHERNET_INTERFACE || 'eth0';
        
        try {
            // Clear any existing NAT rules for batman interface
            await this.executeCommand(`iptables -t nat -D POSTROUTING -s ${this.meshSubnet} -o ${ethernetInterface} -j MASQUERADE 2>/dev/null || true`);
            
            // Add NAT rule for mesh traffic going to internet
            await this.executeCommand(`iptables -t nat -A POSTROUTING -s ${this.meshSubnet} -o ${ethernetInterface} -j MASQUERADE`);
            logger.debug(`Added NAT rule for ${this.meshSubnet} via ${ethernetInterface}`);
            
            // Allow forwarding between batman interface and ethernet
            await this.executeCommand(`iptables -D FORWARD -i ${this.batmanInterface} -o ${ethernetInterface} -j ACCEPT 2>/dev/null || true`);
            await this.executeCommand(`iptables -D FORWARD -i ${ethernetInterface} -o ${this.batmanInterface} -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || true`);
            
            await this.executeCommand(`iptables -A FORWARD -i ${this.batmanInterface} -o ${ethernetInterface} -j ACCEPT`);
            await this.executeCommand(`iptables -A FORWARD -i ${ethernetInterface} -o ${this.batmanInterface} -m state --state RELATED,ESTABLISHED -j ACCEPT`);
            logger.debug(`Added forwarding rules between ${this.batmanInterface} and ${ethernetInterface}`);
            
            // Setup default route for mesh subnet (optional - helps mesh nodes find gateway)
            try {
                await this.executeCommand(`ip route add ${this.meshSubnet} dev ${this.batmanInterface} 2>/dev/null || true`);
            } catch (error) {
                // Route might already exist
            }
            
            logger.info('Gateway NAT configured successfully');
            
        } catch (error) {
            logger.error('Failed to setup gateway NAT:', error);
            throw error;
        }
    }

    async getBatmanNeighbors() {
        try {
            // Try new meshif command format first, fallback to old format
            let output;
            try {
                output = await this.executeCommand(`batctl meshif ${this.batmanInterface} neighbors`);
            } catch (error) {
                try {
                    output = await this.executeCommand(`batctl meshif ${this.batmanInterface} n`);
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
                const trimmedLine = line.trim();
                
                // Skip empty lines, header lines, and lines containing B.A.T.M.A.N.
                if (!trimmedLine || 
                    trimmedLine.includes('B.A.T.M.A.N.') ||
                    trimmedLine.includes('Neighbor') ||
                    trimmedLine.includes('Originator') ||
                    trimmedLine.includes('---') ||
                    trimmedLine.includes('IF') ||
                    trimmedLine.startsWith('[') ||
                    trimmedLine.includes('No batman nodes')) {
                    continue;
                }
                
                // Look for lines with MAC addresses (format: XX:XX:XX:XX:XX:XX)
                const macPattern = /([0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2})/;
                const match = trimmedLine.match(macPattern);
                
                if (match && trimmedLine.includes('(') && trimmedLine.includes(')')) {
                    const parts = trimmedLine.split(/\s+/);
                    if (parts.length >= 4) {
                        neighbors.push({
                            address: match[1], // Use the MAC address from regex match
                            lastSeen: parts[1],
                            quality: parts[2],
                            interface: parts[3]
                        });
                    }
                }
            }
            
            return neighbors;
            
        } catch (error) {
            logger.warn('Could not retrieve batman neighbors (may be normal if no other nodes):', error.message);
            return [];
        }
    }

    async getBatmanRoutes() {
        try {
            // Batman-adv doesn't have a "routes" table, use originators table instead
            let output;
            try {
                // Try new meshif command format for originators
                output = await this.executeCommand(`batctl meshif ${this.batmanInterface} originators`);
            } catch (error) {
                try {
                    output = await this.executeCommand(`batctl meshif ${this.batmanInterface} o`);
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
                const trimmedLine = line.trim();
                
                // Skip empty lines, header lines, and lines containing B.A.T.M.A.N.
                if (!trimmedLine || 
                    trimmedLine.includes('B.A.T.M.A.N.') ||
                    trimmedLine.includes('Originator') ||
                    trimmedLine.includes('---') ||
                    trimmedLine.includes('IF') ||
                    trimmedLine.startsWith('[') ||
                    trimmedLine.includes('No batman nodes')) {
                    continue;
                }
                
                // Look for lines with MAC addresses (format: XX:XX:XX:XX:XX:XX)
                const macPattern = /([0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2})/;
                const match = trimmedLine.match(macPattern);
                
                if (match && trimmedLine.includes('(') && trimmedLine.includes(')')) {
                    const parts = trimmedLine.split(/\s+/);
                    if (parts.length >= 4) {
                        routes.push({
                            originator: match[1], // Use the MAC address from regex match
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
            logger.warn('Could not retrieve batman originators (may be normal if no other nodes):', error.message);
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
                routes: routes,
                gatewayMode: await this.getGatewayMode()
            };
            
        } catch (error) {
            logger.error('Failed to get batman status:', error);
            return {
                active: false,
                error: error.message
            };
        }
    }

    async getGatewayMode() {
        try {
            const output = await this.executeCommand(`batctl meshif ${this.batmanInterface} gw_mode`);
            return output.trim();
        } catch (error) {
            try {
                // Try old syntax
                const output = await this.executeCommand(`batctl gw_mode`);
                return output.trim();
            } catch (error2) {
                return 'unknown';
            }
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
            // Clean up gateway NAT rules if this was a coordinator
            if (process.env.NODE_ENV !== 'node') {
                await this.cleanupGatewayNAT();
            }
            
            // Remove batman interface (use new syntax)
            await this.executeCommand(`batctl meshif ${this.batmanInterface} interface del ${this.meshInterface} 2>/dev/null || true`);
            await this.executeCommand(`ip link set down dev ${this.batmanInterface} 2>/dev/null || true`);
            
            // Reset wireless interface
            await this.executeCommand(`ip link set down dev ${this.meshInterface} 2>/dev/null || true`);
            await this.executeCommand(`iw ${this.meshInterface} ibss leave 2>/dev/null || true`);
            
            logger.info('Network cleanup complete');
            
        } catch (error) {
            logger.error('Error during network cleanup:', error);
        }
    }

    async cleanupGatewayNAT() {
        const ethernetInterface = process.env.ETHERNET_INTERFACE || 'eth0';
        
        try {
            // Remove NAT rules
            await this.executeCommand(`iptables -t nat -D POSTROUTING -s ${this.meshSubnet} -o ${ethernetInterface} -j MASQUERADE 2>/dev/null || true`);
            
            // Remove forwarding rules
            await this.executeCommand(`iptables -D FORWARD -i ${this.batmanInterface} -o ${ethernetInterface} -j ACCEPT 2>/dev/null || true`);
            await this.executeCommand(`iptables -D FORWARD -i ${ethernetInterface} -o ${this.batmanInterface} -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || true`);
            
            logger.debug('Gateway NAT rules cleaned up');
            
        } catch (error) {
            logger.warn('Error cleaning up gateway NAT rules:', error.message);
        }
    }
}

module.exports = NetworkManager;
