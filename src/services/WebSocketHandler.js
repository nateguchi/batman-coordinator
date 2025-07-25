const logger = require('../utils/logger');

class WebSocketHandler {
    constructor(io) {
        this.io = io;
        this.clients = new Map();
        this.services = {};
    }

    initialize(services) {
        this.services = services;
        this.setupSocketHandlers();
        logger.info('WebSocket handler initialized');
    }

    setupSocketHandlers() {
        this.io.on('connection', (socket) => {
            logger.info(`Client connected: ${socket.id}`);
            this.clients.set(socket.id, {
                socket: socket,
                connectedAt: new Date(),
                lastActivity: new Date()
            });

            // Send initial data
            this.sendInitialData(socket);

            // Handle client requests
            this.setupClientHandlers(socket);

            // Handle disconnection
            socket.on('disconnect', () => {
                logger.info(`Client disconnected: ${socket.id}`);
                this.clients.delete(socket.id);
            });
        });
    }

    setupClientHandlers(socket) {
        // Request current status
        socket.on('request-status', async () => {
            try {
                const status = await this.getSystemStatus();
                socket.emit('status-update', status);
                this.updateClientActivity(socket.id);
            } catch (error) {
                logger.error('Error sending status update:', error);
                socket.emit('error', { message: 'Failed to get status' });
            }
        });

        // Request node list
        socket.on('request-nodes', async () => {
            try {
                const nodes = Array.from(this.services.nodes.values());
                socket.emit('nodes-update', nodes);
                this.updateClientActivity(socket.id);
            } catch (error) {
                logger.error('Error sending nodes update:', error);
                socket.emit('error', { message: 'Failed to get nodes' });
            }
        });

        // Request stats
        socket.on('request-stats', async () => {
            try {
                const stats = this.services.statsCollector.getLatestStats();
                socket.emit('stats-update', stats);
                this.updateClientActivity(socket.id);
            } catch (error) {
                logger.error('Error sending stats update:', error);
                socket.emit('error', { message: 'Failed to get stats' });
            }
        });

        // Request performance metrics
        socket.on('request-performance', async (data) => {
            try {
                const minutes = data?.minutes || 60;
                const metrics = this.services.statsCollector.getPerformanceMetrics(minutes);
                socket.emit('performance-update', metrics);
                this.updateClientActivity(socket.id);
            } catch (error) {
                logger.error('Error sending performance metrics:', error);
                socket.emit('error', { message: 'Failed to get performance metrics' });
            }
        });

        // Request network topology
        socket.on('request-topology', async () => {
            try {
                const topology = await this.getNetworkTopology();
                socket.emit('topology-update', topology);
                this.updateClientActivity(socket.id);
            } catch (error) {
                logger.error('Error sending topology update:', error);
                socket.emit('error', { message: 'Failed to get topology' });
            }
        });

        // Request gateway status
        socket.on('request-gateway-status', async () => {
            try {
                const gatewayStatus = await this.services.networkManager.getBatmanStatus();
                socket.emit('gateway-status', {
                    ...gatewayStatus,
                    timestamp: new Date()
                });
                this.updateClientActivity(socket.id);
            } catch (error) {
                logger.error('Error sending gateway status:', error);
                socket.emit('error', { message: 'Failed to get gateway status' });
            }
        });

        // Node actions
        socket.on('node-action', async (data) => {
            try {
                const { nodeId, action } = data;
                if (!nodeId || !action) {
                    socket.emit('error', { message: 'Invalid node action request' });
                    return;
                }

                const result = await this.handleNodeAction(nodeId, action);
                socket.emit('node-action-result', {
                    nodeId,
                    action,
                    success: true,
                    result
                });
                this.updateClientActivity(socket.id);
            } catch (error) {
                logger.error('Error handling node action:', error);
                socket.emit('node-action-result', {
                    nodeId: data.nodeId,
                    action: data.action,
                    success: false,
                    error: error.message
                });
            }
        });

        // Subscribe to specific data streams
        socket.on('subscribe', (data) => {
            const { stream } = data;
            if (stream) {
                socket.join(stream);
                logger.debug(`Client ${socket.id} subscribed to ${stream}`);
            }
        });

        socket.on('unsubscribe', (data) => {
            const { stream } = data;
            if (stream) {
                socket.leave(stream);
                logger.debug(`Client ${socket.id} unsubscribed from ${stream}`);
            }
        });
    }

    async sendInitialData(socket) {
        try {
            // Send current system status
            const status = await this.getSystemStatus();
            socket.emit('status-update', status);

            // Send current nodes
            const nodes = Array.from(this.services.nodes.values());
            socket.emit('nodes-update', nodes);

            // Send latest stats
            const stats = this.services.statsCollector.getLatestStats();
            socket.emit('stats-update', stats);

            // Send network topology
            const topology = await this.getNetworkTopology();
            socket.emit('topology-update', topology);

            // Send gateway status
            const gatewayStatus = await this.services.networkManager.getBatmanStatus();
            socket.emit('gateway-status', {
                ...gatewayStatus,
                timestamp: new Date()
            });

        } catch (error) {
            logger.error('Error sending initial data:', error);
        }
    }

