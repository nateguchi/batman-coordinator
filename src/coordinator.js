const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cron = require('node-cron');
require('dotenv').config();

const logger = require('./utils/logger');
const NetworkManager = require('./services/NetworkManager');
const ZeroTierManager = require('./services/ZeroTierManager');
const SecurityManager = require('./services/SecurityManager');
const StatsCollector = require('./services/StatsCollector');
const WebSocketHandler = require('./services/WebSocketHandler');

class Coordinator {
    constructor() {
        this.app = express();
        this.server = http.createServer(this.app);
        this.io = socketIo(this.server);
        
        this.networkManager = new NetworkManager();
        this.zeroTierManager = new ZeroTierManager();
        this.securityManager = new SecurityManager({
            batmanInterface: 'bat0',
            meshInterface: process.env.MESH_INTERFACE || 'wlan1',
            ethernetInterface: process.env.ETHERNET_INTERFACE || 'eth1',
            disableSystemHardening: process.env.DISABLE_SYSTEM_HARDENING === 'true',
            isCoordinator: true // Coordinator needs NAT for internet sharing
        });
        this.statsCollector = new StatsCollector();
        this.wsHandler = new WebSocketHandler(this.io);
        
        this.nodes = new Map();
        this.isRunning = false;
    }

    async initialize() {
        try {
            logger.info('Initializing Batman Mesh Coordinator...');
            
            // Setup express middleware
            this.setupMiddleware();
            
            // Setup routes
            this.setupRoutes();
            
            // Initialize network components
            await this.initializeNetworking();
            
            // Setup monitoring
            this.setupMonitoring();
            
            // Setup WebSocket handlers
            this.wsHandler.initialize({
                networkManager: this.networkManager,
                zeroTierManager: this.zeroTierManager,
                statsCollector: this.statsCollector,
                nodes: this.nodes
            });
            
            logger.info('Coordinator initialization complete');
            
        } catch (error) {
            logger.error('Failed to initialize coordinator:', error);
            throw error;
        }
    }

    setupMiddleware() {
        this.app.use(express.json());
        this.app.use(express.static(path.join(__dirname, '..', 'public')));
        
        // CORS for development
        this.app.use((req, res, next) => {
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
            next();
        });
    }

    setupRoutes() {
        // API Routes
        this.app.get('/api/status', (req, res) => {
            res.json({
                coordinator: {
                    uptime: process.uptime(),
                    nodeCount: this.nodes.size,
                    isRunning: this.isRunning
                },
                network: this.networkManager.getStatus(),
                zeroTier: this.zeroTierManager.getStatus()
            });
        });

        this.app.get('/api/nodes', (req, res) => {
            const nodeArray = Array.from(this.nodes.values());
            res.json(nodeArray);
        });

        this.app.get('/api/stats', (req, res) => {
            res.json(this.statsCollector.getLatestStats());
        });

        this.app.post('/api/nodes/:nodeId/action', async (req, res) => {
            const { nodeId } = req.params;
            const { action } = req.body;
            
            try {
                const result = await this.handleNodeAction(nodeId, action);
                res.json({ success: true, result });
            } catch (error) {
                logger.error(`Failed to execute action ${action} on node ${nodeId}:`, error);
                res.status(500).json({ success: false, error: error.message });
            }
        });

        // Node registration and heartbeat routes
        this.app.post('/api/nodes/register', (req, res) => {
            const nodeInfo = req.body;
            if (nodeInfo.nodeId) {
                this.nodes.set(nodeInfo.nodeId, {
                    ...nodeInfo,
                    status: 'online',
                    lastSeen: new Date()
                });
                logger.info(`Node registered: ${nodeInfo.nodeId}`);
            }
            res.json({ success: true });
        });

        this.app.post('/api/nodes/:nodeId/heartbeat', (req, res) => {
            const { nodeId } = req.params;
            const heartbeatData = req.body;
            
            if (this.nodes.has(nodeId)) {
                const node = this.nodes.get(nodeId);
                node.lastSeen = new Date();
                node.status = heartbeatData.status || 'online';
                node.stats = heartbeatData.system || {};
                this.nodes.set(nodeId, node);
            }
            
            res.json({ success: true });
        });

        this.app.post('/api/nodes/:nodeId/status', (req, res) => {
            const { nodeId } = req.params;
            const statusData = req.body;
            
            if (this.nodes.has(nodeId)) {
                const node = this.nodes.get(nodeId);
                Object.assign(node, statusData);
                this.nodes.set(nodeId, node);
            }
            
            res.json({ success: true });
        });

        this.app.post('/api/nodes/:nodeId/diagnostics', (req, res) => {
            const { nodeId } = req.params;
            const diagnostics = req.body;
            
            logger.info(`Diagnostics received from ${nodeId}:`, diagnostics);
            res.json({ success: true });
        });

        // Serve the web interface
        this.app.get('*', (req, res) => {
            res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
        });
    }

