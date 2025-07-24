const path = require('path');
require('dotenv').config();

const logger = require('./utils/logger');
const NetworkManager = require('./services/NetworkManager');
const ZeroTierManager = require('./services/ZeroTierManager');
const SecurityManager = require('./services/SecurityManager');
const NodeHeartbeat = require('./services/NodeHeartbeat');

class MeshNode {
    constructor() {
        this.networkManager = new NetworkManager();
        this.zeroTierManager = new ZeroTierManager();
        this.securityManager = new SecurityManager({
            batmanInterface: 'bat0',
            meshInterface: process.env.MESH_INTERFACE || 'wlan1',
            ethernetInterface: process.env.ETHERNET_INTERFACE || 'eth1',
            disableSystemHardening: process.env.DISABLE_SYSTEM_HARDENING === 'true',
            isCoordinator: false // Regular mesh nodes don't need NAT
        });
        this.heartbeat = new NodeHeartbeat();
        
        this.isRunning = false;
        this.nodeId = null;
    }

    async initialize() {
        try {
            logger.info('Initializing mesh node...');
            
            // Generate or get node ID
            this.nodeId = await this.generateNodeId();
            logger.info(`Node ID: ${this.nodeId}`);
            
            // Check if running as root (required for network configuration)
            if (process.getuid && process.getuid() !== 0) {
                throw new Error('Mesh node must run as root for network configuration');
            }
            
            // Setup network components
            await this.setupNetworking();
            
            // Configure security
            await this.setupSecurity();
            
            // Start monitoring and heartbeat
            await this.startServices();
            
            logger.info('Mesh node initialization complete');
            
        } catch (error) {
            logger.error('Failed to initialize mesh node:', error);
            throw error;
        }
    }

    async generateNodeId() {
        const os = require('os');
        const crypto = require('crypto');
        
        // Use MAC address and hostname to generate consistent ID
        const networkInterfaces = os.networkInterfaces();
        let macAddress = '';
        
        for (const [interfaceName, addresses] of Object.entries(networkInterfaces)) {
            for (const addr of addresses) {
                if (!addr.internal && addr.mac && addr.mac !== '00:00:00:00:00:00') {
                    macAddress = addr.mac;
                    break;
                }
            }
            if (macAddress) break;
        }
        
        const hostname = os.hostname();
        const nodeData = `${hostname}-${macAddress}`;
        return crypto.createHash('sha256').update(nodeData).digest('hex').substring(0, 16);
    }

    async setupNetworking() {
        logger.info('Configuring network interfaces...');
        
        try {
            // Bring down the mesh interface if it exists
            await this.networkManager.executeCommand(`ip link set ${process.env.MESH_INTERFACE} down || true`);
            
            // Configure wireless interface for ad-hoc mode
            await this.configureWirelessInterface();
            
            // Initialize batman-adv
            await this.networkManager.initializeBatman();
            
            // Setup ZeroTier
            await this.zeroTierManager.initialize();
            
            // Wait for ZeroTier to connect
            await this.waitForZeroTierConnection();
            
            logger.info('Network configuration complete');
            
        } catch (error) {
            logger.error('Network configuration failed:', error);
            throw error;
        }
    }

    async configureWirelessInterface() {
        const interface = process.env.MESH_INTERFACE;
        const ssid = process.env.MESH_SSID;
        const frequency = process.env.MESH_FREQUENCY;
        
        logger.info(`Configuring ${interface} for ad-hoc mode...`);
        
        try {
            // Kill any existing network managers that might interfere
            await this.networkManager.executeCommand('killall wpa_supplicant 2>/dev/null || true');
            await this.networkManager.executeCommand('killall dhcpcd 2>/dev/null || true');
            
            // Set interface down
            await this.networkManager.executeCommand(`ip link set ${interface} down`);
            
            // Set to ad-hoc mode
            await this.networkManager.executeCommand(`iw ${interface} set type ibss`);
            
            // Bring interface up
            await this.networkManager.executeCommand(`ip link set ${interface} up`);
            
            // Join the ad-hoc network
            await this.networkManager.executeCommand(`iw ${interface} ibss join ${ssid} ${frequency}`);
            
            // Wait a moment for the interface to stabilize
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            logger.info(`Wireless interface ${interface} configured for ad-hoc mode`);
            
        } catch (error) {
            logger.error('Failed to configure wireless interface:', error);
            throw error;
        }
    }

