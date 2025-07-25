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
        this.zerotierUid = 999; // zerotier-one user UID
        this.routingTable = 'batmanif';
        this.zerotierProcess = null;
        this.zerotierDataDir = '/var/lib/zerotier-one';
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
        
        logger.info(`Initializing ZeroTier with UID-based routing for network: ${this.networkId}`);
        
        try {
            // Disable system ZeroTier service to prevent conflicts
            await this.disableSystemZeroTier();
            
            // Configure using UID-based routing with subprocess
            await this.configureUidBasedRouting();
            
            logger.info('✅ ZeroTier UID-based routing configured successfully');
            
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
            
            // Start ZeroTier process as zerotier-one user
            logger.debug('Spawning ZeroTier subprocess...');
            this.zerotierProcess = spawn('sudo', [
                '-u', 'zerotier-one',
                '/usr/sbin/zerotier-one',  // Use full path
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
                logger.error(`ZeroTier process exited with code ${code}, signal ${signal}`);
                if (processOutput) {
                    logger.error(`ZeroTier stdout before exit: ${processOutput}`);
                }
                if (processErrors) {
                    logger.error(`ZeroTier stderr before exit: ${processErrors}`);
                }
                this.zerotierProcess = null;
            });
            
            this.zerotierProcess.on('error', (error) => {
                logger.error('ZeroTier process error:', error);
                this.zerotierProcess = null;
            });
            
            // Wait for ZeroTier to start
            await new Promise(resolve => setTimeout(resolve, 5000)); // Increased wait time
            
            // Verify process is running
            if (!this.zerotierProcess || this.zerotierProcess.killed) {
                throw new Error(`ZeroTier subprocess failed to start. Exit code: ${this.zerotierProcess?.exitCode}, Errors: ${processErrors}`);
            }
            
            // Test if ZeroTier is responding
            try {
                await this.executeCommand(`/usr/sbin/zerotier-cli -D${this.zerotierDataDir} info`);
                logger.info('✅ ZeroTier subprocess started and responding');
            } catch (error) {
                logger.warn('ZeroTier subprocess started but not responding to CLI yet');
                // Give it a bit more time
                await new Promise(resolve => setTimeout(resolve, 3000));
                
                try {
                    await this.executeCommand(`/usr/sbin/zerotier-cli -D${this.zerotierDataDir} info`);
                    logger.info('✅ ZeroTier subprocess now responding');
                } catch (retryError) {
                    throw new Error(`ZeroTier subprocess not responding: ${retryError.message}`);
                }
            }
            
        } catch (error) {
            logger.error('Failed to start ZeroTier subprocess:', error);
            throw error;
        }
    }

    async ensureZeroTierService() {
        try {
            logger.info('Ensuring ZeroTier subprocess is running...');
            
            // Check if our subprocess is still running
            if (this.zerotierProcess && !this.zerotierProcess.killed) {
                logger.debug('ZeroTier subprocess is already running');
                return;
            }
            
            // Start ZeroTier as subprocess
            await this.startZeroTierSubprocess();
            
        } catch (error) {
            logger.error('Failed to ensure ZeroTier subprocess:', error);
            throw error;
        }
    }

    async configureUidBasedRouting(batmanInterface = 'bat0') {
        try {
            logger.info('Setting up UID-based ZeroTier routing...');
            
            // 1. Ensure ZeroTier subprocess is running
            await this.ensureZeroTierService();
            
            // 2. Set up UID-based routing for zerotier-one process
            await this.setupUidRouting(batmanInterface);
            
            // 3. Join ZeroTier network if configured
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
            
            // Get batman interface IP to use as gateway and source
            const batmanIpWithMask = await this.executeCommand(`ip addr show ${batmanInterface} | grep 'inet ' | awk '{print $2}' | head -1`);
            const batmanGatewayIP = batmanIpWithMask.split('/')[0];
            
            // Validate IP address format
            if (!batmanGatewayIP || !batmanGatewayIP.match(/^\d+\.\d+\.\d+\.\d+$/)) {
                throw new Error(`Invalid batman gateway IP: ${batmanGatewayIP}`);
            }
            
            logger.debug(`Using batman IP: ${batmanGatewayIP} for routing table ${this.routingTable}`);
            
            // Add custom routing table entry to /etc/iproute2/rt_tables
            const tableEntry = `201 ${this.routingTable}`;
            try {
                const rtTables = await this.executeCommand('cat /etc/iproute2/rt_tables');
                if (!rtTables.includes(this.routingTable)) {
                    await this.executeCommand(`echo "${tableEntry}" >> /etc/iproute2/rt_tables`);
                }
            } catch (error) {
                logger.debug('Failed to read rt_tables, adding entry anyway');
                await this.executeCommand(`echo "${tableEntry}" >> /etc/iproute2/rt_tables 2>/dev/null || true`);
            }
            
            // Set up UID-based routing rule for zerotier-one process (UID 999)
            await this.executeCommand(`ip rule del uidrange ${this.zerotierUid}-${this.zerotierUid} lookup ${this.routingTable} 2>/dev/null || true`);
            await this.executeCommand(`ip rule add uidrange ${this.zerotierUid}-${this.zerotierUid} lookup ${this.routingTable}`);
            
            // Flush and configure the routing table
            await this.executeCommand(`ip route flush table ${this.routingTable}`);
            await this.executeCommand(`ip route add default via ${batmanGatewayIP} dev ${batmanInterface} src ${batmanGatewayIP} table ${this.routingTable}`);
            
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
            // Check if ZeroTier subprocess is running
            if (!this.zerotierProcess || this.zerotierProcess.killed) {
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
            
            // Check if subprocess is still running
            if (this.zerotierProcess && !this.zerotierProcess.killed) {
                logger.debug('ZeroTier subprocess still running, checking network status...');
                const status = await this.getStatus();
                if (status.online) {
                    logger.info('ZeroTier reconnection successful');
                    return;
                }
            }
            
            // If subprocess died or not connected, restart it
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
            // Stop ZeroTier subprocess
            if (this.zerotierProcess && !this.zerotierProcess.killed) {
                logger.debug('Stopping ZeroTier subprocess...');
                this.zerotierProcess.kill('SIGTERM');
                
                // Wait a bit for graceful shutdown
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                // Force kill if still running
                if (!this.zerotierProcess.killed) {
                    this.zerotierProcess.kill('SIGKILL');
                }
                
                this.zerotierProcess = null;
            }
            
            // Clean up UID-based routing
            await this.executeCommand(`ip rule del uidrange ${this.zerotierUid}-${this.zerotierUid} lookup ${this.routingTable} 2>/dev/null || true`);
            await this.executeCommand(`ip route flush table ${this.routingTable} 2>/dev/null || true`);
            
            logger.info('✅ ZeroTier cleanup completed');
            
        } catch (error) {
            logger.error('Failed to cleanup ZeroTier:', error);
            // Don't throw on cleanup errors
        }
    }
}

module.exports = ZeroTierManager;