    async initializeNetworking() {
        logger.info('Setting up network infrastructure...');
        
        // Check if running as root
        if (process.getuid && process.getuid() !== 0) {
            logger.warn('Coordinator should run as root for full network management capabilities');
        }
        
        // Initialize batman-adv
        await this.networkManager.initializeBatman();
        
        // Setup ZeroTier
        await this.zeroTierManager.initialize();
        
        // Configure security rules
        await this.securityManager.setupFirewallRules();
        
        logger.info('Network infrastructure setup complete');
    }

    setupMonitoring() {
        // Node discovery and health monitoring
        cron.schedule('*/10 * * * * *', async () => {
            try {
                await this.discoverNodes();
                await this.updateNodeHealth();
                
                // Broadcast updates to connected clients
                this.wsHandler.broadcastNodeUpdate(Array.from(this.nodes.values()));
                
            } catch (error) {
                logger.error('Error in monitoring cycle:', error);
            }
        });

        // Stats collection
        cron.schedule('*/5 * * * * *', async () => {
            try {
                const stats = await this.statsCollector.collect();
                this.wsHandler.broadcastStats(stats);
            } catch (error) {
                logger.error('Error collecting stats:', error);
            }
        });

        // Security monitoring
        cron.schedule('*/30 * * * * *', async () => {
            try {
                await this.securityManager.monitorSecurity();
            } catch (error) {
                logger.error('Error in security monitoring:', error);
            }
        });
    }

    async discoverNodes() {
        try {
            const batmanNeighbors = await this.networkManager.getBatmanNeighbors();
            const zeroTierPeers = await this.zeroTierManager.getPeers();
            
            // Update known nodes
            for (const neighbor of batmanNeighbors) {
                const nodeId = neighbor.address;
                if (!this.nodes.has(nodeId)) {
                    const node = {
                        id: nodeId,
                        address: neighbor.address,
                        lastSeen: new Date(),
                        status: 'online',
                        batmanInfo: neighbor,
                        zeroTierInfo: null,
                        stats: {}
                    };
                    this.nodes.set(nodeId, node);
                    logger.info(`New node discovered: ${nodeId}`);
                }
            }
            
            // Update ZeroTier info for nodes
            for (const peer of zeroTierPeers) {
                for (const [nodeId, node] of this.nodes) {
                    if (node.address === peer.address) {
                        node.zeroTierInfo = peer;
                        break;
                    }
                }
            }
            
        } catch (error) {
            logger.error('Error discovering nodes:', error);
        }
    }

    async updateNodeHealth() {
        for (const [nodeId, node] of this.nodes) {
            try {
                const isReachable = await this.networkManager.pingNode(node.address);
                const now = new Date();
                
                if (isReachable) {
                    node.lastSeen = now;
                    node.status = 'online';
                } else {
                    const timeSinceLastSeen = now - node.lastSeen;
                    if (timeSinceLastSeen > 60000) { // 1 minute
                        node.status = 'offline';
                    } else {
                        node.status = 'warning';
                    }
                }
                
            } catch (error) {
                logger.error(`Error checking health for node ${nodeId}:`, error);
                node.status = 'error';
            }
        }
    }

    async handleNodeAction(nodeId, action) {
        const node = this.nodes.get(nodeId);
        if (!node) {
            throw new Error(`Node ${nodeId} not found`);
        }

        switch (action) {
            case 'ping':
                return await this.networkManager.pingNode(node.address);
            case 'restart':
                // Implementation would depend on having a way to communicate with nodes
                logger.info(`Restart request for node ${nodeId}`);
                return { message: 'Restart signal sent' };
            case 'disconnect':
                // Remove from allowed list temporarily
                await this.securityManager.blockNode(node.address);
                return { message: 'Node disconnected' };
            default:
                throw new Error(`Unknown action: ${action}`);
        }
    }

    async start() {
        try {
            await this.initialize();
            
            const port = process.env.COORDINATOR_PORT || 3000;
            const host = process.env.COORDINATOR_HOST || '0.0.0.0';
            
            this.server.listen(port, host, () => {
                this.isRunning = true;
                logger.info(`Batman Mesh Coordinator started on ${host}:${port}`);
                logger.info(`Web interface: http://${host}:${port}`);
            });
            
        } catch (error) {
            logger.error('Failed to start coordinator:', error);
            process.exit(1);
        }
    }

    async stop() {
        logger.info('Stopping coordinator...');
        this.isRunning = false;
        
        if (this.server) {
            this.server.close();
        }
        
        // Cleanup network configuration
        try {
            await this.networkManager.cleanup();
            await this.securityManager.cleanup();
        } catch (error) {
            logger.error('Error during cleanup:', error);
        }
        
        logger.info('Coordinator stopped');
    }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
    logger.info('Received SIGINT, shutting down gracefully...');
    if (global.coordinator) {
        await global.coordinator.stop();
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM, shutting down gracefully...');
    if (global.coordinator) {
        await global.coordinator.stop();
    }
    process.exit(0);
});

// Start the coordinator
if (require.main === module) {
    const coordinator = new Coordinator();
    global.coordinator = coordinator;
    coordinator.start().catch(error => {
        logger.error('Failed to start coordinator:', error);
        process.exit(1);
    });
}

module.exports = Coordinator;
