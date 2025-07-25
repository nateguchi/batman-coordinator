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
        this.zerotierUid = null; // Will be detected dynamically
        this.routingTable = 'batmanif';
        this.zerotierProcess = null;
        this.zerotierDataDir = '/var/lib/zerotier-one';
    }

    async getZeroTierUid() {
        try {
            if (this.zerotierUid !== null) {
                return this.zerotierUid;
            }
            
            // Get the UID of the zerotier-one user
            const idOutput = await this.executeCommand('id -u zerotier-one');
            this.zerotierUid = parseInt(idOutput.trim());
            
            logger.debug(`Detected ZeroTier UID: ${this.zerotierUid}`);
            return this.zerotierUid;
            
        } catch (error) {
            logger.warn('Failed to get zerotier-one UID, using default 999:', error.message);
            this.zerotierUid = 999;
            return this.zerotierUid;
        }
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

    async initialize(config = {}) {
        this.config = config;
        
        logger.info(`Initializing ZeroTier for ${config.isCoordinator ? 'coordinator' : 'mesh node'} with network: ${this.networkId}`);
        
        try {
            // Disable system ZeroTier service to prevent conflicts
            await this.disableSystemZeroTier();
            
            // Configure based on role
            if (config.isCoordinator) {
                // Coordinator uses standard ZeroTier routing (all interfaces)
                logger.info('Coordinator mode: ZeroTier will use all available interfaces');
                // Still need to start ZeroTier daemon for network discovery and management
                await this.ensureZeroTierService();
                
                // Join ZeroTier network if configured
                if (this.networkId) {
                    await this.joinZeroTierNetwork();
                    await this.waitForZeroTierReady();
                }
            } else {
                // Mesh nodes use UID-based routing through batman mesh
                await this.configureUidBasedRouting();
            }
            
            logger.info('✅ ZeroTier configured successfully');
            
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
            
            // Kill any running ZeroTier processes
            await this.executeCommand('pkill -f zerotier-one 2>/dev/null || true');
            
            // Wait for processes to stop
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            logger.info('✅ System ZeroTier service disabled');
            
        } catch (error) {
            logger.warn('Failed to disable system ZeroTier:', error.message);
        }
    }

    async startZeroTierSubprocess() {
        try {
            logger.info('Starting ZeroTier as subprocess...');
            
            // Check if zerotier-one binary exists
            try {
                await this.executeCommand('test -x /usr/sbin/zerotier-one');
                logger.debug('ZeroTier binary found at /usr/sbin/zerotier-one');
            } catch (error) {
                // Try alternative path
                try {
                    await this.executeCommand('which zerotier-one');
                    logger.debug('ZeroTier binary found via which command');
                } catch (whichError) {
                    throw new Error('zerotier-one binary not found. Please install ZeroTier first.');
                }
            }
            
            // Ensure zerotier-one user exists
            try {
                const userInfo = await this.executeCommand('id zerotier-one');
                logger.debug(`ZeroTier user info: ${userInfo}`);
            } catch (error) {
                logger.info('Creating zerotier-one user...');
                await this.executeCommand('useradd -r -s /bin/false -d /var/lib/zerotier-one zerotier-one 2>/dev/null || true');
                
                // Verify user was created
                try {
                    await this.executeCommand('id zerotier-one');
                    logger.debug('ZeroTier user created successfully');
                } catch (verifyError) {
                    throw new Error('Failed to create zerotier-one user');
                }
            }
            
            // Ensure data directory exists and has correct permissions
            await this.executeCommand(`mkdir -p ${this.zerotierDataDir}`);
            await this.executeCommand(`chown zerotier-one:zerotier-one ${this.zerotierDataDir}`);
            await this.executeCommand(`chmod 700 ${this.zerotierDataDir}`);
            
            // Verify directory permissions
            const dirInfo = await this.executeCommand(`ls -la ${this.zerotierDataDir} | head -2`);
            logger.debug(`ZeroTier data directory info: ${dirInfo}`);
            
            // Start ZeroTier process as root (it will drop privileges automatically)
            logger.debug('Spawning ZeroTier subprocess...');
            this.zerotierProcess = spawn('/usr/sbin/zerotier-one', [
                '-d', this.zerotierDataDir
            ], {
                stdio: ['ignore', 'pipe', 'pipe'],
                detached: false
            });
            
            let processOutput = '';
            let processErrors = '';
            
            this.zerotierProcess.stdout.on('data', (data) => {
                const output = data.toString().trim();
                processOutput += output + '\n';
                logger.debug(`ZeroTier stdout: ${output}`);
            });
            
            this.zerotierProcess.stderr.on('data', (data) => {
                const error = data.toString().trim();
                processErrors += error + '\n';
                logger.warn(`ZeroTier stderr: ${error}`);
            });
            
            this.zerotierProcess.on('exit', (code, signal) => {
                // ZeroTier normally exits with code 0 after forking to run as zerotier-one user
                if (code === 0) {
                    logger.info('ZeroTier process exited normally after forking to zerotier-one user');
                } else {
                    logger.error(`ZeroTier process exited with code ${code}, signal ${signal}`);
                    if (processOutput) {
                        logger.error(`ZeroTier stdout before exit: ${processOutput}`);
                    }
                    if (processErrors) {
                        logger.error(`ZeroTier stderr before exit: ${processErrors}`);
                    }
                }
                this.zerotierProcess = null;
            });
            
            this.zerotierProcess.on('error', (error) => {
                logger.error('ZeroTier process error:', error);
                this.zerotierProcess = null;
            });
            
            // Wait for ZeroTier to start and fork
            await new Promise(resolve => setTimeout(resolve, 5000)); // Increased wait time
            
            // The original process will exit after forking, so we check if ZeroTier is responding
            // rather than checking if our original subprocess is still running
            logger.debug('Checking if ZeroTier daemon is responding after fork...');
            
            // Test if ZeroTier is responding
            try {
                await this.executeCommand(`/usr/sbin/zerotier-cli -D${this.zerotierDataDir} info`);
                logger.info('✅ ZeroTier daemon started and responding');
            } catch (error) {
                logger.warn('ZeroTier daemon not responding yet, giving it more time...');
                // Give it a bit more time
                await new Promise(resolve => setTimeout(resolve, 3000));
                
                try {
                    await this.executeCommand(`/usr/sbin/zerotier-cli -D${this.zerotierDataDir} info`);
                    logger.info('✅ ZeroTier daemon now responding');
                } catch (retryError) {
                    throw new Error(`ZeroTier daemon not responding: ${retryError.message}`);
                }
            }
            
        } catch (error) {
            logger.error('Failed to start ZeroTier subprocess:', error);
            throw error;
        }
    }

    async ensureZeroTierService() {
        try {
            logger.info('Ensuring ZeroTier daemon is running...');
            
            // Check if ZeroTier daemon is already running by testing CLI
            try {
                await this.executeCommand(`/usr/sbin/zerotier-cli -D${this.zerotierDataDir} info`);
                logger.debug('ZeroTier daemon is already running');
                return;
            } catch (error) {
                // Daemon not running, start it
                logger.debug('ZeroTier daemon not responding, starting it...');
            }
            
            // Start ZeroTier as subprocess
            await this.startZeroTierSubprocess();
            
        } catch (error) {
            logger.error('Failed to ensure ZeroTier daemon:', error);
            throw error;
        }
    }

    async createZeroTierLocalConfig(batmanInterface) {
        try {
            logger.debug('Creating ZeroTier local configuration...');
            
            // Get the batman interface IP
            const interfaceInfo = await this.executeCommand(`ip addr show ${batmanInterface}`);
            const ipMatch = interfaceInfo.match(/inet ([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)/);
            
            if (!ipMatch) {
                throw new Error(`Could not find IP address for ${batmanInterface}`);
            }
            
            const batmanIP = ipMatch[1];
            logger.debug(`Found batman interface IP: ${batmanIP}`);
            
            // Create the local.conf configuration
            const localConfig = {
                settings: {
                    allowSecondaryPort: false,
                    portMappingEnabled: false,
                    bind: [batmanIP],
                    interfacePrefixBlacklist: ["eth", "enp", "wlan", "lo", "docker", "br-"]
                }
            };
            
            // Ensure the ZeroTier directory exists
            await this.executeCommand('mkdir -p /var/lib/zerotier-one');
            
            // Write the configuration file
            const configContent = JSON.stringify(localConfig, null, 2);
            await this.executeCommand(`echo '${configContent}' > /var/lib/zerotier-one/local.conf`);
            
            logger.debug('✅ ZeroTier local configuration created successfully');
            
        } catch (error) {
            logger.error('Failed to create ZeroTier local configuration:', error);
            throw error;
        }
    }

    async configureCoordinatorRouting() {
        try {
            logger.info('Setting up standard ZeroTier routing for coordinator...');
            
            // 1. Ensure ZeroTier subprocess is running
            await this.ensureZeroTierService();
            
            // 2. Join ZeroTier network if configured
            if (this.networkId) {
                await this.joinZeroTierNetwork();
                await this.waitForZeroTierReady();
            }
            
            logger.info('✅ Coordinator ZeroTier routing configured successfully - using all interfaces');
            
        } catch (error) {
            logger.error('Failed to configure coordinator routing:', error);
            throw error;
        }
    }

    async configureUidBasedRouting(batmanInterface = 'bat0') {
        try {
            logger.info('Setting up UID-based ZeroTier routing...');
            
            // 1. Create ZeroTier local configuration to bind to batman interface
            await this.createZeroTierLocalConfig(batmanInterface);
            
            // 2. Set up UID-based routing for zerotier-one process
            await this.setupUidRouting(batmanInterface);

            // 3. Ensure ZeroTier subprocess is running
            await this.ensureZeroTierService();
            
            // 4. Join ZeroTier network if configured
            if (this.networkId) {
                await this.joinZeroTierNetwork();
                await this.waitForZeroTierReady();
            }
            
            logger.info('✅ UID-based ZeroTier routing configured successfully');
            
        } catch (error) {
            logger.error('Failed to configure UID-based routing:', error);
            throw error;
        }
    }

    async setupUidRouting(batmanInterface) {
        try {
            logger.debug('Setting up UID-based routing for ZeroTier...');
            
            // Get the actual UID of the zerotier-one user
            const zerotierUid = await this.getZeroTierUid();
            
            // Get batman interface IP to use as gateway and source
            const routes = await this.executeCommand('ip route');
            const routesList = routes.split('\n');
            const correctRoute = routesList.find((x)=>x.includes(batmanInterface) && x.includes('via'));
            console.log(routes, routesList, correctRoute);
            let batmanGatewayIP, batmanIP;
            try {
                let _res;
                [_res, batmanGatewayIP, batmanIP] = correctRoute.match(/default via ([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+).*?src ([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)/);
            } catch(e){
                let _res;
                [_res, batmanGatewayIP] = correctRoute.match(/default via ([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)/);
                // use the first IP from the batman interface
                batmanIP = (await this.executeCommand(`ip addr show ${batmanInterface} | grep 'inet ' | awk '{print $2}' | head -1`)).split('/')[0];
            }
            
            console.log(batmanGatewayIP, batmanIP);
            
            // Validate IP address format
            if (!batmanGatewayIP || !batmanGatewayIP.match(/^\d+\.\d+\.\d+\.\d+$/)) {
                throw new Error(`Invalid batman gateway IP: ${batmanGatewayIP}`);
            }
            
            logger.debug(`Using batman IP: ${batmanGatewayIP} for routing table ${this.routingTable}, UID: ${zerotierUid}`);
            
            // Add custom routing table entry to /etc/iproute2/rt_tables
            const tableEntry = `100 ${this.routingTable}`;
            try {
                const rtTables = await this.executeCommand('cat /etc/iproute2/rt_tables');
                if (!rtTables.includes(this.routingTable)) {
                    await this.executeCommand(`echo "${tableEntry}" >> /etc/iproute2/rt_tables`);
                }
            } catch (error) {
                logger.debug('Failed to read rt_tables, adding entry anyway');
                await this.executeCommand(`echo "${tableEntry}" >> /etc/iproute2/rt_tables 2>/dev/null || true`);
            }
            
            // Set up UID-based routing rule for zerotier-one process
            await this.executeCommand(`ip rule del uidrange ${zerotierUid}-${zerotierUid} lookup ${this.routingTable} 2>/dev/null || true`);
            await this.executeCommand(`ip rule add uidrange ${zerotierUid}-${zerotierUid} lookup ${this.routingTable}`);
            
            // Flush and configure the routing table
            try{
                await this.executeCommand(`ip route flush table ${this.routingTable}`);
            } catch(e){
                logger.warn('Failed to flush routing table, continuing anyway:', e.message);
            }
            await this.executeCommand(`ip route add default via ${batmanGatewayIP} dev ${batmanInterface} src ${batmanIP} table ${this.routingTable}`);
            
            logger.debug('✅ UID-based routing setup complete - ZeroTier traffic will use batman interface');
            
        } catch (error) {
            logger.error('Failed to setup UID routing:', error);
            throw error;
        }
    }

    async joinZeroTierNetwork() {
        try {
            logger.info(`Joining ZeroTier network ${this.networkId}...`);
            
            // Use zerotier-cli with the data directory to connect to our subprocess
            const joinResult = await this.executeCommand(`/usr/sbin/zerotier-cli -D${this.zerotierDataDir} join ${this.networkId}`);
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
                // Check ZeroTier status using zerotier-cli with data directory
                const infoOutput = await this.executeCommand(`/usr/sbin/zerotier-cli -D${this.zerotierDataDir} info`);
                logger.debug(`ZeroTier info (attempt ${attempt}): ${infoOutput}`);
                
                const networks = await this.getZeroTierNetworks();
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

    async getZeroTierNetworks() {
        try {
            const output = await this.executeCommand(`/usr/sbin/zerotier-cli -D${this.zerotierDataDir} listnetworks`);
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
            logger.error('Failed to get ZeroTier networks:', error);
            return [];
        }
    }
    
    async getStatus() {
        try {
            // Check if ZeroTier daemon is running by testing CLI
            try {
                await this.executeCommand(`/usr/sbin/zerotier-cli -D${this.zerotierDataDir} info`);
            } catch (error) {
                return {
                    online: false,
                    networks: []
                };
            }
            
            const networks = await this.getZeroTierNetworks();
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
            
            // Check if daemon is still running
            try {
                await this.executeCommand(`/usr/sbin/zerotier-cli -D${this.zerotierDataDir} info`);
                logger.debug('ZeroTier daemon still running, checking network status...');
                const status = await this.getStatus();
                if (status.online) {
                    logger.info('ZeroTier reconnection successful');
                    return;
                }
            } catch (error) {
                // Daemon not running
                logger.debug('ZeroTier daemon not responding');
            }
            
            // If daemon died or not connected, restart it
            logger.info('Restarting ZeroTier setup...');
            await this.cleanup();
            await this.configureUidBasedRouting();
            
        } catch (error) {
            logger.error('Failed to reconnect ZeroTier:', error);
            throw error;
        }
    }

    async cleanup() {
        logger.info('Cleaning up ZeroTier...');
        
        try {
            // Stop ZeroTier daemon properly
            try {
                logger.debug('Stopping ZeroTier daemon...');
                // First try to stop gracefully using zerotier-cli
                await this.executeCommand(`/usr/sbin/zerotier-cli -D${this.zerotierDataDir} terminate 2>/dev/null || true`);
                
                // Wait a bit for graceful shutdown
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                // If still running, kill zerotier-one processes
                await this.executeCommand('pkill -f zerotier-one 2>/dev/null || true');
                
                logger.debug('ZeroTier daemon stopped');
            } catch (error) {
                logger.debug('Error stopping ZeroTier daemon (may already be stopped):', error.message);
            }
            
            // Clean up subprocess reference if it exists
            if (this.zerotierProcess) {
                this.zerotierProcess = null;
            }
            
            // Clean up UID-based routing
            const zerotierUid = await this.getZeroTierUid();
            await this.executeCommand(`ip rule del uidrange ${zerotierUid}-${zerotierUid} lookup ${this.routingTable} 2>/dev/null || true`);
            await this.executeCommand(`ip route flush table ${this.routingTable} 2>/dev/null || true`);
            
            logger.info('✅ ZeroTier cleanup completed');
            
        } catch (error) {
            logger.error('Failed to cleanup ZeroTier:', error);
            // Don't throw on cleanup errors
        }
    }


    async getPeers() {
        try {
            const output = await this.executeCommand(`/usr/sbin/zerotier-cli -D${this.zerotierDataDir} peers`);
            logger.debug(`Raw ZeroTier peers output: ${output}`);
            
            const peers = [];
            
            const lines = output.split('\n');
            for (const line of lines) {
                if (line.length > 0 && line.startsWith('200 peers') && !line.includes('<ztaddr>')) {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length >= 4) {
                        peers.push({
                            address: parts[2],           // ZeroTier address
                            version: parts[3] || '',     // Version
                            latency: parts[4] || '',     // Latency
                            role: parts[5] || '',        // Role (LEAF, MOON, PLANET)
                            paths: parts.slice(6) || []  // Available paths
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
    
    async getNetworks() {
        // Alias for getZeroTierNetworks to maintain compatibility
        return await this.getZeroTierNetworks();
    }

    async getZeroTierNetworks() {
        try {
            const output = await this.executeCommand(`/usr/sbin/zerotier-cli -D${this.zerotierDataDir} listnetworks`);
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
            logger.error('Failed to get ZeroTier networks:', error);
            return [];
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
}

module.exports = ZeroTierManager;
