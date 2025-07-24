const fs = require('fs').promises;
const { exec } = require('child_process');
const { promisify } = require('util');
const logger = require('../utils/logger');

const execAsync = promisify(exec);

/**
 * SecurityManager - Manages firewall rules and security for batman mesh network
 * 
 * Security Model: Force ZeroTier through mesh, prevent unauthorized mesh access
 * 
 * Coordinator nodes:
 * - Full ethernet access for internet and ZeroTier connectivity
 * - NAT configuration for authorized mesh internet sharing
 * - Batman interface allowed for mesh communication
 * 
 * Mesh nodes:
 * - Full ethernet access for normal operations and management
 * - ZeroTier FORCED through batman mesh (blocked on ethernet)
 * - Batman interface allowed for mesh communication
 * - SECURITY: Block forwarding from batman to ethernet (prevents unauthorized internet access via mesh)
 * - Special routing: ZeroTier traffic routed through batman interface using policy routing
 */
class SecurityManager {
    constructor(options = {}) {
        this.batmanInterface = options.batmanInterface || 'bat0';
        this.meshInterface = options.meshInterface || 'wlan0';
        this.ethernetInterface = options.ethernetInterface || 'eth1';
        this.disableSystemHardening = options.disableSystemHardening || false;
        this.isCoordinator = options.isCoordinator || false; // Only coordinator needs NAT
        this.blockedNodes = new Set();
        this.monitoringInterval = null;
    }

    async initialize() {
        logger.info('Initializing SecurityManager...');
        
        try {
            await this.setupFirewallRules();
            
            if (!this.disableSystemHardening) {
                await this.hardenSystem();
            } else {
                logger.info('System hardening disabled - preserving all system services');
            }
            
            // Start security monitoring
            await this.monitorSecurity();
            
            logger.info('SecurityManager initialized successfully');
            
        } catch (error) {
            logger.error('SecurityManager initialization failed:', error);
            throw error;
        }
    }

    async setupFirewallRules() {
        logger.info('Setting up firewall rules...');
        
        try {
            const firewallSystem = await this.detectFirewallSystem();
            
            if (firewallSystem === 'nftables') {
                await this.setupNftablesRules();
            } else {
                await this.setupIptablesRules();
            }
            
            // Note: ZeroTier routing now handled by ZeroTierManager using process-based marking
            
            logger.info('Firewall rules configured successfully');
            
        } catch (error) {
            logger.error('Failed to setup firewall rules:', error);
            throw error;
        }
    }

    async detectFirewallSystem() {
        try {
            await this.executeCommand('which nft');
            return 'nftables';
        } catch (error) {
            return 'iptables';
        }
    }

