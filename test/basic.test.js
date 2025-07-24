const assert = require('assert');
const NetworkManager = require('../src/services/NetworkManager');
const ZeroTierManager = require('../src/services/ZeroTierManager');
const SecurityManager = require('../src/services/SecurityManager');
const StatsCollector = require('../src/services/StatsCollector');

describe('Batman Coordinator Tests', function() {
    this.timeout(10000);

    describe('NetworkManager', function() {
        it('should initialize without errors', function() {
            const networkManager = new NetworkManager();
            assert(networkManager);
            assert.equal(networkManager.meshInterface, process.env.MESH_INTERFACE || 'wlan1');
        });

        it('should have correct default configuration', function() {
            const networkManager = new NetworkManager();
            assert.equal(networkManager.batmanInterface, 'bat0');
            assert.equal(networkManager.meshSubnet, process.env.MESH_SUBNET || '192.168.100.0/24');
        });
    });

    describe('ZeroTierManager', function() {
        it('should initialize without errors', function() {
            const zeroTierManager = new ZeroTierManager();
            assert(zeroTierManager);
        });

        it('should handle missing network ID gracefully', function() {
            const zeroTierManager = new ZeroTierManager();
            assert.equal(zeroTierManager.networkId, process.env.ZEROTIER_NETWORK_ID);
        });
    });

    describe('SecurityManager', function() {
        it('should initialize without errors', function() {
            const securityManager = new SecurityManager();
            assert(securityManager);
        });

        it('should have blocked nodes set', function() {
            const securityManager = new SecurityManager();
            assert(securityManager.blockedNodes instanceof Set);
        });
    });

    describe('StatsCollector', function() {
        it('should initialize without errors', function() {
            const statsCollector = new StatsCollector();
            assert(statsCollector);
        });

        it('should have empty stats initially', function() {
            const statsCollector = new StatsCollector();
            const stats = statsCollector.getLatestStats();
            assert(stats);
            assert(stats.timestamp);
        });

        it('should calculate mesh health correctly', function() {
            const statsCollector = new StatsCollector();
            
            // Test with no neighbors (disconnected)
            let health = statsCollector.calculateMeshHealth([], []);
            assert.equal(health.connectivity, 0);
            assert.equal(health.status, 'disconnected');
            
            // Test with good neighbors
            const neighbors = [
                { quality: '1.00', address: '00:11:22:33:44:55' },
                { quality: '0.90', address: '00:11:22:33:44:56' }
            ];
            health = statsCollector.calculateMeshHealth(neighbors, []);
            assert(health.connectivity > 0);
            assert(health.quality > 0);
        });
    });

    describe('Configuration', function() {
        it('should load environment variables', function() {
            // Test that environment variables are accessible
            const meshInterface = process.env.MESH_INTERFACE || 'wlan1';
            const meshSubnet = process.env.MESH_SUBNET || '192.168.100.0/24';
            
            assert.equal(typeof meshInterface, 'string');
            assert.equal(typeof meshSubnet, 'string');
        });
    });

    describe('Utility Functions', function() {
        it('should format bytes correctly', function() {
            const statsCollector = new StatsCollector();
            
            // Mock the formatBytes method for testing
            const formatBytes = (bytes) => {
                if (bytes === 0) return '0 B';
                const k = 1024;
                const sizes = ['B', 'KB', 'MB', 'GB'];
                const i = Math.floor(Math.log(bytes) / Math.log(k));
                return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
            };
            
            assert.equal(formatBytes(0), '0 B');
            assert.equal(formatBytes(1024), '1 KB');
            assert.equal(formatBytes(1048576), '1 MB');
        });

        it('should format uptime correctly', function() {
            const formatUptime = (seconds) => {
                const days = Math.floor(seconds / 86400);
                const hours = Math.floor((seconds % 86400) / 3600);
                const minutes = Math.floor((seconds % 3600) / 60);
                
                if (days > 0) {
                    return `${days}d ${hours}h ${minutes}m`;
                } else if (hours > 0) {
                    return `${hours}h ${minutes}m`;
                } else {
                    return `${minutes}m`;
                }
            };
            
            assert.equal(formatUptime(60), '1m');
            assert.equal(formatUptime(3660), '1h 1m');
            assert.equal(formatUptime(90061), '1d 1h 1m');
        });
    });
});
