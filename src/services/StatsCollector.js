const si = require('systeminformation');
const logger = require('../utils/logger');

class StatsCollector {
    constructor() {
        this.stats = {
            system: {},
            network: {},
            batman: {},
            zerotier: {},
            timestamp: new Date()
        };
        this.history = [];
        this.maxHistorySize = 100; // Keep last 100 readings
    }

    async collect() {
        try {
            const stats = {
                system: await this.collectSystemStats(),
                network: await this.collectNetworkStats(),
                batman: await this.collectBatmanStats(),
                zerotier: await this.collectZeroTierStats(),
                timestamp: new Date()
            };

            this.stats = stats;
            this.addToHistory(stats);

            return stats;

        } catch (error) {
            logger.error('Failed to collect stats:', error);
            return this.stats; // Return last known stats
        }
    }

    async collectSystemStats() {
        try {
            const [cpu, mem, load, temp, disk] = await Promise.all([
                si.currentLoad(),
                si.mem(),
                si.currentLoad(),
                si.cpuTemperature(),
                si.fsSize()
            ]);

            return {
                cpu: {
                    usage: cpu.currentLoad || 0,
                    user: cpu.currentLoadUser || 0,
                    system: cpu.currentLoadSystem || 0,
                    idle: cpu.currentLoadIdle || 0
                },
                memory: {
                    total: mem.total || 0,
                    used: mem.used || 0,
                    free: mem.free || 0,
                    available: mem.available || 0,
                    usage: mem.total ? (mem.used / mem.total) * 100 : 0
                },
                load: {
                    avg1: load.avgLoad || 0,
                    avg5: load.avgLoad5 || 0,
                    avg15: load.avgLoad15 || 0
                },
                temperature: {
                    cpu: temp.main || 0,
                    max: temp.max || 0
                },
                disk: disk.map(d => ({
                    filesystem: d.fs,
                    size: d.size || 0,
                    used: d.used || 0,
                    available: d.available || 0,
                    usage: d.use || 0,
                    mount: d.mount
                }))
            };

        } catch (error) {
            logger.error('Failed to collect system stats:', error);
            return {};
        }
    }

    async collectNetworkStats() {
        try {
            const networkInterfaces = await si.networkInterfaces();
            const networkStats = await si.networkStats();

            const interfaces = {};

            for (const iface of networkInterfaces) {
                const stats = networkStats.find(s => s.iface === iface.iface);
                
                interfaces[iface.iface] = {
                    name: iface.iface,
                    type: iface.type,
                    mtu: iface.mtu,
                    mac: iface.mac,
                    ip4: iface.ip4,
                    ip6: iface.ip6,
                    operstate: iface.operstate,
                    speed: iface.speed,
                    stats: stats ? {
                        rxBytes: stats.rx_bytes || 0,
                        txBytes: stats.tx_bytes || 0,
                        rxPackets: stats.rx_packets || 0,
                        txPackets: stats.tx_packets || 0,
                        rxErrors: stats.rx_errors || 0,
                        txErrors: stats.tx_errors || 0,
                        rxDropped: stats.rx_dropped || 0,
                        txDropped: stats.tx_dropped || 0
                    } : null
                };
            }

            return { interfaces };

        } catch (error) {
            logger.error('Failed to collect network stats:', error);
            return {};
        }
    }

    async collectBatmanStats() {
        try {
            const NetworkManager = require('./NetworkManager');
            const networkManager = new NetworkManager();

            const [status, neighbors, routes] = await Promise.all([
                networkManager.getBatmanStatus(),
                networkManager.getBatmanNeighbors(),
                networkManager.getBatmanRoutes()
            ]);

            // Calculate mesh health metrics
            const meshHealth = this.calculateMeshHealth(neighbors, routes);

            return {
                status: status,
                neighbors: neighbors,
                routes: routes,
                health: meshHealth,
                metrics: {
                    neighborCount: neighbors.length,
                    routeCount: routes.length,
                    avgQuality: this.calculateAverageQuality(neighbors),
                    connectivity: meshHealth.connectivity
                }
            };

        } catch (error) {
            logger.error('Failed to collect Batman stats:', error);
            return {};
        }
    }

    async collectZeroTierStats() {
        try {
            const ZeroTierManager = require('./ZeroTierManager');
            const zeroTierManager = new ZeroTierManager();

            const [status, networks, peers, trafficStats] = await Promise.all([
                zeroTierManager.getStatus(),
                zeroTierManager.getNetworks(),
                zeroTierManager.getPeers(),
                zeroTierManager.getNetworkTrafficStats()
            ]);

            return {
                status: status,
                networks: networks,
                peers: peers,
                traffic: trafficStats,
                metrics: {
                    networkCount: networks.length,
                    peerCount: peers.length,
                    onlineStatus: status.online,
                    connectedNetworks: networks.filter(n => n.status === 'OK').length
                }
            };

        } catch (error) {
            logger.error('Failed to collect ZeroTier stats:', error);
            return {};
        }
    }