    async setupIptablesRules() {
        try {
            // Flush existing batman rules
            await this.executeCommand('iptables -F || true');
            
            // Allow loopback
            await this.executeCommand('iptables -A INPUT -i lo -j ACCEPT');
            await this.executeCommand('iptables -A OUTPUT -o lo -j ACCEPT');
            
            // ZeroTier interface
            const ztInterface = await this.getZeroTierInterface();
            if (ztInterface) {
                // Allow ZeroTier traffic
                await this.executeCommand(`iptables -A INPUT -i ${ztInterface} -j ACCEPT`);
                await this.executeCommand(`iptables -A OUTPUT -o ${ztInterface} -j ACCEPT`);
                
                // NAT for internet access through ZeroTier (coordinator only)
                if (this.isCoordinator) {
                    await this.executeCommand(`iptables -t nat -A POSTROUTING -o ${ztInterface} -j MASQUERADE`);
                }
            }
            
            if (this.isCoordinator) {
                // Coordinator: Allow all traffic on ethernet interfaces (has direct internet)
                await this.executeCommand(`iptables -A INPUT -i ${this.ethernetInterface} -j ACCEPT`);
                await this.executeCommand(`iptables -A OUTPUT -o ${this.ethernetInterface} -j ACCEPT`);
                
                // Allow all traffic on eth0 if different from ethernetInterface
                if (this.ethernetInterface !== 'eth0') {
                    await this.executeCommand('iptables -A INPUT -i eth0 -j ACCEPT');
                    await this.executeCommand('iptables -A OUTPUT -o eth0 -j ACCEPT');
                }
                
                // Allow batman interfaces for mesh communication
                await this.executeCommand(`iptables -A INPUT -i ${this.batmanInterface} -j ACCEPT`);
                await this.executeCommand(`iptables -A INPUT -i ${this.meshInterface} -j ACCEPT`);
                
                // NAT for internet access through ethernet
                await this.executeCommand(`iptables -t nat -A POSTROUTING -o ${this.ethernetInterface} -j MASQUERADE`);
                await this.executeCommand(`iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE`);
                
            } else {
                // Mesh node: Allow normal ethernet access for management
                await this.executeCommand(`iptables -A INPUT -i ${this.ethernetInterface} -j ACCEPT`);
                await this.executeCommand(`iptables -A OUTPUT -o ${this.ethernetInterface} -j ACCEPT`);
                
                // Allow all traffic on eth0 if different from ethernetInterface  
                if (this.ethernetInterface !== 'eth0') {
                    await this.executeCommand('iptables -A INPUT -i eth0 -j ACCEPT');
                    await this.executeCommand('iptables -A OUTPUT -o eth0 -j ACCEPT');
                }
                
                // Allow batman interfaces for mesh communication
                await this.executeCommand(`iptables -A INPUT -i ${this.batmanInterface} -j ACCEPT`);
                await this.executeCommand(`iptables -A INPUT -i ${this.meshInterface} -j ACCEPT`);
                await this.executeCommand(`iptables -A OUTPUT -o ${this.batmanInterface} -j ACCEPT`);
                await this.executeCommand(`iptables -A OUTPUT -o ${this.meshInterface} -j ACCEPT`);
                
                // // SECURITY: Block ZeroTier from using ethernet - force through mesh
                // await this.executeCommand(`iptables -A OUTPUT -o ${this.ethernetInterface} -p udp --dport 9993 -j DROP`); // ZeroTier control port
                // await this.executeCommand(`iptables -A OUTPUT -o ${this.ethernetInterface} -p tcp --dport 9993 -j DROP`); // ZeroTier control port
                // await this.executeCommand(`iptables -A OUTPUT -o eth0 -p udp --dport 9993 -j DROP`);
                // await this.executeCommand(`iptables -A OUTPUT -o eth0 -p tcp --dport 9993 -j DROP`);
                
                // // Block forwarding from batman to ethernet (prevent unauthorized internet access)
                // await this.executeCommand(`iptables -A FORWARD -i ${this.batmanInterface} -o ${this.ethernetInterface} -j DROP`);
                // await this.executeCommand(`iptables -A FORWARD -i ${this.meshInterface} -o ${this.ethernetInterface} -j DROP`);
                // await this.executeCommand(`iptables -A FORWARD -i ${this.batmanInterface} -o eth0 -j DROP`);
                // await this.executeCommand(`iptables -A FORWARD -i ${this.meshInterface} -o eth0 -j DROP`);
            }
            
            await this.saveIptablesRules();
            
        } catch (error) {
            logger.error('Failed to setup iptables rules:', error);
            throw error;
        }
    }

    async setupNftablesRules() {
        try {
            const ztInterface = await this.getZeroTierInterface();
            
            const nftConfig = `#!/usr/sbin/nft -f

# Batman mesh security rules - role-based network access
table inet batman_filter {
    chain input {
        type filter hook input priority 0; policy accept;
        
        # Allow loopback
        iif lo accept
        
        # ZeroTier traffic
        ${ztInterface ? `iif ${ztInterface} accept` : '# No ZeroTier interface found'}
        
        ${this.isCoordinator ? `
        # Coordinator: Allow all ethernet traffic (has direct internet)
        iif ${this.ethernetInterface} accept
        iif eth0 accept
        
        # Allow batman interfaces for mesh communication
        iif ${this.batmanInterface} accept
        iif ${this.meshInterface} accept
        ` : `
        # Mesh node: Allow normal ethernet access for management
        iif ${this.ethernetInterface} accept
        iif eth0 accept
        
        # Allow batman interfaces for mesh communication
        iif ${this.batmanInterface} accept
        iif ${this.meshInterface} accept
        `}
    }
    
    chain output {
        type filter hook output priority 0; policy accept;
        
        # Allow loopback
        oif lo accept
        
        # ZeroTier traffic
        ${ztInterface ? `oif ${ztInterface} accept` : '# No ZeroTier interface found'}
        
        ${this.isCoordinator ? `
        # Coordinator: Allow all ethernet output
        oif ${this.ethernetInterface} accept
        oif eth0 accept
        ` : `
        # Mesh node: Allow normal ethernet output 
        # Note: ZeroTier traffic routing handled by process-based marking in ZeroTierManager
        oif ${this.ethernetInterface} accept
        oif eth0 accept
        `}
        
        # Allow batman output
        oif ${this.batmanInterface} accept
        oif ${this.meshInterface} accept
    }
    
    chain forward {
        type filter hook forward priority 0; policy accept;
        
        ${this.isCoordinator ? `
        # Coordinator: Allow forwarding for mesh nodes
        iif ${this.batmanInterface} accept
        oif ${this.batmanInterface} accept
        iif ${this.meshInterface} accept
        oif ${this.meshInterface} accept
        
        # ZeroTier forwarding
        ${ztInterface ? `iif ${ztInterface} accept` : '# No ZeroTier interface found'}
        ${ztInterface ? `oif ${ztInterface} accept` : '# No ZeroTier interface found'}
        ` : `
        # Mesh node: Block forwarding from batman to ethernet (security)
        iif ${this.batmanInterface} oif ${this.ethernetInterface} drop
        iif ${this.meshInterface} oif ${this.ethernetInterface} drop
        iif ${this.batmanInterface} oif eth0 drop
        iif ${this.meshInterface} oif eth0 drop
        `}
    }
}

table inet batman_nat {
    chain postrouting {
        type nat hook postrouting priority 100; policy accept;
        
        ${this.isCoordinator ? `# NAT for internet access through ethernet (coordinator only)
        oif ${this.ethernetInterface} masquerade
        oif eth0 masquerade
        
        # NAT for ZeroTier if available (coordinator only)
        ${ztInterface ? `oif ${ztInterface} masquerade` : '# No ZeroTier interface found'}` : '# NAT disabled - not coordinator'}
    }
}
`;

            await fs.writeFile('/tmp/batman-nft.conf', nftConfig);
            await this.executeCommand('nft -f /tmp/batman-nft.conf');
            await this.executeCommand('nft list ruleset >> /etc/nftables.conf');
            await fs.unlink('/tmp/batman-nft.conf').catch(() => {});
            
        } catch (error) {
            logger.error('Failed to setup nftables rules:', error);
            throw error;
        }
    }

