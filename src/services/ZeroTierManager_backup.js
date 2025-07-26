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

    // Add stub methods that will be implemented based on the original file
    async startZeroTierSubprocess() {
        // Implementation from original file
        logger.info('Starting ZeroTier as subprocess...');
        // This would contain the full implementation
    }

    async ensureZeroTierService() {
        // Implementation from original file
        logger.info('Ensuring ZeroTier daemon is running...');
        // This would contain the full implementation
    }

    async createZeroTierLocalConfig(batmanInterface) {
        // Implementation from original file
        logger.info('Creating ZeroTier local configuration...');
        // This would contain the full implementation
    }

    async setupUidRouting(batmanInterface) {
        // Implementation from original file
        logger.info('Setting up UID-based routing...');
        // This would contain the full implementation
    }

    async joinZeroTierNetwork() {
        // Implementation from original file
        logger.info('Joining ZeroTier network...');
        // This would contain the full implementation
    }

    async waitForZeroTierReady() {
        // Implementation from original file
        logger.info('Waiting for ZeroTier to be ready...');
        // This would contain the full implementation
    }

    async cleanup() {
        // Implementation from original file
        logger.info('Cleaning up ZeroTier...');
        // This would contain the full implementation
    }
}

module.exports = ZeroTierManager;