    calculateMeshHealth(neighbors, routes) {
        if (!neighbors || neighbors.length === 0) {
            return {
                connectivity: 0,
                quality: 0,
                redundancy: 0,
                status: 'disconnected'
            };
        }

        // Calculate average link quality
        const qualities = neighbors.map(n => {
            const qualityStr = n.quality || '0.00';
            const match = qualityStr.match(/(\d+\.\d+)/);
            return match ? parseFloat(match[1]) : 0;
        });

        const avgQuality = qualities.length > 0 
            ? qualities.reduce((sum, q) => sum + q, 0) / qualities.length 
            : 0;

        // Calculate connectivity score
        const maxNeighbors = 10; // Assume max 10 neighbors for scoring
        const connectivity = Math.min(neighbors.length / maxNeighbors, 1) * 100;

        // Calculate redundancy (multiple paths to destinations)
        const uniqueDestinations = new Set(routes.map(r => r.destination));
        const redundancy = routes.length > 0 
            ? (routes.length / uniqueDestinations.size) * 20 // Scale to percentage
            : 0;

        // Determine overall status
        let status = 'good';
        if (avgQuality < 0.5 || connectivity < 30) {
            status = 'poor';
        } else if (avgQuality < 0.8 || connectivity < 60) {
            status = 'fair';
        }

        return {
            connectivity: Math.round(connectivity),
            quality: Math.round(avgQuality * 100),
            redundancy: Math.min(Math.round(redundancy), 100),
            status: status
        };
    }

    calculateAverageQuality(neighbors) {
        if (!neighbors || neighbors.length === 0) {
            return 0;
        }

        const qualities = neighbors.map(n => {
            const qualityStr = n.quality || '0.00';
            const match = qualityStr.match(/(\d+\.\d+)/);
            return match ? parseFloat(match[1]) : 0;
        });

        return qualities.length > 0 
            ? qualities.reduce((sum, q) => sum + q, 0) / qualities.length 
            : 0;
    }

    addToHistory(stats) {
        this.history.push({
            ...stats,
            timestamp: new Date()
        });

        // Limit history size
        if (this.history.length > this.maxHistorySize) {
            this.history = this.history.slice(-this.maxHistorySize);
        }
    }

    getLatestStats() {
        return this.stats;
    }

    getHistory(minutes = 60) {
        const cutoff = new Date(Date.now() - minutes * 60 * 1000);
        return this.history.filter(stat => stat.timestamp >= cutoff);
    }

    getSystemSummary() {
        const stats = this.stats;
        
        return {
            timestamp: stats.timestamp,
            uptime: process.uptime(),
            cpu: {
                usage: stats.system?.cpu?.usage || 0,
                temperature: stats.system?.temperature?.cpu || 0
            },
            memory: {
                usage: stats.system?.memory?.usage || 0,
                total: stats.system?.memory?.total || 0,
                available: stats.system?.memory?.available || 0
            },
            network: {
                interfaceCount: Object.keys(stats.network?.interfaces || {}).length,
                activeInterfaces: Object.values(stats.network?.interfaces || {})
                    .filter(iface => iface.operstate === 'up').length
            },
            batman: {
                active: stats.batman?.status?.active || false,
                neighbors: stats.batman?.metrics?.neighborCount || 0,
                health: stats.batman?.health?.status || 'unknown'
            },
            zerotier: {
                online: stats.zerotier?.metrics?.onlineStatus || false,
                networks: stats.zerotier?.metrics?.connectedNetworks || 0,
                peers: stats.zerotier?.metrics?.peerCount || 0
            }
        };
    }

    getNetworkSummary() {
        const stats = this.stats;
        
        return {
            batman: {
                interface: stats.batman?.status?.interface,
                neighbors: stats.batman?.neighbors || [],
                routes: stats.batman?.routes || [],
                health: stats.batman?.health || {}
            },
            zerotier: {
                status: stats.zerotier?.status || {},
                networks: stats.zerotier?.networks || [],
                peers: stats.zerotier?.peers || [],
                traffic: stats.zerotier?.traffic || {}
            },
            interfaces: stats.network?.interfaces || {}
        };
    }

    getPerformanceMetrics() {
        const history = this.getHistory(30); // Last 30 minutes
        
        if (history.length === 0) {
            return null;
        }

        // Calculate trends
        const cpuUsages = history.map(h => h.system?.cpu?.usage || 0);
        const memUsages = history.map(h => h.system?.memory?.usage || 0);
        const neighborCounts = history.map(h => h.batman?.metrics?.neighborCount || 0);

        return {
            cpu: {
                current: cpuUsages[cpuUsages.length - 1] || 0,
                average: cpuUsages.reduce((sum, val) => sum + val, 0) / cpuUsages.length,
                max: Math.max(...cpuUsages),
                min: Math.min(...cpuUsages)
            },
            memory: {
                current: memUsages[memUsages.length - 1] || 0,
                average: memUsages.reduce((sum, val) => sum + val, 0) / memUsages.length,
                max: Math.max(...memUsages),
                min: Math.min(...memUsages)
            },
            mesh: {
                currentNeighbors: neighborCounts[neighborCounts.length - 1] || 0,
                averageNeighbors: neighborCounts.reduce((sum, val) => sum + val, 0) / neighborCounts.length,
                maxNeighbors: Math.max(...neighborCounts),
                minNeighbors: Math.min(...neighborCounts)
            },
            dataPoints: history.length,
            timespan: history.length > 0 ? {
                start: history[0].timestamp,
                end: history[history.length - 1].timestamp
            } : null
        };
    }

    reset() {
        this.stats = {
            system: {},
            network: {},
            batman: {},
            zerotier: {},
            timestamp: new Date()
        };
        this.history = [];
    }
}

module.exports = StatsCollector;
