const axios = require('axios');
const logger = require('../utils/logger');

class NodeHeartbeat {
    constructor() {
        this.coordinatorUrl = null;
        this.nodeId = null;
        this.heartbeatInterval = null;
        this.isRunning = false;
        this.failureCount = 0;
        this.maxFailures = 5;
    }

    async start(nodeId) {
        this.nodeId = nodeId;
        this.isRunning = true;
        
        // Discover coordinator
        await this.discoverCoordinator();
        
        if (!this.coordinatorUrl) {
            logger.warn('Coordinator not found, running in standalone mode');
            return;
        }
        
        // Register with coordinator
        await this.registerWithCoordinator();
        
        // Start heartbeat
        this.startHeartbeat();
        
        logger.info(`Heartbeat service started for node ${nodeId}`);
    }

    async discoverCoordinator() {
        const possibleIPs = [
            process.env.MASTER_IP || '192.168.100.1',
            '10.147.0.1', // Common ZeroTier coordinator IP
            '192.168.1.1'  // Fallback
        ];
        
        const port = process.env.COORDINATOR_PORT || 3000;
        
        for (const ip of possibleIPs) {
            try {
                const url = `http://${ip}:${port}`;
                const response = await axios.get(`${url}/api/status`, { timeout: 5000 });
                
                if (response.status === 200 && response.data.coordinator) {
                    this.coordinatorUrl = url;
                    logger.info(`Coordinator discovered at ${url}`);
                    return;
                }
            } catch (error) {
                // Continue trying other IPs
            }
        }
        
        logger.warn('Could not discover coordinator');
    }

    async registerWithCoordinator() {
        if (!this.coordinatorUrl || !this.nodeId) {
            return;
        }
        
        try {
            const nodeInfo = await this.getNodeInfo();
            
            const response = await axios.post(`${this.coordinatorUrl}/api/nodes/register`, {
                nodeId: this.nodeId,
                ...nodeInfo
            }, { timeout: 10000 });
            
            if (response.status === 200) {
                logger.info('Successfully registered with coordinator');
            }
            
        } catch (error) {
            logger.error('Failed to register with coordinator:', error);
        }
    }

    async getNodeInfo() {
        try {
            const os = require('os');
            const si = require('systeminformation');
            
            const [cpu, mem, network] = await Promise.all([
                si.cpu(),
                si.mem(),
                si.networkInterfaces()
            ]);
            
            return {
                hostname: os.hostname(),
                platform: os.platform(),
                arch: os.arch(),
                uptime: os.uptime(),
                loadavg: os.loadavg(),
                cpu: {
                    manufacturer: cpu.manufacturer,
                    brand: cpu.brand,
                    cores: cpu.cores,
                    speed: cpu.speed
                },
                memory: {
                    total: mem.total,
                    free: mem.free,
                    used: mem.used
                },
                network: network.filter(iface => !iface.internal).map(iface => ({
                    name: iface.iface,
                    mac: iface.mac,
                    ip4: iface.ip4,
                    ip6: iface.ip6,
                    type: iface.type
                })),
                timestamp: new Date()
            };
            
        } catch (error) {
            logger.error('Failed to get node info:', error);
            return {
                hostname: require('os').hostname(),
                timestamp: new Date()
            };
        }
    }

    startHeartbeat() {
        const interval = parseInt(process.env.NODE_CHECK_INTERVAL) || 30000;
        
        this.heartbeatInterval = setInterval(async () => {
            await this.sendHeartbeat();
        }, interval);
        
        // Send initial heartbeat
        this.sendHeartbeat();
    }

    async sendHeartbeat() {
        if (!this.coordinatorUrl || !this.nodeId || !this.isRunning) {
            return;
        }
        
        try {
            const heartbeatData = await this.createHeartbeatData();
            
            const response = await axios.post(
                `${this.coordinatorUrl}/api/nodes/${this.nodeId}/heartbeat`,
                heartbeatData,
                { timeout: 5000 }
            );
            
            if (response.status === 200) {
                this.failureCount = 0;
                logger.debug('Heartbeat sent successfully');
                
                // Handle any coordinator responses
                this.handleCoordinatorResponse(response.data);
            }
            
        } catch (error) {
            this.failureCount++;
            logger.error(`Heartbeat failed (${this.failureCount}/${this.maxFailures}):`, error.message);
            
            if (this.failureCount >= this.maxFailures) {
                logger.warn('Maximum heartbeat failures reached, attempting to rediscover coordinator');
                await this.handleHeartbeatFailure();
            }
        }
    }

    async createHeartbeatData() {
        try {
            const si = require('systeminformation');
            
            const [cpu, mem, networkStats] = await Promise.all([
                si.currentLoad(),
                si.mem(),
                si.networkStats()
            ]);
            
            // Get batman and ZeroTier status
            const NetworkManager = require('./NetworkManager');
            const ZeroTierManager = require('./ZeroTierManager');
            
            const networkManager = new NetworkManager();
            const zeroTierManager = new ZeroTierManager();
            
            const [batmanStatus, zeroTierStatus] = await Promise.all([
                networkManager.getBatmanStatus().catch(() => ({})),
                zeroTierManager.getStatus().catch(() => ({}))
            ]);
            
            const heartbeatData = {
                nodeId: this.nodeId,
                timestamp: new Date(),
                status: 'online',
                system: {
                    cpu: {
                        usage: cpu.currentLoad || 0,
                        loadavg: require('os').loadavg()
                    },
                    memory: {
                        total: mem.total || 0,
                        used: mem.used || 0,
                        free: mem.free || 0,
                        usage: mem.total ? (mem.used / mem.total) * 100 : 0
                    },
                    uptime: process.uptime()
                },
                network: {
                    batman: batmanStatus,
                    zerotier: zeroTierStatus,
                    interfaces: networkStats
                }
            };

            console.log('Heartbeat data created:', heartbeatData);
            return heartbeatData;
            
        } catch (error) {
            logger.error('Failed to create heartbeat data:', error);
            return {
                nodeId: this.nodeId,
                timestamp: new Date(),
                status: 'online',
                error: error.message
            };
        }
    }

