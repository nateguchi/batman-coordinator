const path = require('path');
require('dotenv').config();

process.env.NODE_ENV = 'node';

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
            
            // Initialize configuration
            this.config = {
                zerotier: {
                    networkId: process.env.ZEROTIER_NETWORK_ID
                }
            };
            
            // Generate or get node ID
            this.nodeId = await this.generateNodeId();
            logger.info(`Node ID: ${this.nodeId}`);
            
            // Check if running as root (required for network configuration)
            if (process.getuid && process.getuid() !== 0) {
                throw new Error('Mesh node must run as root for network configuration');
            }
            
            // Setup network components
            logger.debug('Starting network setup...');
            await this.setupNetworking();
            logger.debug('Network setup complete');
            
            // Configure security
            logger.debug('Starting security setup...');
            await this.setupSecurity();
            logger.debug('Security setup complete');
            
            // Start monitoring and heartbeat
            logger.debug('Starting services...');
            await this.startServices();
            logger.debug('Services started');
            
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
            
            // Wait for batman mesh network to be ready
            logger.info('Waiting for batman mesh network to establish...');
            await this.waitForBatmanMeshReady();
            
            // Request IP assignment via DHCP from coordinator with retry logic
            const batmanInterface = 'bat0';
            await this.configureDHCPWithRetry(batmanInterface);
            
            // Test mesh connectivity to coordinator
            const canReachCoordinator = await this.testMeshConnectivity();
            if (canReachCoordinator) {
                logger.info('Mesh connectivity established to coordinator');
                
                // Now try to setup ZeroTier through the mesh
                try {
                    await this.zeroTierManager.initialize(this.config);
                    logger.info('✅ ZeroTier UID-based routing setup complete');
                    
                    this.zerotierConnected = true;
                    
                    await this.waitForZeroTierConnection();
                    logger.info('ZeroTier connected through mesh via UID-based routing');
                } catch (error) {
                    logger.warn('ZeroTier UID-based setup failed, continuing without it:', error.message);
                    // Continue without ZeroTier - mesh nodes can work without external connectivity
                }
            } else {
                logger.warn('No mesh connectivity to coordinator yet, skipping ZeroTier for now');
                // ZeroTier will be retried in the monitoring loop
            }
            
            logger.info('Network configuration complete');
            
        } catch (error) {
            logger.error('Network configuration failed:', error);
            throw error;
        }
    }

    async configureWirelessInterface() {
        const meshInterface = process.env.MESH_INTERFACE;
        const ssid = process.env.MESH_SSID;
        const frequency = process.env.MESH_FREQUENCY;
        
        logger.info(`Configuring ${meshInterface} for ad-hoc mode...`);
        
        try {
            // Step 1: Completely unmanage the interface
            await this.unmanageInterface(meshInterface);
            
            // Step 2: Configure for ad-hoc mode
            // Set interface down
            await this.networkManager.executeCommand(`ip link set ${meshInterface} down`);
            
            // Set to ad-hoc mode
            await this.networkManager.executeCommand(`iw ${meshInterface} set type ibss`);
            
            // Bring interface up
            await this.networkManager.executeCommand(`ip link set ${meshInterface} up`);
            
            // Join the ad-hoc network
            await this.networkManager.executeCommand(`iw ${meshInterface} ibss join ${ssid} ${frequency}`);
            
            // Wait longer for the interface to stabilize and connect
            logger.info('Waiting for ad-hoc network to stabilize...');
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            // Verify we're connected to the ad-hoc network
            try {
                const iwOutput = await this.networkManager.executeCommand(`iw ${meshInterface} info`);
                logger.debug(`Wireless interface status: ${iwOutput}`);
                
                if (!iwOutput.includes('type IBSS')) {
                    throw new Error('Interface not in IBSS (ad-hoc) mode');
                }
            } catch (error) {
                logger.warn('Could not verify wireless interface status:', error.message);
            }
            
            logger.info(`Wireless interface ${meshInterface} configured for ad-hoc mode`);
            
        } catch (error) {
            logger.error('Failed to configure wireless interface:', error);
            throw error;
        }
    }

    async unmanageInterface(interfaceName) {
        logger.info(`Unmanaging interface ${interfaceName} from all network managers...`);
        
        try {
            // First, disconnect from any existing networks on this specific interface
            await this.networkManager.executeCommand(`iw ${interfaceName} disconnect 2>/dev/null || true`);
            await this.networkManager.executeCommand(`iw ${interfaceName} ibss leave 2>/dev/null || true`);
            
            // Remove any existing IP addresses from this interface only
            await this.networkManager.executeCommand(`ip addr flush dev ${interfaceName} 2>/dev/null || true`);
            
            // Stop interface-specific wpa_supplicant services (don't kill global ones)
            try {
                await this.networkManager.executeCommand(`systemctl disable wpa_supplicant@${interfaceName} 2>/dev/null || true`);
                await this.networkManager.executeCommand(`systemctl stop wpa_supplicant@${interfaceName} 2>/dev/null || true`);
            } catch (error) {
                // Service doesn't exist
            }
            
            // Check if wpa_supplicant is running with this interface and kill only that instance
            try {
                const psOutput = await this.networkManager.executeCommand(`ps aux | grep "wpa_supplicant.*${interfaceName}" | grep -v grep || true`);
                if (psOutput.trim()) {
                    const pid = psOutput.trim().split(/\s+/)[1];
                    if (pid) {
                        await this.networkManager.executeCommand(`kill ${pid} 2>/dev/null || true`);
                        logger.debug(`Killed wpa_supplicant process for ${interfaceName} (PID: ${pid})`);
                    }
                }
            } catch (error) {
                // No specific wpa_supplicant process found
            }
            
            // Create NetworkManager ignore rule for this specific interface only
            try {
                const nmConfPath = '/etc/NetworkManager/conf.d/99-ignore-mesh.conf';
                const nmConfig = `[keyfile]\nunmanaged-devices=interface-name:${interfaceName}`;
                await this.networkManager.executeCommand(`echo '${nmConfig}' > ${nmConfPath} 2>/dev/null || true`);
                await this.networkManager.executeCommand('systemctl reload NetworkManager 2>/dev/null || true');
                logger.debug(`NetworkManager configured to ignore ${interfaceName}`);
            } catch (error) {
                // NetworkManager not available or no permission
            }
            
            // Remove systemd-networkd config for this interface only
            try {
                const networkdConfigPath = `/etc/systemd/network/10-${interfaceName}.network`;
                await this.networkManager.executeCommand(`rm -f ${networkdConfigPath} 2>/dev/null || true`);
                await this.networkManager.executeCommand('systemctl reload systemd-networkd 2>/dev/null || true');
            } catch (error) {
                // Not using systemd-networkd or no permission
            }
            
            // Stop dhcpcd only for this interface (don't stop global dhcpcd)
            try {
                await this.networkManager.executeCommand(`dhcpcd -k ${interfaceName} 2>/dev/null || true`);
                logger.debug(`Released DHCP lease for ${interfaceName}`);
            } catch (error) {
                // dhcpcd not running for this interface
            }
            
            // Set interface down to ensure clean state
            await this.networkManager.executeCommand(`ip link set ${interfaceName} down`);
            
            // Wait for interface to settle
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            logger.info(`Interface ${interfaceName} unmanaged successfully (other interfaces unaffected)`);
            
        } catch (error) {
            logger.warn('Some unmanage operations failed (may be normal):', error.message);
        }
    }

    async waitForZeroTierConnection() {
        const maxAttempts = 15; // Reduced from 30 to 15 seconds
        let attempts = 0;
        
        logger.info('Waiting for ZeroTier connection through mesh...');
        
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
                logger.debug(`ZeroTier connection attempt ${attempts + 1}/${maxAttempts} failed:`, error.message);
            }
            
            attempts++;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        throw new Error('ZeroTier connection timeout (mesh node can continue without external connectivity)');
    }

    async waitForBatmanMeshReady(maxAttempts = 30) {
        logger.info('Waiting for batman mesh network to establish...');
        
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                // Check if batman interface is up
                const batmanStatus = await this.networkManager.getBatmanStatus();
                if (!batmanStatus.active) {
                    logger.debug(`Batman interface not active yet, attempt ${attempt}/${maxAttempts}`);
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    continue;
                }
                
                // Check if we can see any batman neighbors (indicates mesh is working)
                const neighbors = await this.networkManager.getBatmanNeighbors();
                if (neighbors.length > 0) {
                    logger.info(`✅ Batman mesh ready with ${neighbors.length} neighbor(s) (attempt ${attempt})`);
                    // Give a little extra time for mesh to stabilize
                    await new Promise(resolve => setTimeout(resolve, 3000));
                    return;
                }
                
                logger.debug(`⏳ No batman neighbors found yet, waiting... attempt ${attempt}/${maxAttempts}`);
                await new Promise(resolve => setTimeout(resolve, 2000));
                
            } catch (error) {
                logger.debug(`Batman mesh check failed on attempt ${attempt}:`, error.message);
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        
        // If we get here, no neighbors were found but continue anyway
        logger.warn(`Batman mesh not ready after ${maxAttempts} attempts, continuing anyway...`);
        logger.warn('DHCP may fail if coordinator is not reachable through mesh');
    }

    async configureDHCPWithRetry(batmanInterface) {
        try {
            // Enable DHCP client on batman interface with retry loop
            // This will automatically configure IP, gateway, and routes
            logger.info(`Enabling DHCP client on ${batmanInterface} with 5-minute retry period`);
            
            // Release any existing DHCP lease
            await this.networkManager.executeCommand(`dhclient -r ${batmanInterface} 2>/dev/null || true`);
            
            // Retry dhclient over 5 minutes
            const maxRetries = 25; // 25 attempts over 5 minutes
            let dhcpSuccess = false;
            
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    logger.info(`DHCP attempt ${attempt}/${maxRetries} - requesting IP from coordinator...`);
                    
                    // Try dhclient with timeout (fallback if timeout command not available)
                    try {
                        await this.networkManager.executeCommand(`timeout 30s dhclient ${batmanInterface}`, { timeout: 35000 });
                    } catch (timeoutError) {
                        // Fallback if timeout command not available
                        logger.debug('timeout command not available, using dhclient without timeout');
                        await this.networkManager.executeCommand(`dhclient ${batmanInterface}`, { timeout: 35000 });
                    }
                    
                    // Check if we got an IP
                    const currentIP = await this.checkForDHCPIP(batmanInterface);
                    if (currentIP) {
                        logger.info(`✅ DHCP successful on attempt ${attempt}: IP ${currentIP}`);
                        dhcpSuccess = true;
                        break;
                    }
                    
                    logger.warn(`DHCP attempt ${attempt} failed - no IP assigned yet`);
                    
                } catch (error) {
                    logger.warn(`DHCP attempt ${attempt} failed:`, error.message);
                }
                
                if (attempt < maxRetries) {
                    // Wait 12 seconds between attempts (25 attempts × 12s = 5 minutes)
                    logger.debug(`Waiting 12 seconds before next DHCP attempt...`);
                    await new Promise(resolve => setTimeout(resolve, 12000));
                }
            }
            
            if (!dhcpSuccess) {
                throw new Error(`DHCP failed after ${maxRetries} attempts over 5 minutes`);
            }
            
            // Wait for DHCP to assign an IP address
            const nodeIP = await this.waitForDHCPIP(batmanInterface);
            logger.info(`Node received IP via DHCP: ${nodeIP}`);
            
        } catch (error) {
            logger.error('Failed to configure DHCP:', error);
            throw error;
        }
    }

    async checkForDHCPIP(batmanInterface) {
        try {
            const ipInfo = await this.networkManager.executeCommand(`ip addr show ${batmanInterface}`);
            
            // Look for inet address (IPv4)
            const ipMatch = ipInfo.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/);
            if (ipMatch) {
                return ipMatch[1];
            }
            
            return null;
            
        } catch (error) {
            logger.debug('Failed to check for DHCP IP:', error.message);
            return null;
        }
    }

    async waitForDHCPIP(batmanInterface, maxAttempts = 30) {
        logger.info(`Waiting for DHCP IP on ${batmanInterface}...`);
        
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const ip = await this.checkForDHCPIP(batmanInterface);
                if (ip) {
                    logger.info(`✅ Got DHCP IP: ${ip} on ${batmanInterface}`);
                    return ip;
                }
                
            } catch (error) {
                logger.debug(`DHCP IP check failed on attempt ${attempt}:`, error.message);
            }
            
            if (attempt < maxAttempts) {
                logger.debug(`⏳ No IP yet on ${batmanInterface}, attempt ${attempt}/${maxAttempts}, waiting...`);
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        
        throw new Error(`DHCP IP timeout on ${batmanInterface} after ${maxAttempts} attempts`);
    }

    async testMeshConnectivity() {
        try {
            const coordinatorIp = process.env.MASTER_IP || '192.168.100.1';
            logger.debug(`Testing mesh connectivity to coordinator at ${coordinatorIp}`);
            
            const ping = require('ping');
            const result = await ping.promise.probe(coordinatorIp, {
                timeout: 5000,
                min_reply: 1,
                extra: ['-c', '3'] // Send 3 pings
            });
            
            if (result.alive) {
                logger.info(`Mesh connectivity confirmed: ping to ${coordinatorIp} successful`);
                return true;
            } else {
                logger.debug(`No mesh connectivity: ping to ${coordinatorIp} failed`);
                return false;
            }
        } catch (error) {
            logger.debug('Mesh connectivity test failed:', error.message);
            return false;
        }
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
        // setInterval(async () => {
        //     try {
        //         await this.checkConnectivity();
        //     } catch (error) {
        //         logger.error('Connectivity check failed:', error);
        //     }
        // }, parseInt(process.env.NODE_CHECK_INTERVAL) || 30000);

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
                logger.warn('Batman interface not active, checking if restart is needed...');
                
                // Additional checks before restarting - don't be too aggressive
                try {
                    // Check if the interface exists at all
                    await this.networkManager.executeCommand(`ip link show ${this.networkManager.batmanInterface}`);
                    
                    // Check if we have any batman neighbors (indicates mesh is working)
                    const neighbors = await this.networkManager.getBatmanNeighbors();
                    if (neighbors.length > 0) {
                        logger.info('Batman neighbors found, interface appears to be working despite status check');
                        return; // Don't restart if we have neighbors
                    }
                    
                    // If interface exists but no neighbors, try a gentle restart
                    logger.info('No batman neighbors found, attempting gentle restart...');
                    
                    // Just try to bring the interface up instead of full restart
                    await this.networkManager.executeCommand(`ip link set ${this.networkManager.batmanInterface} up`);
                    
                    // Wait a bit and check again
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    const newStatus = await this.networkManager.getBatmanStatus();
                    if (!newStatus.active) {
                        logger.warn('Gentle restart failed, performing full batman restart...');
                        await this.networkManager.initializeBatman();
                    }
                    
                } catch (error) {
                    logger.error('Batman interface completely missing, performing full restart...');
                    await this.networkManager.initializeBatman();
                }
                
                return; // Skip other checks if batman was restarted
            }
            
            // Check mesh connectivity to coordinator
            const meshConnected = await this.testMeshConnectivity();
            if (!meshConnected) {
                logger.warn('No mesh connectivity to coordinator');
                return; // Skip ZeroTier checks if mesh is down
            }
            
            // Check ZeroTier connectivity (only if mesh is working)
            try {
                const zeroTierStatus = await this.zeroTierManager.getStatus();
                if (!zeroTierStatus.online) {
                    logger.debug('ZeroTier not online, attempting to reconnect through mesh...');
                    
                    // Debug routing state if needed
                    if (process.env.LOG_LEVEL === 'debug') {
                        await this.zeroTierManager.debugRoutingState();
                    }
                    
                    try {
                        await this.zeroTierManager.reconnect();
                    } catch (error) {
                        logger.debug('ZeroTier reconnect failed:', error.message);
                        // Try to initialize ZeroTier if it's not running
                        try {
                            await this.zeroTierManager.initialize(this.config);
                            logger.info('✅ ZeroTier reconnected with UID-based routing');
                        } catch (initError) {
                            logger.debug('ZeroTier initialization failed:', initError.message);
                        }
                    }
                }
            } catch (error) {
                // ZeroTier might not be available yet, that's okay for mesh nodes
                logger.debug('ZeroTier check failed (may be normal for mesh nodes):', error.message);
            }
            
            // Test internet connectivity through ZeroTier (optional)
            try {
                const canReachInternet = await this.testInternetConnectivity();
                if (!canReachInternet) {
                    logger.debug('No internet connectivity through ZeroTier (mesh node may not need it)');
                }
            } catch (error) {
                // Internet connectivity is optional for mesh nodes
                logger.debug('Internet connectivity test failed:', error.message);
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
            
            // Keep the process alive
            this.keepAlive();
            
        } catch (error) {
            logger.error('Failed to start mesh node:', error);
            process.exit(1);
        }
    }
    
    keepAlive() {
        // Keep the process running with a simple interval
        const keepAliveInterval = setInterval(() => {
            if (!this.isRunning) {
                clearInterval(keepAliveInterval);
                return;
            }
            // Just a simple heartbeat to keep process alive
            logger.debug('Mesh node heartbeat');
        }, 30000); // Every 30 seconds
        
        // Also keep process alive with unref'd timer
        const timer = setTimeout(() => {}, 2147483647); // Max timeout value
        timer.unref(); // Don't block process exit
    }

    async stop() {
        logger.info('Stopping mesh node...');
        this.isRunning = false;
        
        try {
            // Stop services
            if (this.heartbeat) {
                await this.heartbeat.stop();
            }
            
            // Cleanup ZeroTier UID-based routing configuration
            try {
                logger.info('Cleaning up ZeroTier UID-based routing configuration...');
                await this.zeroTierManager.cleanup();
            } catch (error) {
                logger.warn('Failed to cleanup ZeroTier:', error.message);
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
    // Add debug logging for startup
    console.log('Starting mesh node...');
    
    const node = new MeshNode();
    node.start().catch(error => {
        console.error('Failed to start mesh node:', error);
        logger.error('Failed to start mesh node:', error);
        process.exit(1);
    });
}

module.exports = MeshNode;
