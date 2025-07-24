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
        
        logger.info(`Initializing ZeroTier with chroot isolation for network: ${this.networkId}`);
        
        try {
            // First check if we have ZeroTier binaries
            await this.checkZeroTierBinaries();
            
            // Disable system ZeroTier service to prevent conflicts
            await this.disableSystemZeroTier();
            
            // Configure using chroot + namespace isolation
            await this.configureChrootBasedRouting();
            
            logger.info('✅ ZeroTier chroot isolation configured successfully');
            
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
            
            // Kill any running ZeroTier processes using multiple methods
            try {
                await this.executeCommand('pkill -f zerotier-one 2>/dev/null || true');
            } catch (error) {
                logger.debug('pkill failed, trying killall...');
                try {
                    await this.executeCommand('killall zerotier-one 2>/dev/null || true');
                } catch (error2) {
                    logger.debug('killall failed, trying ps + kill...');
                    try {
                        const pids = await this.executeCommand('pgrep -f zerotier-one 2>/dev/null || echo ""');
                        if (pids.trim()) {
                            await this.executeCommand(`kill -TERM ${pids.trim().split('\n').join(' ')} 2>/dev/null || true`);
                        }
                    } catch (error3) {
                        logger.debug('All process killing methods failed, continuing...');
                    }
                }
            }
            
            // Wait for processes to stop
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            logger.info('System ZeroTier service disabled');
            
        } catch (error) {
            logger.warn('Failed to disable system ZeroTier:', error.message);
        }
    }
    
    async checkZeroTierBinaries() {
        try {
            // Check if ZeroTier binaries exist
            await this.executeCommand('which zerotier-one');
            await this.executeCommand('which zerotier-cli');
            
            logger.debug('ZeroTier binaries found');
            
        } catch (error) {
            throw new Error('ZeroTier binaries not found. Please install ZeroTier first.');
        }
    }

    async configureChrootBasedRouting(batmanInterface = 'bat0') {
        try {
            logger.info('Setting up chroot + network namespace isolation for ZeroTier...');
            
            const nsName = 'zt-batman';
            const chrootPath = '/var/lib/zerotier-chroot';
            
            // 1. Setup the chroot environment
            await this.setupZeroTierChroot(chrootPath);
            
            // 2. Create network namespace
            await this.setupNetworkNamespace(nsName, batmanInterface);
            
            // 3. Move ZeroTier into the namespace + chroot
            await this.moveZeroTierToNamespace(nsName, chrootPath);
            
            logger.info('✅ Chroot-based routing configured successfully');
            
        } catch (error) {
            logger.error('Failed to configure chroot-based routing:', error);
            throw error;
        }
    }

    async setupZeroTierChroot(chrootPath) {
        try {
            logger.debug('Setting up ZeroTier chroot environment...');
            
            // Create directory structure explicitly
            const dirs = [
                'bin', 'lib', 'lib64', 'usr/bin', 'usr/sbin', 'usr/lib', 
                'var/lib/zerotier-one', 'proc', 'sys', 'dev', 'etc'
            ];
            
            for (const dir of dirs) {
                await this.executeCommand(`mkdir -p ${chrootPath}/${dir}`);
            }
            
            // Detect actual ZeroTier binary locations
            let zerotierOnePath, zerotierCliPath;
            try {
                zerotierOnePath = await this.executeCommand('which zerotier-one');
                zerotierCliPath = await this.executeCommand('which zerotier-cli');
                logger.debug(`Found ZeroTier binaries: ${zerotierOnePath}, ${zerotierCliPath}`);
            } catch (error) {
                throw new Error('ZeroTier binaries not found in PATH');
            }
            
            // Copy ZeroTier binaries from their actual locations
            // First ensure no ZeroTier processes are running that might lock the files
            try {
                await this.executeCommand('pkill -f zerotier-one 2>/dev/null || true');
                await this.executeCommand('killall zerotier-one 2>/dev/null || true');
                // Wait a moment for processes to fully stop
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (error) {
                logger.debug('Process killing before copy failed, continuing...');
            }
            
            // Use cat instead of cp to avoid "text file busy" errors
            try {
                await this.executeCommand(`cat ${zerotierOnePath} > ${chrootPath}/usr/bin/zerotier-one`);
                await this.executeCommand(`chmod 755 ${chrootPath}/usr/bin/zerotier-one`);
            } catch (error) {
                logger.warn('Failed to copy zerotier-one with cat, trying cp...');
                await this.executeCommand(`cp ${zerotierOnePath} ${chrootPath}/usr/bin/`);
            }
            
            try {
                await this.executeCommand(`cat ${zerotierCliPath} > ${chrootPath}/usr/bin/zerotier-cli`);
                await this.executeCommand(`chmod 755 ${chrootPath}/usr/bin/zerotier-cli`);
            } catch (error) {
                logger.warn('Failed to copy zerotier-cli with cat, trying cp...');
                await this.executeCommand(`cp ${zerotierCliPath} ${chrootPath}/usr/bin/`);
            }
            
            // Copy required libraries (handle both dynamic and static executables)
            try {
                const libraries = await this.executeCommand(`ldd ${zerotierOnePath} | grep "=>" | awk '{print $3}'`);
                if (libraries.trim()) {
                    logger.debug('Copying dynamic libraries for ZeroTier...');
                    for (const lib of libraries.split('\n').filter(l => l.trim())) {
                        const libPath = lib.trim();
                        if (libPath && libPath !== 'null') {
                            const targetDir = `${chrootPath}${libPath.substring(0, libPath.lastIndexOf('/'))}`;
                            await this.executeCommand(`mkdir -p ${targetDir}`);
                            await this.executeCommand(`cp ${libPath} ${chrootPath}${libPath} 2>/dev/null || true`);
                        }
                    }
                } else {
                    logger.debug('ZeroTier appears to be statically linked, skipping library copying');
                }
            } catch (error) {
                logger.debug('ZeroTier appears to be statically linked or ldd failed, skipping library copying');
            }
            
            // Copy essential system libraries that might be needed regardless
            const essentialLibs = [
                '/lib64/ld-linux-x86-64.so.2',
                '/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2',
                '/usr/lib64/ld-linux-x86-64.so.2',
                '/lib/ld-linux.so.2',
                '/lib64/libc.so.6',
                '/lib/x86_64-linux-gnu/libc.so.6'
            ];
            
            for (const lib of essentialLibs) {
                try {
                    const targetDir = `${chrootPath}${lib.substring(0, lib.lastIndexOf('/'))}`;
                    await this.executeCommand(`mkdir -p ${targetDir}`);
                    await this.executeCommand(`cp ${lib} ${chrootPath}${lib} 2>/dev/null || true`);
                } catch (error) {
                    // Ignore errors - these libraries might not exist on all systems
                }
            }
            
            // Copy essential files
            await this.executeCommand(`cp /etc/resolv.conf ${chrootPath}/etc/ 2>/dev/null || true`);
            await this.executeCommand(`cp /etc/hosts ${chrootPath}/etc/ 2>/dev/null || true`);
            
            // Create device nodes
            await this.executeCommand(`mknod ${chrootPath}/dev/null c 1 3 2>/dev/null || true`);
            await this.executeCommand(`mknod ${chrootPath}/dev/zero c 1 5 2>/dev/null || true`);
            await this.executeCommand(`mknod ${chrootPath}/dev/random c 1 8 2>/dev/null || true`);
            await this.executeCommand(`mknod ${chrootPath}/dev/urandom c 1 9 2>/dev/null || true`);
            
            // Set permissions
            await this.executeCommand(`chmod 755 ${chrootPath}/usr/bin/zerotier-*`);
            await this.executeCommand(`chmod 755 ${chrootPath}/var/lib/zerotier-one`);
            
            logger.debug('✅ Chroot environment setup complete');
            
        } catch (error) {
            logger.error('Failed to setup chroot environment:', error);
            throw error;
        }
    }

    async setupNetworkNamespace(nsName, batmanInterface) {
        try {
            logger.debug('Setting up network namespace...');
            
            // Delete existing namespace if it exists
            await this.executeCommand(`ip netns del ${nsName} 2>/dev/null || true`);
            
            // Create new network namespace
            await this.executeCommand(`ip netns add ${nsName}`);
            
            // Create veth pair
            const vethHost = 'veth-zt-host';
            const vethNs = 'veth-zt-ns';
            
            await this.executeCommand(`ip link del ${vethHost} 2>/dev/null || true`);
            await this.executeCommand(`ip link add ${vethHost} type veth peer name ${vethNs}`);
            
            // Move one end to namespace
            await this.executeCommand(`ip link set ${vethNs} netns ${nsName}`);
            
            // Create bridge and add batman interface
            const bridgeName = 'br-zt-batman';
            await this.executeCommand(`ip link del ${bridgeName} 2>/dev/null || true`);
            await this.executeCommand(`ip link add name ${bridgeName} type bridge`);
            await this.executeCommand(`ip link set ${bridgeName} up`);
            
            // Add batman interface to bridge
            await this.executeCommand(`ip link set ${batmanInterface} master ${bridgeName}`);
            
            // Add veth host end to bridge  
            await this.executeCommand(`ip link set ${vethHost} master ${bridgeName}`);
            await this.executeCommand(`ip link set ${vethHost} up`);
            
            // Configure namespace side
            await this.executeCommand(`ip netns exec ${nsName} ip link set lo up`);
            await this.executeCommand(`ip netns exec ${nsName} ip link set ${vethNs} up`);
            
            // Give namespace access only to batman network via bridge
            // The namespace will inherit batman's network connectivity
            await this.executeCommand(`ip netns exec ${nsName} ip addr add 169.254.1.100/30 dev ${vethNs}`);
            await this.executeCommand(`ip addr add 169.254.1.101/30 dev ${vethHost}`);
            
            logger.debug('✅ Network namespace setup complete');
            
        } catch (error) {
            logger.error('Failed to setup network namespace:', error);
            throw error;
        }
    }

    async moveZeroTierToNamespace(nsName, chrootPath) {
        try {
            logger.debug('Starting ZeroTier in namespace + chroot as subprocess');
            
            // Stop existing ZeroTier service (already done in initialize, but double-check)
            await this.executeCommand('systemctl stop zerotier-one 2>/dev/null || true');
            
            // Kill any running ZeroTier processes using multiple methods
            try {
                await this.executeCommand('pkill -f zerotier-one 2>/dev/null || true');
            } catch (error) {
                try {
                    await this.executeCommand('killall zerotier-one 2>/dev/null || true');
                } catch (error2) {
                    try {
                        const pids = await this.executeCommand('pgrep -f zerotier-one 2>/dev/null || echo ""');
                        if (pids.trim()) {
                            await this.executeCommand(`kill -TERM ${pids.trim().split('\n').join(' ')} 2>/dev/null || true`);
                        }
                    } catch (error3) {
                        logger.debug('All process killing methods failed, continuing...');
                    }
                }
            }
            
            // Copy ZeroTier data to chroot
            await this.executeCommand(`cp -r /var/lib/zerotier-one/* ${chrootPath}/var/lib/zerotier-one/ 2>/dev/null || true`);
            
            // Mount proc and sys in chroot
            await this.executeCommand(`mount -t proc proc ${chrootPath}/proc 2>/dev/null || true`);
            await this.executeCommand(`mount -t sysfs sysfs ${chrootPath}/sys 2>/dev/null || true`);
            
            // Start ZeroTier as a subprocess in the namespace + chroot
            const command = `ip netns exec ${nsName} chroot ${chrootPath} /usr/bin/zerotier-one`;
            logger.debug(`Starting ZeroTier subprocess: ${command}`);
            
            // Use spawn to run as background process
            this.zerotierProcess = spawn('ip', ['netns', 'exec', nsName, 'chroot', chrootPath, '/usr/bin/zerotier-one'], {
                detached: true,
                stdio: ['ignore', 'ignore', 'ignore']
            });
            
            this.zerotierProcess.unref(); // Allow parent to exit without waiting
            
            // Store process info for cleanup
            this.chrootPath = chrootPath;
            this.nsName = nsName;
            
            // Wait for ZeroTier to start
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            // Verify it's running in namespace
            const nsProcesses = await this.executeCommand(`ip netns exec ${nsName} ps aux | grep zerotier || echo "not found"`);
            if (!nsProcesses.includes('zerotier-one')) {
                throw new Error('ZeroTier failed to start in network namespace');
            }
            
            logger.debug('✅ ZeroTier subprocess started in network namespace');
            
            // Join the ZeroTier network if specified
            if (this.networkId) {
                logger.info(`Joining ZeroTier network ${this.networkId} in namespace...`);
                
                // First check if ZeroTier is responding
                try {
                    const infoResult = await this.executeCommand(`ip netns exec ${nsName} chroot ${chrootPath} /usr/bin/zerotier-cli info`);
                    logger.debug(`ZeroTier info before joining: ${infoResult}`);
                } catch (infoError) {
                    logger.warn(`ZeroTier CLI not responding before join: ${infoError.message}`);
                }
                
                // Join the network
                const joinResult = await this.executeCommand(`ip netns exec ${nsName} chroot ${chrootPath} /usr/bin/zerotier-cli join ${this.networkId}`);
                logger.debug(`ZeroTier join result: ${joinResult}`);
                
                // Wait for network to be ready
                await this.waitForNamespacedZeroTierReady(nsName, chrootPath);
            }
            
        } catch (error) {
            logger.error('Failed to move ZeroTier to namespace:', error);
            throw error;
        }
    }
    
    async waitForNamespacedZeroTierReady(nsName, chrootPath, maxAttempts = 30) {
        logger.info('Waiting for ZeroTier network to be ready in namespace...');
        
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                // First check if ZeroTier process is still running in namespace
                const nsProcesses = await this.executeCommand(`ip netns exec ${nsName} ps aux | grep zerotier || echo "not found"`);
                if (!nsProcesses.includes('zerotier-one')) {
                    logger.warn('ZeroTier process not found in namespace, attempting to restart...');
                    throw new Error('ZeroTier process died in namespace');
                }
                
                // Check ZeroTier info to see if it's responding
                let infoOutput;
                try {
                    infoOutput = await this.executeCommand(`ip netns exec ${nsName} chroot ${chrootPath} /usr/bin/zerotier-cli info`);
                    logger.debug(`ZeroTier info (attempt ${attempt}): ${infoOutput}`);
                } catch (infoError) {
                    logger.debug(`ZeroTier CLI not responding yet (attempt ${attempt}): ${infoError.message}`);
                    
                    // If we're past attempt 10 and CLI still not responding, something is wrong
                    if (attempt > 10) {
                        logger.warn('ZeroTier CLI not responding after 10 attempts, this may indicate a problem');
                        // Don't continue waiting if CLI is completely unresponsive
                        throw new Error('ZeroTier CLI unresponsive in namespace');
                    }
                    
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    continue;
                }
                
                const networks = await this.getNamespacedNetworks(nsName, chrootPath);
                logger.debug(`ZeroTier networks (attempt ${attempt}):`, networks);
                
                const targetNetwork = networks.find(n => n.id === this.networkId);
                
                if (targetNetwork && 
                    targetNetwork.status === 'OK' && 
                    targetNetwork.assignedAddresses.length > 0) {
                    logger.info(`ZeroTier network ready in namespace with IP: ${targetNetwork.assignedAddresses[0]}`);
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
                
                // If we hit certain errors multiple times, give up early
                if (error.message.includes('ZeroTier CLI unresponsive') || 
                    error.message.includes('ZeroTier process died')) {
                    throw error;
                }
                
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        
        // Final diagnostic before giving up
        try {
            logger.warn('ZeroTier network readiness timeout - running final diagnostics...');
            const finalInfo = await this.executeCommand(`ip netns exec ${nsName} chroot ${chrootPath} /usr/bin/zerotier-cli info 2>&1 || echo "CLI failed"`);
            const finalNetworks = await this.executeCommand(`ip netns exec ${nsName} chroot ${chrootPath} /usr/bin/zerotier-cli listnetworks 2>&1 || echo "listnetworks failed"`);
            logger.warn(`Final ZeroTier info: ${finalInfo}`);
            logger.warn(`Final ZeroTier networks: ${finalNetworks}`);
        } catch (diagError) {
            logger.warn('Failed to run final diagnostics:', diagError.message);
        }
        
        throw new Error('ZeroTier network ready timeout in namespace - check network authorization on ZeroTier Central');
    }
    
    async getNamespacedNetworks(nsName, chrootPath) {
        try {
            const output = await this.executeCommand(`ip netns exec ${nsName} chroot ${chrootPath} /usr/bin/zerotier-cli listnetworks`);
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
            logger.error('Failed to get namespaced ZeroTier networks:', error);
            return [];
        }
    }
    
    async getStatus() {
        try {
            // If we have namespace info, use namespaced commands
            if (this.nsName && this.chrootPath) {
                const networks = await this.getNamespacedNetworks(this.nsName, this.chrootPath);
                return {
                    online: networks.length > 0 && networks.some(n => n.status === 'OK'),
                    networks: networks
                };
            }
            
            // Otherwise return offline status
            return {
                online: false,
                networks: []
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
            
            // For chroot-based setup, just check if it's still running
            if (this.zerotierProcess && !this.zerotierProcess.killed) {
                logger.debug('ZeroTier process still running, checking network status...');
                const status = await this.getStatus();
                if (status.online) {
                    logger.info('ZeroTier reconnection successful');
                    return;
                }
            }
            
            // If process died or not connected, restart it
            logger.info('Restarting ZeroTier chroot setup...');
            await this.cleanupChrootRouting();
            await this.configureChrootBasedRouting();
            
        } catch (error) {
            logger.error('Failed to reconnect ZeroTier:', error);
            throw error;
        }
    }

    async cleanupChrootRouting() {
        try {
            logger.info('Cleaning up chroot-based routing...');
            
            // Kill ZeroTier subprocess if it exists
            if (this.zerotierProcess && !this.zerotierProcess.killed) {
                logger.debug('Terminating ZeroTier subprocess...');
                this.zerotierProcess.kill('SIGTERM');
                
                // Give it a moment to shut down gracefully
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                // Force kill if still running
                if (!this.zerotierProcess.killed) {
                    this.zerotierProcess.kill('SIGKILL');
                }
            }
            
            // Kill any remaining ZeroTier processes using multiple methods
            try {
                await this.executeCommand('pkill -f zerotier-one 2>/dev/null || true');
            } catch (error) {
                try {
                    await this.executeCommand('killall zerotier-one 2>/dev/null || true');
                } catch (error2) {
                    try {
                        const pids = await this.executeCommand('pgrep -f zerotier-one 2>/dev/null || echo ""');
                        if (pids.trim()) {
                            await this.executeCommand(`kill -TERM ${pids.trim().split('\n').join(' ')} 2>/dev/null || true`);
                        }
                    } catch (error3) {
                        logger.debug('All process killing methods failed in cleanup, continuing...');
                    }
                }
            }
            
            // Clean up network namespace
            const nsName = this.nsName || 'zt-batman';
            await this.executeCommand(`ip netns del ${nsName} 2>/dev/null || true`);
            
            // Clean up veth and bridge
            await this.executeCommand('ip link del veth-zt-host 2>/dev/null || true');
            await this.executeCommand('ip link del br-zt-batman 2>/dev/null || true');
            
            // Unmount and clean up chroot
            const chrootPath = this.chrootPath || '/var/lib/zerotier-chroot';
            await this.executeCommand(`umount ${chrootPath}/proc ${chrootPath}/sys 2>/dev/null || true`);
            await this.executeCommand(`rm -rf ${chrootPath} 2>/dev/null || true`);
            
            // Clear process references
            this.zerotierProcess = null;
            this.chrootPath = null;
            this.nsName = null;
            
            logger.info('✅ Chroot routing cleanup completed');
            
        } catch (error) {
            logger.error('Failed to cleanup chroot routing:', error);
        }
    }

    async cleanup() {
        logger.info('Cleaning up ZeroTier...');
        
        try {
            // Clean up chroot-based routing
            await this.cleanupChrootRouting();
            
            logger.info('✅ ZeroTier cleanup completed');
            
        } catch (error) {
            logger.error('Failed to cleanup ZeroTier:', error);
            // Don't throw on cleanup errors
        }
    }
}

module.exports = ZeroTierManager;