    async waitForZeroTierConnection() {
        const maxAttempts = 30; // 30 seconds
        let attempts = 0;
        
        logger.info('Waiting for ZeroTier connection...');
        
        while (attempts < maxAttempts) {
            try {
                const status = await this.zeroTierManager.getStatus();
                if (status.online && status.networks && status.networks.length > 0) {
                    const network = status.networks[0];
                    if (network.status === 'OK' && network.assignedAddresses.length > 0) {
                        logger.info(`ZeroTier connected with IP: ${network.assignedAddresses[0]}`);
                        return;
                    }
                }
            } catch (error) {
                // Continue trying
            }
            
            attempts++;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        throw new Error('ZeroTier connection timeout');
    }

    async setupSecurity() {
        logger.info('Configuring security rules...');
        
        try {
            // Setup firewall rules that only allow ZeroTier traffic
            await this.securityManager.setupFirewallRules();
            
            // Disable unnecessary services
            await this.securityManager.hardenSystem();
            
            logger.info('Security configuration complete');
            
        } catch (error) {
            logger.error('Security configuration failed:', error);
            throw error;
        }
    }

    async startServices() {
        logger.info('Starting node services...');
        
        try {
            // Start heartbeat service to coordinator
            await this.heartbeat.start(this.nodeId);
            
            // Start monitoring
            this.startMonitoring();
            
            logger.info('Node services started');
            
        } catch (error) {
            logger.error('Failed to start services:', error);
            throw error;
        }
    }

    startMonitoring() {
        // Monitor network connectivity
        setInterval(async () => {
            try {
                await this.checkConnectivity();
            } catch (error) {
                logger.error('Connectivity check failed:', error);
            }
        }, parseInt(process.env.NODE_CHECK_INTERVAL) || 30000);

        // Monitor system health
        setInterval(async () => {
            try {
                await this.checkSystemHealth();
            } catch (error) {
                logger.error('System health check failed:', error);
            }
        }, 60000); // Every minute
    }

    async checkConnectivity() {
        try {
            // Check batman-adv interface
            const batmanStatus = await this.networkManager.getBatmanStatus();
            if (!batmanStatus.active) {
                logger.warn('Batman interface not active, attempting to restart...');
                await this.networkManager.initializeBatman();
            }
            
            // Check ZeroTier connectivity
            const zeroTierStatus = await this.zeroTierManager.getStatus();
            if (!zeroTierStatus.online) {
                logger.warn('ZeroTier not online, checking connection...');
                await this.zeroTierManager.reconnect();
            }
            
            // Test internet connectivity through ZeroTier
            const canReachInternet = await this.testInternetConnectivity();
            if (!canReachInternet) {
                logger.warn('No internet connectivity through ZeroTier');
            }
            
        } catch (error) {
            logger.error('Connectivity check error:', error);
        }
    }

    async testInternetConnectivity() {
        try {
            const ping = require('ping');
            const result = await ping.promise.probe('8.8.8.8', {
                timeout: parseInt(process.env.PING_TIMEOUT) || 5000
            });
            return result.alive;
        } catch (error) {
            return false;
        }
    }

    async checkSystemHealth() {
        try {
            const si = require('systeminformation');
            
            // Check CPU usage
            const cpu = await si.currentLoad();
            if (cpu.currentLoad > 90) {
                logger.warn(`High CPU usage: ${cpu.currentLoad.toFixed(1)}%`);
            }
            
            // Check memory usage
            const mem = await si.mem();
            const memUsage = (mem.used / mem.total) * 100;
            if (memUsage > 90) {
                logger.warn(`High memory usage: ${memUsage.toFixed(1)}%`);
            }
            
            // Check disk usage
            const fsSize = await si.fsSize();
            for (const fs of fsSize) {
                if (fs.use > 90) {
                    logger.warn(`High disk usage on ${fs.fs}: ${fs.use}%`);
                }
            }
            
            // Check temperature (Raspberry Pi specific)
            try {
                const temp = await si.cpuTemperature();
                if (temp.main > 80) {
                    logger.warn(`High CPU temperature: ${temp.main}°C`);
                }
            } catch (error) {
                // Temperature monitoring not available
            }
            
        } catch (error) {
            logger.error('System health check error:', error);
        }
    }

    async start() {
        try {
            await this.initialize();
            this.isRunning = true;
            
            logger.info(`Mesh node ${this.nodeId} started successfully`);
            logger.info('Node is now part of the mesh network');
            
            // Keep the process running
            process.on('SIGINT', () => this.stop());
            process.on('SIGTERM', () => this.stop());
            
        } catch (error) {
            logger.error('Failed to start mesh node:', error);
            process.exit(1);
        }
    }

    async stop() {
        logger.info('Stopping mesh node...');
        this.isRunning = false;
        
        try {
            // Stop services
            if (this.heartbeat) {
                await this.heartbeat.stop();
            }
            
            // Cleanup network configuration
            await this.networkManager.cleanup();
            
            // Note: We don't cleanup security rules as they should persist
            
            logger.info('Mesh node stopped');
            process.exit(0);
            
        } catch (error) {
            logger.error('Error during node shutdown:', error);
            process.exit(1);
        }
    }
}

// Start the mesh node
if (require.main === module) {
    const node = new MeshNode();
    node.start().catch(error => {
        logger.error('Failed to start mesh node:', error);
        process.exit(1);
    });
}

module.exports = MeshNode;