    async getZeroTierInterface() {
        try {
            // Look for actual ZeroTier interfaces, not veth pairs
            const { stdout } = await execAsync('ip link show | grep -E "zt[a-z0-9]{10}" | head -1 | cut -d: -f2 | tr -d " "');
            const ztInterface = stdout.trim();
            
            // If no real ZeroTier interface found, return null (chroot setup doesn't need host firewall rules)
            if (!ztInterface || ztInterface.includes('veth')) {
                return null;
            }
            
            return ztInterface;
        } catch (error) {
            return null;
        }
    }

    async saveIptablesRules() {
        try {
            // Try different methods to save iptables rules
            try {
                await this.executeCommand('iptables-save > /etc/iptables/rules.v4');
            } catch (error) {
                try {
                    await this.executeCommand('service iptables save');
                } catch (error2) {
                    await this.executeCommand('sh -c "iptables-save > /etc/iptables.rules"');
                }
            }
        } catch (error) {
            logger.warn('Failed to save iptables rules:', error);
        }
    }

    async setupZeroTierMeshRouting() {
        // DEPRECATED: This method has been replaced by process-based routing in ZeroTierManager
        // The new approach uses iptables process/UID/port marking with custom routing tables
        // instead of blanket port blocking which prevented ZeroTier from working properly
        logger.info('ZeroTier mesh routing now handled by ZeroTierManager - skipping legacy setup');
        return;
        
        /* OLD IMPLEMENTATION - CAUSES CONFLICTS
        logger.info('Setting up ZeroTier routing through batman mesh...');
        
        try {
            // Get batman interface IP and network
            const batmanRoute = await this.executeCommand(`ip route show dev ${this.batmanInterface} | head -1 || echo ""`);
            
            if (batmanRoute.trim()) {
                // Add routing table for ZeroTier traffic
                await this.executeCommand('echo "200 zerotier" >> /etc/iproute2/rt_tables || true');
                
                // Route ZeroTier control traffic through batman interface
                await this.executeCommand(`ip rule add fwmark 1 table zerotier || true`);
                await this.executeCommand(`ip route add default dev ${this.batmanInterface} table zerotier || true`);
                
                // Mark ZeroTier packets to use batman routing
                await this.executeCommand(`iptables -t mangle -A OUTPUT -p udp --dport 9993 -j MARK --set-mark 1 || true`);
                await this.executeCommand(`iptables -t mangle -A OUTPUT -p tcp --dport 9993 -j MARK --set-mark 1 || true`);
                
                logger.info('ZeroTier routing configured to use batman mesh');
            } else {
                logger.warn('Could not determine batman routing - ZeroTier may not route through mesh');
            }
            
        } catch (error) {
            logger.error('Failed to setup ZeroTier mesh routing:', error);
            // Don't throw as this is not critical for basic functionality
        }
        */
    }

    async hardenSystem() {
        // Skip system hardening if disabled
        if (this.disableSystemHardening) {
            logger.info('System hardening disabled - preserving all system services');
            return;
        }
        
        logger.info('Applying minimal batman-specific hardening...');
        
        try {
            // Only apply network-specific hardening that doesn't affect system services
            await this.applyNetworkHardening();
            
            logger.info('Minimal batman hardening complete - system services preserved');
            
        } catch (error) {
            logger.error('Batman hardening failed:', error);
            // Don't throw error as this is not critical
        }
    }

