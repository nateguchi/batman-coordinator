#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

class SetupScript {
    constructor() {
        this.platform = process.platform;
        this.isRoot = process.getuid && process.getuid() === 0;
        this.logFile = path.join(__dirname, '..', 'logs', 'setup.log');
    }

    async run() {
        console.log('🚀 Batman Mesh Coordinator Setup');
        console.log('=====================================\n');

        try {
            // Create logs directory
            await this.createDirectories();
            
            // Check prerequisites
            await this.checkPrerequisites();
            
            // Setup environment
            await this.setupEnvironment();
            
            // Install dependencies
            await this.installDependencies();
            
            // Configure system
            await this.configureSystem();
            
            console.log('\n✅ Setup completed successfully!');
            console.log('\nNext steps:');
            console.log('1. Configure your .env file');
            console.log('2. Run "npm run coordinator" on the master node');
            console.log('3. Run "npm run mesh-node" on mesh nodes');
            
        } catch (error) {
            console.error('\n❌ Setup failed:', error.message);
            console.log('Check logs for details:', this.logFile);
            process.exit(1);
        }
    }

    async createDirectories() {
        console.log('📁 Creating directories...');
        
        const dirs = [
            path.join(__dirname, '..', 'logs'),
            '/etc/batman-coordinator',
            '/var/lib/batman-coordinator'
        ];

        for (const dir of dirs) {
            try {
                await fs.promises.mkdir(dir, { recursive: true });
                console.log(`   Created: ${dir}`);
            } catch (error) {
                if (error.code !== 'EEXIST') {
                    throw error;
                }
            }
        }
    }

    async checkPrerequisites() {
        console.log('\n🔍 Checking prerequisites...');
        
        // Check if running on Linux
        if (this.platform !== 'linux') {
            throw new Error('This system only works on Linux');
        }

        // Check if running as root
        if (!this.isRoot) {
            console.log('   ⚠️  Not running as root - some features may not work');
        }

        // Check Node.js version
        const nodeVersion = process.version;
        const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0]);
        if (majorVersion < 14) {
            throw new Error(`Node.js 14+ required, found ${nodeVersion}`);
        }
        console.log(`   ✓ Node.js ${nodeVersion}`);

        // Check for required commands
        const commands = [
            'ip', 'iw', 'batctl', 'iptables', 'systemctl'
        ];

        for (const cmd of commands) {
            try {
                await execAsync(`which ${cmd}`);
                console.log(`   ✓ ${cmd} found`);
            } catch (error) {
                console.log(`   ❌ ${cmd} not found - please install batman-adv and related tools`);
            }
        }

        // Check for ZeroTier
        try {
            await execAsync('which zerotier-cli');
            console.log('   ✓ ZeroTier found');
        } catch (error) {
            console.log('   ❌ ZeroTier not found - please install ZeroTier');
        }
    }

    async setupEnvironment() {
        console.log('\n⚙️  Setting up environment...');
        
        // Copy example .env if it doesn't exist
        const envPath = path.join(__dirname, '..', '.env');
        const envExamplePath = path.join(__dirname, '..', '.env.example');
        
        if (!fs.existsSync(envPath)) {
            try {
                await fs.promises.copyFile(envExamplePath, envPath);
                console.log('   ✓ Created .env file from example');
                console.log('   ⚠️  Please edit .env file with your configuration');
            } catch (error) {
                console.log('   ❌ Failed to create .env file');
            }
        } else {
            console.log('   ✓ .env file already exists');
        }
    }

    async installDependencies() {
        console.log('\n📦 Installing dependencies...');
        
        try {
            await execAsync('npm install', { cwd: path.join(__dirname, '..') });
            console.log('   ✓ NPM dependencies installed');
        } catch (error) {
            throw new Error('Failed to install NPM dependencies: ' + error.message);
        }
    }

    async configureSystem() {
        console.log('\n🔧 Configuring system...');
        
        if (!this.isRoot) {
            console.log('   ⚠️  Skipping system configuration (not root)');
            return;
        }

        try {
            // Enable batman-adv module loading
            await this.enableBatmanModule();
            
            // Create systemd service files
            await this.createSystemdServices();
            
            // Configure network forwarding
            await this.configureNetworkForwarding();
            
            console.log('   ✓ System configuration complete');
            
        } catch (error) {
            console.log(`   ❌ System configuration failed: ${error.message}`);
        }
    }

    async enableBatmanModule() {
        try {
            // Add batman-adv to modules
            const modulesContent = 'batman-adv\n';
            await fs.promises.writeFile('/etc/modules-load.d/batman.conf', modulesContent);
            
            // Load module now
            await execAsync('modprobe batman-adv');
            
            console.log('   ✓ Batman-adv module configured');
        } catch (error) {
            console.log(`   ❌ Failed to configure batman-adv module: ${error.message}`);
        }
    }

    async createSystemdServices() {
        try {
            const coordinatorService = `[Unit]
Description=Batman Mesh Coordinator
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${path.join(__dirname, '..')}
ExecStart=/usr/bin/node src/coordinator.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
`;

            const nodeService = `[Unit]
Description=Batman Mesh Node
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${path.join(__dirname, '..')}
ExecStart=/usr/bin/node src/mesh-node.js
Restart=always
RestartSec=10
Environment=NODE_ENV=node

[Install]
WantedBy=multi-user.target
`;

            await fs.promises.writeFile('/etc/systemd/system/batman-coordinator.service', coordinatorService);
            await fs.promises.writeFile('/etc/systemd/system/batman-node.service', nodeService);
            
            // Reload systemd
            await execAsync('systemctl daemon-reload');
            
            console.log('   ✓ Systemd services created');
        } catch (error) {
            console.log(`   ❌ Failed to create systemd services: ${error.message}`);
        }
    }

    async configureNetworkForwarding() {
        try {
            const sysctlConfig = `# Batman mesh coordinator network configuration
net.ipv4.ip_forward=1
net.ipv6.conf.all.forwarding=1
`;
            
            await fs.promises.writeFile('/etc/sysctl.d/99-batman-coordinator.conf', sysctlConfig);
            await execAsync('sysctl -p /etc/sysctl.d/99-batman-coordinator.conf');
            
            console.log('   ✓ Network forwarding configured');
        } catch (error) {
            console.log(`   ❌ Failed to configure network forwarding: ${error.message}`);
        }
    }

    async log(message) {
        const timestamp = new Date().toISOString();
        const logMessage = `${timestamp}: ${message}\n`;
        
        try {
            await fs.promises.appendFile(this.logFile, logMessage);
        } catch (error) {
            // Ignore log errors
        }
    }
}

// Run setup if called directly
if (require.main === module) {
    const setup = new SetupScript();
    setup.run().catch(error => {
        console.error('Setup failed:', error);
        process.exit(1);
    });
}

module.exports = SetupScript;
