const { exec } = require('child_process');
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
    }

    async executeCommand(command, options = {}) {
        try {
            logger.debug(`Executing ZeroTier command: ${command}`);
            const { stdout, stderr } = await execAsync(command, { timeout: 30000, ...options });
            if (stderr && !options.ignoreStderr) {
                logger.warn(`ZeroTier command stderr: ${stderr}`);
            }
            return stdout.trim();
        } catch (error) {
            logger.error(`ZeroTier command failed: ${command}`, error);
            throw error;
        }
    }

    async initialize() {
        logger.info('Initializing ZeroTier...');
        
        try {
            // Check if ZeroTier service is running
            await this.ensureServiceRunning();
            
            // Join the network if not already joined
            if (this.networkId) {
                await this.joinNetwork(this.networkId);
                
                // Wait for network to be ready
                await this.waitForNetworkReady();
                
                // Get ZeroTier interface name
                this.zerotierInterface = await this.getZeroTierInterface();
                
                logger.info(`ZeroTier initialized with interface: ${this.zerotierInterface}`);
            } else {
                logger.warn('No ZeroTier network ID specified');
            }
            
        } catch (error) {
            logger.error('Failed to initialize ZeroTier:', error);
            throw error;
        }
    }

    async ensureServiceRunning() {
        try {
            // Check if zerotier service is running
            const status = await this.executeCommand('systemctl is-active zerotier-one', { ignoreStderr: true });
            
            if (status !== 'active') {
                logger.info('Starting ZeroTier service...');
                await this.executeCommand('systemctl start zerotier-one');
                
                // Wait for service to start
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
            
            // Verify the service is accessible
            await this.executeCommand('zerotier-cli status');
            
        } catch (error) {
            logger.error('Failed to ensure ZeroTier service is running:', error);
            throw error;
        }
    }

    async joinNetwork(networkId) {
        try {
            logger.info(`Joining ZeroTier network: ${networkId}`);
            
            // Check if already joined
            const networks = await this.getNetworks();
            const existingNetwork = networks.find(n => n.id === networkId);
            
            if (existingNetwork) {
                logger.info(`Already joined network ${networkId}`);
                return;
            }
            
            // Join the network
            await this.executeCommand(`zerotier-cli join ${networkId}`);
            
            logger.info(`Joined ZeroTier network: ${networkId}`);
            
        } catch (error) {
            logger.error(`Failed to join ZeroTier network ${networkId}:`, error);
            throw error;
        }
    }

    async waitForNetworkReady() {
        const maxAttempts = 60; // 60 seconds
        let attempts = 0;
        
        logger.info('Waiting for ZeroTier network to be ready...');
        
        while (attempts < maxAttempts) {
            try {
                const networks = await this.getNetworks();
                const targetNetwork = networks.find(n => n.id === this.networkId);
                
                if (targetNetwork && 
                    targetNetwork.status === 'OK' && 
                    targetNetwork.assignedAddresses.length > 0) {
                    logger.info(`ZeroTier network ready with IP: ${targetNetwork.assignedAddresses[0]}`);
                    return targetNetwork;
                }
                
            } catch (error) {
                // Continue trying
            }
            
            attempts++;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        throw new Error('ZeroTier network ready timeout');
    }

    async getStatus() {
        try {
            const statusOutput = await this.executeCommand('zerotier-cli status');
            const lines = statusOutput.split('\n');
            
            const status = {
                online: false,
                version: 'unknown',
                address: 'unknown',
                networks: []
            };
            
            // Parse status line
            if (lines.length > 0) {
                const statusLine = lines[0];
                status.online = statusLine.includes('ONLINE');
                
                const parts = statusLine.split(/\s+/);
                if (parts.length >= 3) {
                    status.address = parts[2];
                    status.version = parts[3];
                }
            }
            
            // Get network information
            status.networks = await this.getNetworks();
            
            return status;
            
        } catch (error) {
            logger.error('Failed to get ZeroTier status:', error);
            return {
                online: false,
                error: error.message
            };
        }
    }

    async getNetworks() {
        try {
            const output = await this.executeCommand('zerotier-cli listnetworks');
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

    async configureRoutingForMesh(isCoordinator = false) {
        try {
            // First, clean up any conflicting rules from old implementations
            await this.cleanupConflictingRules();
            
            const networks = await this.getNetworks();
            const targetNetwork = networks.find(n => n.id === this.networkId);
            
            if (!targetNetwork || !targetNetwork.interface) {
                logger.warn('ZeroTier network not ready for routing configuration');
                return;
            }
            
            const ztInterface = targetNetwork.interface;
            const batmanInterface = process.env.BATMAN_INTERFACE || 'bat0';
            
            // New approach: Coordinator acts as full internet gateway for all mesh traffic
            // This allows all applications on mesh nodes to access internet through the coordinator
            if (isCoordinator) {
                // Coordinator: Act as full internet gateway for all mesh nodes
                logger.info('Coordinator: Setting up as full internet gateway for mesh network');
                await this.configureCoordinatorGateway(batmanInterface);
                
            } else {
                // Node: Route all internet traffic through batman mesh to coordinator
                logger.info(`Configuring node to route all internet traffic via ${batmanInterface}`);
                
                await this.configureNodeGatewayRouting(batmanInterface);
            }
            
            logger.info('ZeroTier routing configured for mesh operation');
            
        } catch (error) {
            logger.error('Failed to configure ZeroTier routing:', error);
        }
    }

    async cleanupConflictingRules() {
        try {
            logger.info('Cleaning up any conflicting ZeroTier routing rules');
            
            // Clean up both old process-based routing and gateway routing
            await this.cleanupProcessBasedRouting();
            await this.cleanupGatewayRouting(true);  // Try coordinator cleanup
            await this.cleanupGatewayRouting(false); // Try node cleanup
            
            // Remove old SecurityManager rules that might conflict
            await this.executeCommand('ip rule del fwmark 1 table zerotier 2>/dev/null || true');
            await this.executeCommand('ip route flush table zerotier 2>/dev/null || true');
            
            // Remove old iptables marking rules with mark 1
            await this.executeCommand('iptables -t mangle -D OUTPUT -p udp --dport 9993 -j MARK --set-mark 1 2>/dev/null || true');
            await this.executeCommand('iptables -t mangle -D OUTPUT -p tcp --dport 9993 -j MARK --set-mark 1 2>/dev/null || true');
            
            // Remove any DROP rules for ZeroTier ports
            await this.executeCommand(`iptables -D OUTPUT -o ${process.env.ETHERNET_INTERFACE || 'eth1'} -p udp --dport 9993 -j DROP 2>/dev/null || true`);
            await this.executeCommand(`iptables -D OUTPUT -o ${process.env.ETHERNET_INTERFACE || 'eth1'} -p tcp --dport 9993 -j DROP 2>/dev/null || true`);
            await this.executeCommand('iptables -D OUTPUT -o eth0 -p udp --dport 9993 -j DROP 2>/dev/null || true');
            await this.executeCommand('iptables -D OUTPUT -o eth0 -p tcp --dport 9993 -j DROP 2>/dev/null || true');
            
            logger.info('Conflicting rules cleanup complete');
            
        } catch (error) {
            logger.debug('Conflicting rules cleanup failed (may be normal):', error.message);
        }
    }

    async configureProcessBasedRouting(batmanInterface) {
        try {
            const coordinatorIP = process.env.COORDINATOR_BATMAN_IP || '192.168.100.1';
            const markValue = '0x100'; // Custom mark for ZeroTier traffic
            const tableId = '100'; // Custom routing table for ZeroTier
            
            logger.info('Setting up enhanced process-based routing for ZeroTier');
            
            // Step 1: Clean up any existing configuration
            await this.executeCommand(`ip rule del fwmark ${markValue} table ${tableId} 2>/dev/null || true`);
            await this.executeCommand(`ip route flush table ${tableId} 2>/dev/null || true`);
            
            // Step 2: Verify batman interface is ready and has connectivity
            try {
                const batmanStatus = await this.executeCommand(`ip link show ${batmanInterface}`);
                if (!batmanStatus.includes('UP')) {
                    throw new Error(`Batman interface ${batmanInterface} is not UP`);
                }
                
                // Test connectivity to coordinator
                const pingTest = await this.executeCommand(`ping -c 1 -W 2 ${coordinatorIP} 2>/dev/null || echo "failed"`);
                if (!pingTest.includes('1 received')) {
                    logger.warn(`Warning: Cannot ping coordinator ${coordinatorIP} via batman - continuing anyway`);
                }
            } catch (error) {
                logger.error(`Batman interface issue: ${error.message}`);
                throw error;
            }
            
            // Step 3: Create custom routing table with high priority
            // Use priority 100 (higher than default 32766) to ensure it takes precedence
            await this.executeCommand(`ip rule add fwmark ${markValue} table ${tableId} priority 100`);
            
            // Add comprehensive routes in custom table
            await this.executeCommand(`ip route add default via ${coordinatorIP} dev ${batmanInterface} table ${tableId}`);
            
            // Add specific route to coordinator to ensure connectivity
            await this.executeCommand(`ip route add ${coordinatorIP}/32 dev ${batmanInterface} table ${tableId} 2>/dev/null || true`);
            
            // Step 4: Set up traffic marking with multiple fallback methods
            await this.setupZeroTierTrafficMarking(markValue);
            
            // Step 5: Add additional routes for ZeroTier network if available
            const networks = await this.getNetworks();
            const targetNetwork = networks.find(n => n.id === this.networkId);
            if (targetNetwork && targetNetwork.assignedAddresses.length > 0) {
                const ztNetwork = this.extractNetworkFromIP(targetNetwork.assignedAddresses[0]);
                // Add to both main table and custom table
                await this.executeCommand(`ip route add ${ztNetwork} via ${coordinatorIP} dev ${batmanInterface} table ${tableId} 2>/dev/null || true`);
                await this.executeCommand(`ip route add ${ztNetwork} via ${coordinatorIP} dev ${batmanInterface} 2>/dev/null || true`);
            }
            
            // Step 6: Force routing cache flush to ensure rules take effect
            await this.executeCommand('ip route flush cache 2>/dev/null || true');
            
            // Step 7: Verify configuration
            const verification = await this.verifyProcessBasedRouting();
            if (!verification.isConfigured) {
                throw new Error('Process-based routing verification failed after setup');
            }
            
            logger.info(`✅ Enhanced ZeroTier process routing configured: ${verification.markingMethod} marking via ${batmanInterface}`);
            
        } catch (error) {
            logger.error('Failed to configure process-based routing:', error);
            throw error;
        }
    }
    
    async setupZeroTierTrafficMarking(markValue) {
        try {
            logger.debug('Setting up ZeroTier traffic marking with multiple methods');
            
            // Clean up existing marking rules
            await this.executeCommand(`iptables -t mangle -D OUTPUT -m owner --uid-owner zerotier-one -j MARK --set-mark ${markValue} 2>/dev/null || true`);
            await this.executeCommand(`iptables -t mangle -D OUTPUT -m cgroup --cgroup 0x100001 -j MARK --set-mark ${markValue} 2>/dev/null || true`);
            await this.executeCommand(`iptables -t mangle -D OUTPUT -p udp --dport 9993 -j MARK --set-mark ${markValue} 2>/dev/null || true`);
            
            let markingMethod = 'none';
            
            // Method 1: Try UID-based marking (most reliable)
            try {
                const ztUser = await this.executeCommand('id -u zerotier-one 2>/dev/null || echo ""');
                if (ztUser.trim()) {
                    const ztUID = ztUser.trim();
                    await this.executeCommand(`iptables -t mangle -A OUTPUT -m owner --uid-owner ${ztUID} -j MARK --set-mark ${markValue}`);
                    markingMethod = 'uid-based';
                    logger.debug(`✅ UID-based marking configured for UID ${ztUID}`);
                } else {
                    throw new Error('ZeroTier user not found');
                }
            } catch (error) {
                logger.debug('UID-based marking failed, trying alternative methods');
                
                // Method 2: Try port-based marking
                try {
                    await this.executeCommand(`iptables -t mangle -A OUTPUT -p udp --dport 9993 -j MARK --set-mark ${markValue}`);
                    
                    // Also mark traffic from ZeroTier interface
                    const ztInterface = await this.getZeroTierInterface();
                    if (ztInterface) {
                        await this.executeCommand(`iptables -t mangle -A OUTPUT -o ${ztInterface} -j MARK --set-mark ${markValue}`);
                        logger.debug(`✅ Port+interface-based marking configured (${ztInterface})`);
                    } else {
                        logger.debug('✅ Port-based marking configured (UDP 9993)');
                    }
                    markingMethod = 'port-based';
                    
                } catch (portError) {
                    logger.error('All marking methods failed:', portError);
                    throw new Error('Could not configure any traffic marking method');
                }
            }
            
            return markingMethod;
            
        } catch (error) {
            logger.error('Failed to setup ZeroTier traffic marking:', error);
            throw error;
        }
    }

    async configureCoordinatorGateway(batmanInterface) {
        try {
            const meshSubnet = process.env.MESH_SUBNET || '192.168.100.0/24';
            const ethernetInterface = process.env.ETHERNET_INTERFACE || 'eth0';
            
            logger.info('Setting up coordinator as full internet gateway');
            
            // Enable IP forwarding
            await this.executeCommand('echo 1 > /proc/sys/net/ipv4/ip_forward');
            await this.executeCommand('sysctl -w net.ipv4.ip_forward=1');
            
            // Setup NAT for mesh traffic going to internet
            await this.executeCommand(`iptables -t nat -D POSTROUTING -s ${meshSubnet} -o ${ethernetInterface} -j MASQUERADE 2>/dev/null || true`);
            await this.executeCommand(`iptables -t nat -A POSTROUTING -s ${meshSubnet} -o ${ethernetInterface} -j MASQUERADE`);
            
            // Allow forwarding from batman interface to ethernet
            await this.executeCommand(`iptables -D FORWARD -i ${batmanInterface} -o ${ethernetInterface} -j ACCEPT 2>/dev/null || true`);
            await this.executeCommand(`iptables -A FORWARD -i ${batmanInterface} -o ${ethernetInterface} -j ACCEPT`);
            
            // Allow established connections back
            await this.executeCommand(`iptables -D FORWARD -i ${ethernetInterface} -o ${batmanInterface} -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || true`);
            await this.executeCommand(`iptables -A FORWARD -i ${ethernetInterface} -o ${batmanInterface} -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT`);
            
            logger.info(`Coordinator configured as internet gateway for mesh subnet ${meshSubnet}`);
            
        } catch (error) {
            logger.error('Failed to configure coordinator gateway:', error);
            throw error;
        }
    }

    async configureNodeGatewayRouting(batmanInterface) {
        try {
            const coordinatorIP = process.env.COORDINATOR_BATMAN_IP || '192.168.100.1';
            
            logger.info('Configuring node for DHCP-based routing');
            
            // Remove any existing manual routes that might conflict with DHCP
            await this.executeCommand(`ip route del default via ${coordinatorIP} dev ${batmanInterface} 2>/dev/null || true`);
            await this.executeCommand(`ip route del ${coordinatorIP} dev ${batmanInterface} 2>/dev/null || true`);
            
            // Enable DHCP client on batman interface with retry loop
            // This will automatically configure IP, gateway, and routes
            logger.info(`Enabling DHCP client on ${batmanInterface} with 5-minute retry period`);
            
            // Release any existing DHCP lease
            await this.executeCommand(`dhclient -r ${batmanInterface} 2>/dev/null || true`);
            
            // Retry dhclient over 5 minutes
            const maxRetries = 25; // 25 attempts over 5 minutes
            let dhcpSuccess = false;
            
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    logger.info(`DHCP attempt ${attempt}/${maxRetries} - requesting IP from coordinator...`);
                    
                    // Try dhclient with timeout
                    await this.executeCommand(`timeout 30s dhclient ${batmanInterface}`, { timeout: 35000 });
                    
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
            
            // Verify DHCP configuration
            const routes = await this.executeCommand('ip route show');
            logger.info('Routes after DHCP configuration:', routes);
            
            // Add specific route for ZeroTier network if available and needed
            const networks = await this.getNetworks();
            const targetNetwork = networks.find(n => n.id === this.networkId);
            if (targetNetwork && targetNetwork.assignedAddresses.length > 0) {
                const ztNetwork = this.extractNetworkFromIP(targetNetwork.assignedAddresses[0]);
                // Only add if route doesn't already exist via DHCP
                if (!routes.includes(ztNetwork)) {
                    await this.executeCommand(`ip route add ${ztNetwork} via ${coordinatorIP} dev ${batmanInterface} 2>/dev/null || true`);
                }
            }
            
            logger.info(`Node configured with DHCP-based routing on ${batmanInterface}`);
            
        } catch (error) {
            logger.error('Failed to configure node DHCP routing:', error);
            throw error;
        }
    }

    async checkForDHCPIP(batmanInterface) {
        try {
            // Quick check if interface has an IP address
            const ipOutput = await this.executeCommand(`ip addr show ${batmanInterface}`);
            
            // Look for inet address (IPv4)
            const ipMatch = ipOutput.match(/inet (\d+\.\d+\.\d+\.\d+)\/\d+/);
            
            if (ipMatch) {
                const assignedIP = ipMatch[1];
                
                // Make sure it's not a link-local address (169.254.x.x)
                if (!assignedIP.startsWith('169.254.')) {
                    return assignedIP;
                }
            }
            
            return null;
            
        } catch (error) {
            return null;
        }
    }

    async waitForDHCPIP(batmanInterface, maxAttempts = 30) {
        logger.info(`Waiting for DHCP IP assignment on ${batmanInterface}...`);
        
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                // Check if interface has an IP address
                const ipOutput = await this.executeCommand(`ip addr show ${batmanInterface}`);
                
                // Look for inet address (IPv4)
                const ipMatch = ipOutput.match(/inet (\d+\.\d+\.\d+\.\d+)\/\d+/);
                
                if (ipMatch) {
                    const assignedIP = ipMatch[1];
                    
                    // Make sure it's not a link-local address (169.254.x.x)
                    if (!assignedIP.startsWith('169.254.')) {
                        logger.info(`✅ DHCP assigned IP: ${assignedIP} (attempt ${attempt})`);
                        return assignedIP;
                    }
                }
                
                logger.debug(`⏳ Waiting for DHCP IP... attempt ${attempt}/${maxAttempts}`);
                await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
                
            } catch (error) {
                logger.debug(`DHCP IP check failed on attempt ${attempt}:`, error.message);
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        
        // If we get here, DHCP failed
        const errorMsg = `Failed to get DHCP IP on ${batmanInterface} after ${maxAttempts} attempts`;
        logger.error(errorMsg);
        
        // Try to get more diagnostic info
        try {
            const dhclientStatus = await this.executeCommand(`ps aux | grep dhclient | grep ${batmanInterface} || echo "No dhclient process found"`);
            logger.debug('DHCP client status:', dhclientStatus);
            
            const interfaceStatus = await this.executeCommand(`ip link show ${batmanInterface}`);
            logger.debug('Interface status:', interfaceStatus);
            
            const leaseInfo = await this.executeCommand(`cat /var/lib/dhcp/dhclient.${batmanInterface}.leases 2>/dev/null | tail -20 || echo "No lease file found"`);
            logger.debug('DHCP lease info:', leaseInfo);
            
        } catch (debugError) {
            logger.debug('Failed to get DHCP diagnostic info:', debugError.message);
        }
        
        throw new Error(errorMsg);
    }

    extractNetworkFromIP(ipWithMask) {
        // Convert IP like "10.147.20.123/24" to network "10.147.20.0/24"
        if (ipWithMask.includes('/')) {
            const [ip, mask] = ipWithMask.split('/');
            const parts = ip.split('.');
            // For /24 network, zero out last octet
            if (mask === '24') {
                return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
            }
            // For /16 network, zero out last two octets  
            else if (mask === '16') {
                return `${parts[0]}.${parts[1]}.0.0/16`;
            }
        }
        return ipWithMask; // Return as-is if can't parse
    }

    async markZeroTierPortTraffic(markValue) {
        try {
            logger.debug('Using port-based ZeroTier traffic marking');
            
            // ZeroTier uses UDP port 9993 for its protocol
            // Mark outgoing traffic to ZeroTier ports
            await this.executeCommand(`iptables -t mangle -D OUTPUT -p udp --dport 9993 -j MARK --set-mark ${markValue} 2>/dev/null || true`);
            await this.executeCommand(`iptables -t mangle -A OUTPUT -p udp --dport 9993 -j MARK --set-mark ${markValue}`);
            
            // Also mark traffic from ZeroTier interface if we can identify it
            const ztInterface = await this.getZeroTierInterface();
            if (ztInterface) {
                await this.executeCommand(`iptables -t mangle -D OUTPUT -o ${ztInterface} -j MARK --set-mark ${markValue} 2>/dev/null || true`);
                await this.executeCommand(`iptables -t mangle -A OUTPUT -o ${ztInterface} -j MARK --set-mark ${markValue}`);
                logger.debug(`Marking traffic from ZeroTier interface: ${ztInterface}`);
            }
            
            logger.debug('Port-based ZeroTier traffic marking configured');
            
        } catch (error) {
            logger.error('Failed to configure port-based traffic marking:', error);
            throw error;
        }
    }

    async cleanupProcessBasedRouting() {
        try {
            const markValue = '0x100';
            const tableId = '100';
            
            logger.info('Cleaning up ZeroTier process-based routing');
            
            // Remove iptables marking rules - try all possible variations
            await this.executeCommand(`iptables -t mangle -D OUTPUT -m owner --uid-owner zerotier-one -j MARK --set-mark ${markValue} 2>/dev/null || true`);
            await this.executeCommand(`iptables -t mangle -D OUTPUT -m cgroup --cgroup 0x100001 -j MARK --set-mark ${markValue} 2>/dev/null || true`);
            await this.executeCommand(`iptables -t mangle -D OUTPUT -p udp --dport 9993 -j MARK --set-mark ${markValue} 2>/dev/null || true`);
            
            // Try to remove by UID if zerotier user exists
            try {
                const ztUser = await this.executeCommand('id -u zerotier-one 2>/dev/null || echo ""');
                if (ztUser.trim()) {
                    await this.executeCommand(`iptables -t mangle -D OUTPUT -m owner --uid-owner ${ztUser.trim()} -j MARK --set-mark ${markValue} 2>/dev/null || true`);
                }
            } catch (error) {
                // Ignore
            }
            
            // Remove interface-based marking if it exists
            const ztInterface = await this.getZeroTierInterface();
            if (ztInterface) {
                await this.executeCommand(`iptables -t mangle -D OUTPUT -o ${ztInterface} -j MARK --set-mark ${markValue} 2>/dev/null || true`);
            }
            
            // Clean up cgroup if we created it
            try {
                await this.executeCommand('rmdir /sys/fs/cgroup/net_cls/zerotier 2>/dev/null || true');
            } catch (error) {
                // Ignore
            }
            
            // Remove custom routing table and rule
            await this.executeCommand(`ip rule del fwmark ${markValue} table ${tableId} 2>/dev/null || true`);
            await this.executeCommand(`ip route flush table ${tableId} 2>/dev/null || true`);
            
            logger.info('ZeroTier process-based routing cleanup complete');
            
        } catch (error) {
            logger.error('Failed to cleanup process-based routing:', error);
        }
    }

    async cleanupGatewayRouting(isCoordinator = false) {
        try {
            logger.info('Cleaning up gateway routing configuration');
            
            if (isCoordinator) {
                // Clean up coordinator NAT and forwarding rules
                const meshSubnet = process.env.MESH_SUBNET || '192.168.100.0/24';
                const ethernetInterface = process.env.ETHERNET_INTERFACE || 'eth0';
                const batmanInterface = process.env.BATMAN_INTERFACE || 'bat0';
                
                // Remove NAT rules
                await this.executeCommand(`iptables -t nat -D POSTROUTING -s ${meshSubnet} -o ${ethernetInterface} -j MASQUERADE 2>/dev/null || true`);
                
                // Remove forwarding rules
                await this.executeCommand(`iptables -D FORWARD -i ${batmanInterface} -o ${ethernetInterface} -j ACCEPT 2>/dev/null || true`);
                await this.executeCommand(`iptables -D FORWARD -i ${ethernetInterface} -o ${batmanInterface} -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || true`);
                
                logger.info('Coordinator gateway routing cleanup complete');
            } else {
                // Clean up node routing - restore default routes if needed
                const batmanInterface = process.env.BATMAN_INTERFACE || 'bat0';
                const coordinatorIP = process.env.COORDINATOR_BATMAN_IP || '192.168.100.1';
                
                // Remove default route via coordinator
                await this.executeCommand(`ip route del default via ${coordinatorIP} dev ${batmanInterface} 2>/dev/null || true`);
                
                logger.info('Node gateway routing cleanup complete');
            }
            
        } catch (error) {
            logger.error('Failed to cleanup gateway routing:', error);
        }
    }

    async verifyGatewayRouting(isCoordinator = false) {
        try {
            logger.debug('Verifying gateway routing configuration');
            
            if (isCoordinator) {
                // Check coordinator gateway configuration
                const meshSubnet = process.env.MESH_SUBNET || '192.168.100.0/24';
                const ethernetInterface = process.env.ETHERNET_INTERFACE || 'eth0';
                const batmanInterface = process.env.BATMAN_INTERFACE || 'bat0';
                
                // Check IP forwarding
                const ipForwarding = await this.executeCommand('cat /proc/sys/net/ipv4/ip_forward');
                const hasIpForwarding = ipForwarding.trim() === '1';
                
                // Check NAT rules
                const natRules = await this.executeCommand('iptables -t nat -L POSTROUTING -n -v');
                const hasNatRule = natRules.includes('MASQUERADE') && natRules.includes(meshSubnet);
                
                // Check forwarding rules
                const forwardRules = await this.executeCommand('iptables -L FORWARD -n -v');
                const hasForwardRules = forwardRules.includes(batmanInterface) && forwardRules.includes(ethernetInterface);
                
                const status = {
                    role: 'coordinator',
                    hasIpForwarding,
                    hasNatRule,
                    hasForwardRules,
                    isConfigured: hasIpForwarding && hasNatRule && hasForwardRules
                };
                
                logger.debug('Coordinator gateway status:', status);
                return status;
                
            } else {
                // Check node gateway configuration
                const coordinatorIP = process.env.COORDINATOR_BATMAN_IP || '192.168.100.1';
                const batmanInterface = process.env.BATMAN_INTERFACE || 'bat0';
                
                // Check default route
                const routes = await this.executeCommand('ip route show');
                const hasDefaultRoute = routes.includes(`default via ${coordinatorIP} dev ${batmanInterface}`);
                
                // Check mesh subnet route
                const meshSubnet = process.env.MESH_SUBNET || '192.168.100.0/24';
                const hasMeshRoute = routes.includes(`${meshSubnet} dev ${batmanInterface}`) || routes.includes('192.168.100.0/24');
                
                const status = {
                    role: 'node',
                    hasDefaultRoute,
                    hasMeshRoute,
                    isConfigured: hasDefaultRoute && hasMeshRoute
                };
                
                logger.debug('Node gateway status:', status);
                return status;
            }
            
        } catch (error) {
            logger.error('Failed to verify gateway routing:', error);
            return { isConfigured: false, error: error.message };
        }
    }

    async verifyProcessBasedRouting() {
        try {
            const markValue = '0x100';
            const tableId = '100';
            
            logger.debug('Verifying ZeroTier process-based routing configuration');
            
            // Check if iptables rule exists (any of the possible types)
            const iptablesRules = await this.executeCommand('iptables -t mangle -L OUTPUT -n -v');
            
            // More comprehensive checking for marking rules
            const hasUidRule = iptablesRules.includes('owner UID match') && iptablesRules.includes(markValue);
            const hasPortRule = iptablesRules.includes('9993') && iptablesRules.includes(markValue);
            const hasCgroupRule = iptablesRules.includes('cgroup') && iptablesRules.includes(markValue);
            const hasZerotierNameRule = iptablesRules.includes('zerotier-one') && iptablesRules.includes(markValue);
            
            const hasMarkingRule = hasUidRule || hasPortRule || hasCgroupRule || hasZerotierNameRule;
            
            // Check if routing rule exists  
            const ipRules = await this.executeCommand('ip rule show');
            const hasRoutingRule = ipRules.includes(`fwmark ${markValue}`) && ipRules.includes(`lookup ${tableId}`);
            
            // Check if custom table has routes
            let hasCustomRoutes = false;
            try {
                const tableRoutes = await this.executeCommand(`ip route show table ${tableId}`);
                hasCustomRoutes = tableRoutes.includes('default');
            } catch (error) {
                // Table might not exist
            }
            
            // Determine marking method used with more specific detection
            let markingMethod = 'none';
            if (hasUidRule || hasZerotierNameRule) {
                markingMethod = 'uid-based';
            } else if (hasPortRule) {
                markingMethod = 'port-based';
            } else if (hasCgroupRule) {
                markingMethod = 'cgroup-based';
            }
            
            const status = {
                hasMarkingRule,
                hasRoutingRule, 
                hasCustomRoutes,
                markingMethod,
                isConfigured: hasMarkingRule && hasRoutingRule && hasCustomRoutes,
                details: {
                    hasUidRule,
                    hasPortRule,
                    hasCgroupRule,
                    hasZerotierNameRule
                }
            };
            
            logger.debug('Process-based routing status:', status);
            return status;
            
        } catch (error) {
            logger.error('Failed to verify process-based routing:', error);
            return { isConfigured: false, error: error.message };
        }
    }

    async debugRoutingState() {
        try {
            logger.info('=== ZeroTier Routing Debug Information ===');
            
            // Show ZeroTier status
            const status = await this.getStatus();
            logger.info('ZeroTier Online:', status.online);
            logger.info('ZeroTier Networks:', status.networks.length);
            
            // Show iptables mangle rules
            try {
                const iptables = await this.executeCommand('iptables -t mangle -L OUTPUT -n -v --line-numbers');
                logger.info('Iptables mangle OUTPUT rules:\n' + iptables);
            } catch (error) {
                logger.warn('Could not get iptables rules:', error.message);
            }
            
            // Show IP rules
            try {
                const ipRules = await this.executeCommand('ip rule show');
                logger.info('IP routing rules:\n' + ipRules);
            } catch (error) {
                logger.warn('Could not get IP rules:', error.message);
            }
            
            // Show custom table 100
            try {
                const table100 = await this.executeCommand('ip route show table 100');
                logger.info('Custom routing table 100:\n' + table100);
            } catch (error) {
                logger.info('Custom table 100 is empty or does not exist');
            }
            
            // Show main routing table
            try {
                const mainTable = await this.executeCommand('ip route show');
                logger.info('Main routing table:\n' + mainTable);
            } catch (error) {
                logger.warn('Could not get main routing table:', error.message);
            }
            
            // Verify process-based routing (old method)
            const routingStatus = await this.verifyProcessBasedRouting();
            logger.info('Process-based routing status:', routingStatus);
            
            // Verify gateway routing (new method) - try both coordinator and node
            let gatewayStatus = {};
            try {
                gatewayStatus.coordinator = await this.verifyGatewayRouting(true);
                gatewayStatus.node = await this.verifyGatewayRouting(false);
                logger.info('Gateway routing status:', gatewayStatus);
            } catch (error) {
                logger.warn('Could not verify gateway routing:', error.message);
            }
            
            logger.info('=== End Debug Information ===');
            
            return {
                ztStatus: status,
                routingStatus: routingStatus,
                gatewayStatus: gatewayStatus
            };
            
        } catch (error) {
            logger.error('Failed to generate debug information:', error);
            return { error: error.message };
        }
    }

    async testConnectivity() {
        try {
            logger.debug('Testing ZeroTier connectivity...');
            
            const networks = await this.getNetworks();
            const targetNetwork = networks.find(n => n.id === this.networkId);
            
            if (!targetNetwork || targetNetwork.assignedAddresses.length === 0) {
                logger.debug('ZeroTier network not ready for connectivity test');
                return false;
            }
            
            // Test connectivity to ZeroTier's infrastructure
            // First try to ping ZeroTier network peers
            const peers = await this.getPeers();
            let peerConnectivity = false;
            
            for (const peer of peers) {
                if (peer.role === 'PLANET' || peer.role === 'MOON') {
                    try {
                        // Extract IP from paths if available
                        const path = peer.paths.find(p => p.includes('/'));
                        if (path) {
                            const ip = path.split('/')[0];
                            const result = await this.executeCommand(`ping -c 1 -W 2 ${ip} 2>/dev/null || true`);
                            if (result.includes('1 received')) {
                                peerConnectivity = true;
                                break;
                            }
                        }
                    } catch (error) {
                        continue;
                    }
                }
            }
            
            // Test general internet connectivity (this should go through mesh on nodes)
            let internetConnectivity = false;
            try {
                const result = await this.executeCommand(`ping -c 1 -W 3 8.8.8.8 2>/dev/null || true`);
                internetConnectivity = result.includes('1 received');
            } catch (error) {
                // Internet test failed
            }
            
            const connectivityStatus = {
                peerConnectivity,
                internetConnectivity,
                overall: peerConnectivity || internetConnectivity
            };
            
            logger.debug('ZeroTier connectivity test results:', connectivityStatus);
            return connectivityStatus.overall;
            
        } catch (error) {
            logger.debug('ZeroTier connectivity test error:', error.message);
            return false;
        }
    }

    async getPeers() {
        try {
            const output = await this.executeCommand('zerotier-cli peers');
            const peers = [];
            
            const lines = output.split('\n');
            for (const line of lines) {
                if (line.length > 0 && line.startsWith('200 peers') && !line.includes('<ztaddr>')) {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length >= 6) {
                        peers.push({
                            address: parts[2],      // ZT address
                            version: parts[3],      // Version
                            latency: parts[4],      // Latency
                            role: parts[5],         // Role (PLANET, LEAF, etc.)
                            paths: parts.slice(6)   // Connection paths
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

    async getZeroTierInterface() {
        try {
            // First try to get from network list (more reliable)
            const networks = await this.getNetworks();
            if (networks.length > 0 && networks[0].interface) {
                return networks[0].interface;
            }
            
            // Fallback to parsing ip link output
            const interfaces = await this.executeCommand('ip link show | grep zt');
            const lines = interfaces.split('\n');
            
            for (const line of lines) {
                const match = line.match(/\d+:\s+(zt\w+):/);
                if (match) {
                    return match[1];
                }
            }
            
            return null;
            
        } catch (error) {
            logger.error('Failed to get ZeroTier interface:', error);
            return null;
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

    async reconnect() {
        logger.info('Attempting to reconnect ZeroTier...');
        
        try {
            // Restart ZeroTier service
            await this.executeCommand('systemctl restart zerotier-one');
            
            // Wait for service to restart
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            // Rejoin network if needed
            if (this.networkId) {
                await this.joinNetwork(this.networkId);
                await this.waitForNetworkReady();
            }
            
            logger.info('ZeroTier reconnected successfully');
            
        } catch (error) {
            logger.error('Failed to reconnect ZeroTier:', error);
            throw error;
        }
    }

    async authorizeNode(nodeId) {
        if (!this.authToken || !this.networkId) {
            throw new Error('ZeroTier auth token or network ID not configured');
        }
        
        try {
            const url = `https://my.zerotier.com/api/network/${this.networkId}/member/${nodeId}`;
            
            const response = await axios.post(url, {
                config: {
                    authorized: true,
                    ipAssignments: []
                }
            }, {
                headers: {
                    'Authorization': `Bearer ${this.authToken}`,
                    'Content-Type': 'application/json'
                }
            });
            
            logger.info(`Authorized ZeroTier node: ${nodeId}`);
            return response.data;
            
        } catch (error) {
            logger.error(`Failed to authorize ZeroTier node ${nodeId}:`, error);
            throw error;
        }
    }

    async getNetworkMembers() {
        if (!this.authToken || !this.networkId) {
            return [];
        }
        
        try {
            const url = `https://my.zerotier.com/api/network/${this.networkId}/member`;
            
            const response = await axios.get(url, {
                headers: {
                    'Authorization': `Bearer ${this.authToken}`
                }
            });
            
            return response.data;
            
        } catch (error) {
            logger.error('Failed to get ZeroTier network members:', error);
            return [];
        }
    }

    getNetworkId() {
        return this.networkId;
    }

    getInterface() {
        return this.zerotierInterface;
    }

    async monitorProcessBasedRouting() {
        try {
            const markValue = '0x100';
            const tableId = '100';
            
            console.log('=== Process-Based Routing Status ===');
            
            // 1. Check if iptables mangle rules exist
            console.log('\n1. Iptables Mangle Rules (OUTPUT chain):');
            try {
                const iptablesOutput = await this.executeCommand('iptables -t mangle -L OUTPUT -n -v --line-numbers');
                console.log(iptablesOutput);
                
                // Check for specific ZeroTier markings with more comprehensive detection
                const hasUidRule = (iptablesOutput.includes('owner UID match') || iptablesOutput.includes('zerotier-one')) && iptablesOutput.includes(markValue);
                const hasPortRule = iptablesOutput.includes('9993') && iptablesOutput.includes(markValue);
                const hasCgroupRule = iptablesOutput.includes('cgroup') && iptablesOutput.includes(markValue);
                
                console.log(`   ✓ UID-based marking: ${hasUidRule ? 'ENABLED' : 'DISABLED'}`);
                console.log(`   ✓ Port-based marking: ${hasPortRule ? 'ENABLED' : 'DISABLED'}`);
                console.log(`   ✓ Cgroup-based marking: ${hasCgroupRule ? 'ENABLED' : 'DISABLED'}`);
                
                // Show traffic stats for each rule
                if (hasUidRule || hasPortRule || hasCgroupRule) {
                    console.log('\n   Traffic Statistics from iptables:');
                    const lines = iptablesOutput.split('\n');
                    for (const line of lines) {
                        if (line.includes(markValue) && (line.includes('owner') || line.includes('9993') || line.includes('cgroup'))) {
                            const parts = line.trim().split(/\s+/);
                            if (parts.length >= 3) {
                                const ruleNum = parts[0];
                                const packets = parts[1];
                                const bytes = parts[2];
                                console.log(`     Rule ${ruleNum}: ${packets} packets, ${bytes} bytes processed`);
                            }
                        }
                    }
                }
                
            } catch (error) {
                console.log('   ❌ Failed to check iptables rules:', error.message);
            }
            
            // 2. Check IP routing rules for fwmark
            console.log('\n2. IP Routing Rules:');
            try {
                const ipRulesOutput = await this.executeCommand('ip rule show');
                console.log(ipRulesOutput);
                
                const hasFwmarkRule = ipRulesOutput.includes(`fwmark ${markValue}`) && ipRulesOutput.includes(`lookup ${tableId}`);
                console.log(`   ✓ Fwmark rule for ${markValue}: ${hasFwmarkRule ? 'ENABLED' : 'DISABLED'}`);
                
            } catch (error) {
                console.log('   ❌ Failed to check IP rules:', error.message);
            }
            
            // 3. Check custom routing table
            console.log(`\n3. Custom Routing Table ${tableId}:`);
            try {
                const tableOutput = await this.executeCommand(`ip route show table ${tableId}`);
                if (tableOutput.trim()) {
                    console.log(tableOutput);
                    const hasDefaultRoute = tableOutput.includes('default');
                    console.log(`   ✓ Default route via batman: ${hasDefaultRoute ? 'CONFIGURED' : 'MISSING'}`);
                } else {
                    console.log('   ❌ Table is empty or does not exist');
                }
            } catch (error) {
                console.log('   ❌ Failed to check routing table:', error.message);
            }
            
            // 4. Check ZeroTier process info
            console.log('\n4. ZeroTier Process Information:');
            try {
                // Check if zerotier-one user exists
                const ztUID = await this.executeCommand('id -u zerotier-one 2>/dev/null || echo "not-found"');
                if (ztUID !== 'not-found') {
                    console.log(`   ✓ ZeroTier UID: ${ztUID}`);
                } else {
                    console.log('   ⚠ ZeroTier user not found');
                }
                
                // Check ZeroTier service PID
                const pidOutput = await this.executeCommand('systemctl show --property MainPID zerotier-one');
                const pidMatch = pidOutput.match(/MainPID=(\d+)/);
                if (pidMatch && pidMatch[1] !== '0') {
                    console.log(`   ✓ ZeroTier PID: ${pidMatch[1]}`);
                } else {
                    console.log('   ⚠ ZeroTier service not running or no PID found');
                }
                
            } catch (error) {
                console.log('   ❌ Failed to check ZeroTier process:', error.message);
            }
            
            // 5. Traffic statistics for marked packets
            console.log('\n5. Traffic Statistics:');
            try {
                // Check if any packets have been marked
                const iptablesStats = await this.executeCommand('iptables -t mangle -L OUTPUT -n -v');
                const lines = iptablesStats.split('\n');
                
                for (const line of lines) {
                    if (line.includes(markValue) && (line.includes('zerotier') || line.includes('9993') || line.includes('cgroup'))) {
                        const parts = line.trim().split(/\s+/);
                        if (parts.length >= 2) {
                            const packets = parts[0];
                            const bytes = parts[1];
                            console.log(`   ✓ Marked packets: ${packets}, bytes: ${bytes}`);
                        }
                    }
                }
                
                // Check custom table usage (if available)
                const tableStats = await this.executeCommand(`ip route show table ${tableId} 2>/dev/null || echo ""`);
                if (tableStats.includes('default')) {
                    console.log('   ✓ Custom routing table has routes configured');
                }
                
            } catch (error) {
                console.log('   ❌ Failed to get traffic statistics:', error.message);
            }
            
            // 6. Test if rules would work
            console.log('\n6. Configuration Test:');
            const status = await this.verifyProcessBasedRouting();
            console.log(`   ✓ Overall status: ${status.isConfigured ? 'CONFIGURED' : 'NOT CONFIGURED'}`);
            console.log(`   ✓ Marking method: ${status.markingMethod}`);
            console.log(`   ✓ Has marking rule: ${status.hasMarkingRule}`);
            console.log(`   ✓ Has routing rule: ${status.hasRoutingRule}`);
            console.log(`   ✓ Has custom routes: ${status.hasCustomRoutes}`);
            
            console.log('\n=== End Process-Based Routing Status ===');
            
            return status;
            
        } catch (error) {
            console.error('Failed to monitor process-based routing:', error);
            return { error: error.message };
        }
    }

    async testMarkedPacketRouting() {
        try {
            const markValue = '0x100';
            const tableId = '100';
            
            console.log('=== Testing Marked Packet Routing ===');
            
            // 1. Show current interface stats before test
            console.log('\n1. Interface Statistics (Before):');
            try {
                const bat0Before = await this.executeCommand('cat /sys/class/net/bat0/statistics/tx_packets');
                console.log(`   bat0 TX packets: ${bat0Before}`);
                
                const ztInterface = await this.getZeroTierInterface();
                if (ztInterface) {
                    const ztBefore = await this.executeCommand(`cat /sys/class/net/${ztInterface}/statistics/tx_packets`);
                    console.log(`   ${ztInterface} TX packets: ${ztBefore}`);
                }
            } catch (error) {
                console.log('   ❌ Could not read interface statistics');
            }
            
            // 2. Test route lookup for marked packets
            console.log('\n2. Route Lookup Test:');
            try {
                // Test what route would be used for a marked packet
                const routeTest = await this.executeCommand(`ip route get 8.8.8.8 mark ${markValue} 2>/dev/null || echo "failed"`);
                console.log(`   Route for marked packet to 8.8.8.8: ${routeTest}`);
                
                // Check if it mentions batman interface
                if (routeTest.includes('bat0')) {
                    console.log('   ✅ Marked packets would use batman interface');
                } else {
                    console.log('   ❌ Marked packets NOT using batman interface');
                }
            } catch (error) {
                console.log('   ❌ Route lookup test failed:', error.message);
            }
            
            // 3. Manual packet marking test
            console.log('\n3. Manual Packet Test:');
            try {
                // Send a test packet with manual marking
                console.log('   Sending test packet with mark...');
                const testResult = await this.executeCommand(`echo "test" | nc -u -w1 8.8.8.8 53 2>/dev/null || echo "nc test completed"`);
                console.log(`   Test result: ${testResult}`);
            } catch (error) {
                console.log('   ❌ Manual packet test failed:', error.message);
            }
            
            // 4. Show interface stats after test
            console.log('\n4. Interface Statistics (After):');
            try {
                const bat0After = await this.executeCommand('cat /sys/class/net/bat0/statistics/tx_packets');
                console.log(`   bat0 TX packets: ${bat0After}`);
                
                const ztInterface = await this.getZeroTierInterface();
                if (ztInterface) {
                    const ztAfter = await this.executeCommand(`cat /sys/class/net/${ztInterface}/statistics/tx_packets`);
                    console.log(`   ${ztInterface} TX packets: ${ztAfter}`);
                }
            } catch (error) {
                console.log('   ❌ Could not read interface statistics');
            }
            
            // 5. Check iptables counters
            console.log('\n5. Iptables Counters:');
            try {
                const iptablesStats = await this.executeCommand('iptables -t mangle -L OUTPUT -n -v');
                const lines = iptablesStats.split('\n');
                
                for (const line of lines) {
                    if (line.includes(markValue)) {
                        const parts = line.trim().split(/\s+/);
                        if (parts.length >= 3) {
                            const packets = parts[0];
                            const bytes = parts[1];
                            console.log(`   Packets marked: ${packets} (${bytes} bytes)`);
                        }
                    }
                }
            } catch (error) {
                console.log('   ❌ Could not check iptables counters');
            }
            
            // 6. Routing table verification
            console.log('\n6. Routing Table Verification:');
            try {
                const mainTable = await this.executeCommand('ip route show');
                console.log('   Main table:');
                console.log('   ' + mainTable.replace(/\n/g, '\n   '));
                
                const customTable = await this.executeCommand(`ip route show table ${tableId}`);
                console.log(`\n   Custom table ${tableId}:`);
                if (customTable.trim()) {
                    console.log('   ' + customTable.replace(/\n/g, '\n   '));
                } else {
                    console.log('   ❌ Custom table is empty!');
                }
            } catch (error) {
                console.log('   ❌ Could not verify routing tables');
            }
            
            console.log('\n=== End Packet Routing Test ===');
            
        } catch (error) {
            console.error('Failed to test marked packet routing:', error);
        }
    }

    async showTrafficFlow() {
        try {
            console.log('=== ZeroTier Traffic Flow Analysis ===');
            
            // 1. Show all network interfaces
            console.log('\n1. Network Interfaces:');
            const interfaces = await this.executeCommand('ip link show | grep -E "(bat0|zt|eth|wlan)"');
            console.log(interfaces);
            
            // 2. Show routing table
            console.log('\n2. Main Routing Table:');
            const routes = await this.executeCommand('ip route show');
            console.log(routes);
            
            // 3. Show ZeroTier status
            console.log('\n3. ZeroTier Status:');
            const ztStatus = await this.getStatus();
            console.log(`   Online: ${ztStatus.online}`);
            console.log(`   Networks: ${ztStatus.networks.length}`);
            if (ztStatus.networks.length > 0) {
                ztStatus.networks.forEach(net => {
                    console.log(`   - ${net.id}: ${net.status}, IPs: ${net.assignedAddresses.join(', ')}`);
                });
            }
            
            // 4. Test connectivity paths
            console.log('\n4. Connectivity Tests:');
            
            // Test ping to coordinator via batman (if we're a node)
            try {
                const coordinatorIP = process.env.COORDINATOR_BATMAN_IP || '192.168.100.1';
                const pingResult = await this.executeCommand(`ping -c 1 -W 2 ${coordinatorIP} 2>/dev/null || echo "failed"`);
                const success = pingResult.includes('1 received');
                console.log(`   ✓ Batman mesh connectivity: ${success ? 'SUCCESS' : 'FAILED'}`);
            } catch (error) {
                console.log('   ❌ Batman connectivity test failed');
            }
            
            // Test internet connectivity
            try {
                const internetResult = await this.executeCommand(`ping -c 1 -W 3 8.8.8.8 2>/dev/null || echo "failed"`);
                const success = internetResult.includes('1 received');
                console.log(`   ✓ Internet connectivity: ${success ? 'SUCCESS' : 'FAILED'}`);
            } catch (error) {
                console.log('   ❌ Internet connectivity test failed');
            }
            
            // 5. Show active connections
            console.log('\n5. Active Network Connections:');
            try {
                const connections = await this.executeCommand('ss -tuln | head -20');
                console.log(connections);
            } catch (error) {
                console.log('   ❌ Failed to show connections');
            }
            
            console.log('\n=== End Traffic Flow Analysis ===');
            
        } catch (error) {
            console.error('Failed to analyze traffic flow:', error);
        }
    }
}

module.exports = ZeroTierManager;