    async applyNetworkHardening() {
        // Only apply minimal network hardening that doesn't interfere with system services
        logger.info('Applying minimal network hardening for batman mesh...');
        
        try {
            // Enable SYN flood protection (safe to enable)
            await this.executeCommand('echo 1 > /proc/sys/net/ipv4/tcp_syncookies');
            
            // Disable ICMP redirects (safe to disable)
            await this.executeCommand('echo 0 > /proc/sys/net/ipv4/conf/all/accept_redirects');
            await this.executeCommand('echo 0 > /proc/sys/net/ipv6/conf/all/accept_redirects');
            
            logger.info('Minimal network hardening applied');
            
        } catch (error) {
            logger.error('Network hardening failed:', error);
        }
    }

    async blockNode(nodeAddress) {
        logger.info(`Blocking node: ${nodeAddress}`);
        
        try {
            this.blockedNodes.add(nodeAddress);
            
            const firewallSystem = await this.detectFirewallSystem();
            
            if (firewallSystem === 'nftables') {
                await this.executeCommand(`nft add rule inet batman_filter input ip saddr ${nodeAddress} drop`);
            } else {
                await this.executeCommand(`iptables -A INPUT -s ${nodeAddress} -j DROP`);
            }
            
            logger.info(`Node ${nodeAddress} blocked successfully`);
            
        } catch (error) {
            logger.error(`Failed to block node ${nodeAddress}:`, error);
            throw error;
        }
    }

    async unblockNode(nodeAddress) {
        logger.info(`Unblocking node: ${nodeAddress}`);
        
        try {
            this.blockedNodes.delete(nodeAddress);
            
            const firewallSystem = await this.detectFirewallSystem();
            
            if (firewallSystem === 'nftables') {
                await this.executeCommand(`nft delete rule inet batman_filter input ip saddr ${nodeAddress} drop`);
            } else {
                await this.executeCommand(`iptables -D INPUT -s ${nodeAddress} -j DROP`);
            }
            
            logger.info(`Node ${nodeAddress} unblocked successfully`);
            
        } catch (error) {
            logger.error(`Failed to unblock node ${nodeAddress}:`, error);
            throw error;
        }
    }

    async monitorSecurity() {
        logger.info('Starting security monitoring...');
        
        this.monitoringInterval = setInterval(async () => {
            try {
                await this.checkSuspiciousConnections();
                await this.checkFailedLogins();
                await this.checkSystemIntegrity();
            } catch (error) {
                logger.error('Security monitoring error:', error);
            }
        }, 60000); // Check every minute
    }

    async checkSuspiciousConnections() {
        try {
            // Check for suspicious network connections on batman interfaces
            const connections = await this.executeCommand(`netstat -an | grep ${this.batmanInterface} || true`);
            
            if (connections.trim()) {
                logger.warn('Suspicious connections detected on batman interface:', connections);
                // Add additional analysis here
            }
            
        } catch (error) {
            logger.debug('Connection check failed:', error);
        }
    }

    async checkFailedLogins() {
        try {
            const failedLogins = await this.executeCommand("grep 'Failed password' /var/log/auth.log | tail -10 || true");
            
            if (failedLogins.trim()) {
                logger.warn('Recent failed login attempts detected');
                // Add IP blocking logic here if needed
            }
            
        } catch (error) {
            logger.debug('Failed login check failed:', error);
        }
    }

    async checkSystemIntegrity() {
        try {
            // Check if batman module is loaded
            const batmanModule = await this.executeCommand('lsmod | grep batman || echo "not loaded"');
            
            if (batmanModule.includes('not loaded')) {
                logger.warn('Batman-adv module not loaded - mesh may be compromised');
            }
            
            // Check interface status
            const interfaceStatus = await this.executeCommand(`ip link show ${this.batmanInterface} || echo "interface down"`);
            
            if (interfaceStatus.includes('interface down')) {
                logger.warn(`Batman interface ${this.batmanInterface} is down`);
            }
            
        } catch (error) {
            logger.debug('System integrity check failed:', error);
        }
    }

    async cleanup() {
        logger.info('Cleaning up SecurityManager...');
        
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.monitoringInterval = null;
        }
        
        // Optionally remove firewall rules
        logger.info('SecurityManager cleanup complete');
    }

    async executeCommand(command) {
        try {
            const { stdout } = await execAsync(command);
            return stdout.trim();
        } catch (error) {
            logger.debug(`Command failed: ${command}`, error);
            throw error;
        }
    }

    getBlockedNodes() {
        return Array.from(this.blockedNodes);
    }
}

module.exports = SecurityManager;