    handleCoordinatorResponse(data) {
        if (!data) return;
        
        // Handle coordinator commands
        if (data.commands) {
            for (const command of data.commands) {
                this.executeCommand(command);
            }
        }
        
        // Handle configuration updates
        if (data.config) {
            this.handleConfigUpdate(data.config);
        }
        
        // Handle status requests
        if (data.requestFullStatus) {
            this.sendFullStatus();
        }
    }

    async executeCommand(command) {
        logger.info(`Executing command from coordinator: ${command.type}`);
        
        try {
            switch (command.type) {
                case 'restart':
                    await this.restartNode();
                    break;
                    
                case 'update_config':
                    await this.updateConfiguration(command.config);
                    break;
                    
                case 'run_diagnostics':
                    await this.runDiagnostics();
                    break;
                    
                default:
                    logger.warn(`Unknown command type: ${command.type}`);
            }
            
        } catch (error) {
            logger.error(`Failed to execute command ${command.type}:`, error);
        }
    }

    async handleConfigUpdate(config) {
        logger.info('Received configuration update from coordinator');
        
        try {
            // Apply configuration changes
            if (config.heartbeatInterval) {
                this.updateHeartbeatInterval(config.heartbeatInterval);
            }
            
            // Other config updates would go here
            
        } catch (error) {
            logger.error('Failed to apply config update:', error);
        }
    }

    updateHeartbeatInterval(newInterval) {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }
        
        this.heartbeatInterval = setInterval(async () => {
            await this.sendHeartbeat();
        }, newInterval);
        
        logger.info(`Heartbeat interval updated to ${newInterval}ms`);
    }

    async sendFullStatus() {
        try {
            const fullStatus = await this.createHeartbeatData();
            
            await axios.post(
                `${this.coordinatorUrl}/api/nodes/${this.nodeId}/status`,
                fullStatus,
                { timeout: 10000 }
            );
            
            logger.debug('Full status sent to coordinator');
            
        } catch (error) {
            logger.error('Failed to send full status:', error);
        }
    }

    async handleHeartbeatFailure() {
        try {
            // Try to rediscover coordinator
            await this.discoverCoordinator();
            
            if (this.coordinatorUrl) {
                // Reset failure count and register again
                this.failureCount = 0;
                await this.registerWithCoordinator();
                logger.info('Reconnected to coordinator');
            } else {
                logger.warn('Could not rediscover coordinator, continuing in standalone mode');
            }
            
        } catch (error) {
            logger.error('Failed to handle heartbeat failure:', error);
        }
    }

    async restartNode() {
        logger.info('Restarting node by coordinator request...');
        
        // Graceful shutdown
        await this.stop();
        
        // Exit process - systemd or supervisor should restart it
        process.exit(0);
    }

    async runDiagnostics() {
        logger.info('Running diagnostics...');
        
        try {
            const diagnostics = {
                nodeId: this.nodeId,
                timestamp: new Date(),
                tests: {}
            };
            
            // Network connectivity test
            const ping = require('ping');
            diagnostics.tests.internet = await ping.promise.probe('8.8.8.8');
            
            // Batman status test
            const NetworkManager = require('./NetworkManager');
            const networkManager = new NetworkManager();
            diagnostics.tests.batman = await networkManager.getBatmanStatus();
            
            // ZeroTier status test
            const ZeroTierManager = require('./ZeroTierManager');
            const zeroTierManager = new ZeroTierManager();
            diagnostics.tests.zerotier = await zeroTierManager.getStatus();
            
            // Send diagnostics to coordinator
            await axios.post(
                `${this.coordinatorUrl}/api/nodes/${this.nodeId}/diagnostics`,
                diagnostics,
                { timeout: 10000 }
            );
            
            logger.info('Diagnostics completed and sent to coordinator');
            
        } catch (error) {
            logger.error('Diagnostics failed:', error);
        }
    }

    async stop() {
        logger.info('Stopping heartbeat service...');
        
        this.isRunning = false;
        
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
        
        // Send final heartbeat with offline status
        if (this.coordinatorUrl && this.nodeId) {
            try {
                await axios.post(
                    `${this.coordinatorUrl}/api/nodes/${this.nodeId}/heartbeat`,
                    {
                        nodeId: this.nodeId,
                        timestamp: new Date(),
                        status: 'offline'
                    },
                    { timeout: 5000 }
                );
            } catch (error) {
                // Ignore errors during shutdown
            }
        }
        
        logger.info('Heartbeat service stopped');
    }

    getStatus() {
        return {
            isRunning: this.isRunning,
            nodeId: this.nodeId,
            coordinatorUrl: this.coordinatorUrl,
            failureCount: this.failureCount,
            lastHeartbeat: this.lastHeartbeat
        };
    }
}

module.exports = NodeHeartbeat;