    async getSystemStatus() {
        const batmanStatus = await this.services.networkManager.getBatmanStatus();
        
        return {
            coordinator: {
                uptime: process.uptime(),
                nodeCount: this.services.nodes.size,
                clientCount: this.clients.size,
                isRunning: true,
                timestamp: new Date()
            },
            network: this.services.networkManager.getStatus(),
            batman: batmanStatus,
            zeroTier: this.services.zeroTierManager.getStatus(),
            summary: this.services.statsCollector.getSystemSummary()
        };
    }

    async getNetworkTopology() {
        try {
            const batmanStatus = await this.services.networkManager.getBatmanStatus();
            const nodes = Array.from(this.services.nodes.values());
            
            // Create a map of all known nodes from batman routes and registered nodes
            const nodeMap = new Map();
            
            // Add registered nodes
            nodes.forEach(node => {
                nodeMap.set(node.address, {
                    id: node.address, // Use address as ID for consistency
                    address: node.address,
                    status: node.status,
                    lastSeen: node.lastSeen,
                    type: node.id === 'coordinator' ? 'coordinator' : 'node',
                    source: 'registered',
                    name: node.name || node.id || node.address // Preserve original name/id as display name
                });
            });
            
            // Add coordinator
            const coordinatorAddress = process.env.MASTER_IP || '192.168.100.1';
            nodeMap.set(coordinatorAddress, {
                id: coordinatorAddress, // Use address as ID for consistency with links
                address: coordinatorAddress,
                status: 'online',
                lastSeen: new Date(),
                type: 'coordinator',
                source: 'coordinator',
                name: 'Coordinator' // Add a friendly name
            });
            
            // Add nodes discovered from batman routes/originators
            if (batmanStatus.routes) {
                batmanStatus.routes.forEach(route => {
                    // Add originator node if not already known
                    if (!nodeMap.has(route.originator)) {
                        nodeMap.set(route.originator, {
                            id: route.originator,
                            address: route.originator,
                            status: 'discovered',
                            lastSeen: route.lastSeen,
                            type: 'mesh-node',
                            source: 'batman-routes',
                            quality: route.quality
                        });
                    }
                    
                    // Add next hop node if different from originator
                    if (route.nextHop && route.nextHop !== route.originator && !nodeMap.has(route.nextHop)) {
                        nodeMap.set(route.nextHop, {
                            id: route.nextHop,
                            address: route.nextHop,
                            status: 'discovered',
                            lastSeen: route.lastSeen,
                            type: 'mesh-node',
                            source: 'batman-nexthop',
                            quality: route.quality
                        });
                    }
                });
            }
            
            // Add nodes from batman neighbors
            if (batmanStatus.neighbors) {
                batmanStatus.neighbors.forEach(neighbor => {
                    if (!nodeMap.has(neighbor.address)) {
                        nodeMap.set(neighbor.address, {
                            id: neighbor.address,
                            address: neighbor.address,
                            status: 'online',
                            lastSeen: neighbor.lastSeen,
                            type: 'mesh-node',
                            source: 'batman-neighbor'
                        });
                    }
                });
            }
            
            // Create links showing actual batman mesh topology
            const links = [];
            const linkMap = new Map(); // To avoid duplicate links
            
            // Add direct neighbor links (these are direct wireless connections)
            if (batmanStatus.neighbors) {
                batmanStatus.neighbors.forEach(neighbor => {
                    const linkId = `${coordinatorAddress}-${neighbor.address}`;
                    if (!linkMap.has(linkId)) {
                        links.push({
                            source: coordinatorAddress,
                            target: neighbor.address,
                            type: 'direct',
                            quality: neighbor.quality || 'unknown',
                            lastSeen: neighbor.lastSeen,
                            interface: neighbor.interface,
                            linkId: linkId
                        });
                        linkMap.set(linkId, true);
                    }
                });
            }
            
            // Add multi-hop routing links from batman routes
            if (batmanStatus.routes) {
                batmanStatus.routes.forEach(route => {
                    // Only add links where nextHop differs from originator (indicating multi-hop)
                    if (route.nextHop && route.nextHop !== route.originator) {
                        const linkId = `${route.nextHop}-${route.originator}`;
                        const reverseLinkId = `${route.originator}-${route.nextHop}`;
                        
                        // Avoid duplicate links (check both directions)
                        if (!linkMap.has(linkId) && !linkMap.has(reverseLinkId)) {
                            links.push({
                                source: route.nextHop,
                                target: route.originator,
                                type: 'multi-hop',
                                quality: route.quality,
                                lastSeen: route.lastSeen,
                                interface: route.interface,
                                isBestPath: route.isBestPath || false,
                                linkId: linkId
                            });
                            linkMap.set(linkId, true);
                        }
                    }
                });
            }
            
            // Create topology data structure
            const topology = {
                nodes: Array.from(nodeMap.values()),
                links: links,
                batman: {
                    neighbors: batmanStatus.neighbors || [],
                    routes: batmanStatus.routes || [],
                    neighborCount: batmanStatus.neighborCount || 0,
                    routeCount: batmanStatus.routeCount || 0
                },
                metadata: {
                    generated: new Date(),
                    nodeCount: nodeMap.size,
                    linkCount: links.length,
                    directLinks: links.filter(l => l.type === 'direct').length,
                    multiHopLinks: links.filter(l => l.type === 'multi-hop').length,
                    coordinatorAddress: coordinatorAddress,
                    registeredNodes: nodes.length,
                    discoveredNodes: Array.from(nodeMap.values()).filter(n => n.source !== 'registered').length
                }
            };

            // Log topology for debugging
            logger.debug('Generated topology:', {
                nodeCount: topology.nodes.length,
                linkCount: topology.links.length,
                coordinatorAddress,
                nodeIds: topology.nodes.map(n => n.id),
                linkSources: topology.links.map(l => l.source),
                linkTargets: topology.links.map(l => l.target)
            });

            console.log(topology);

            return topology;

        } catch (error) {
            logger.error('Error getting network topology:', error);
            return {
                nodes: [],
                links: [],
                batman: { neighbors: [], routes: [] },
                metadata: {
                    generated: new Date(),
                    error: error.message
                }
            };
        }
    }

    async handleNodeAction(nodeId, action) {
        const node = this.services.nodes.get(nodeId);
        if (!node) {
            throw new Error(`Node ${nodeId} not found`);
        }

        switch (action) {
            case 'ping':
                return await this.services.networkManager.pingNode(node.address);
                
            case 'restart':
                // This would require a way to communicate with nodes
                logger.info(`Restart request for node ${nodeId}`);
                return { message: 'Restart signal sent' };
                
            case 'disconnect':
                // Temporarily block the node
                await this.services.securityManager.blockNode(node.address);
                node.status = 'blocked';
                return { message: 'Node disconnected' };
                
            case 'reconnect':
                // Unblock the node
                await this.services.securityManager.unblockNode(node.address);
                node.status = 'online';
                return { message: 'Node reconnected' };
                
            default:
                throw new Error(`Unknown action: ${action}`);
        }
    }

    updateClientActivity(socketId) {
        const client = this.clients.get(socketId);
        if (client) {
            client.lastActivity = new Date();
        }
    }

    // Broadcast methods for sending updates to all clients
    broadcastNodeUpdate(nodes) {
        this.io.emit('nodes-update', nodes);
    }

    broadcastStats(stats) {
        this.io.emit('stats-update', stats);
        
        // Also send to specific subscribers
        this.io.to('stats').emit('stats-update', stats);
    }

    broadcastStatus(status) {
        this.io.emit('status-update', status);
    }

    broadcastTopology(topology) {
        this.io.emit('topology-update', topology);
        this.io.to('topology').emit('topology-update', topology);
    }

    broadcastAlert(alert) {
        this.io.emit('alert', {
            ...alert,
            timestamp: new Date()
        });
        
        logger.info(`Alert broadcasted: ${alert.type} - ${alert.message}`);
    }

    broadcastNodeStatus(nodeId, status) {
        this.io.emit('node-status-change', {
            nodeId,
            status,
            timestamp: new Date()
        });
    }

    // Send performance updates to subscribed clients
    broadcastPerformanceUpdate(metrics) {
        this.io.to('performance').emit('performance-update', metrics);
    }

    // Send gateway status updates
    broadcastGatewayStatus(gatewayStatus) {
        this.io.emit('gateway-status', {
            ...gatewayStatus,
            timestamp: new Date()
        });
        
        logger.debug('Gateway status broadcasted:', gatewayStatus);
    }

    // Send security alerts
    broadcastSecurityAlert(alert) {
        this.io.emit('security-alert', {
            ...alert,
            severity: alert.severity || 'warning',
            timestamp: new Date()
        });
        
        logger.warn(`Security alert: ${alert.message}`);
    }

    // Get connected clients info
    getClientInfo() {
        const clients = Array.from(this.clients.values()).map(client => ({
            id: client.socket.id,
            connectedAt: client.connectedAt,
            lastActivity: client.lastActivity,
            rooms: Array.from(client.socket.rooms)
        }));

        return {
            count: clients.length,
            clients: clients
        };
    }

    // Cleanup inactive clients
    cleanupInactiveClients() {
        const timeout = 30 * 60 * 1000; // 30 minutes
        const now = new Date();
        
        for (const [socketId, client] of this.clients) {
            if (now - client.lastActivity > timeout) {
                logger.info(`Disconnecting inactive client: ${socketId}`);
                client.socket.disconnect();
                this.clients.delete(socketId);
            }
        }
    }

    // Shutdown method
    shutdown() {
        logger.info('Shutting down WebSocket handler...');
        
        // Notify all clients
        this.io.emit('server-shutdown', {
            message: 'Server is shutting down',
            timestamp: new Date()
        });
        
        // Close all connections
        this.io.close();
        
        logger.info('WebSocket handler shutdown complete');
    }
}

module.exports = WebSocketHandler;
