#!/usr/bin/env node

const NetworkManager = require('./src/services/NetworkManager');

async function testNodeIPGeneration() {
    console.log('=== Testing Node IP Generation ===');
    
    const netManager = new NetworkManager();
    
    try {
        // Test IP generation multiple times to see consistency
        console.log('\nTesting IP generation:');
        for (let i = 0; i < 5; i++) {
            const nodeIP = await netManager.generateNodeIP();
            console.log(`Attempt ${i + 1}: ${nodeIP}`);
        }
        
        // Show master IP for comparison
        console.log(`\nMaster IP: ${process.env.MASTER_IP || '192.168.100.1'}`);
        console.log(`Mesh Subnet: ${process.env.MESH_SUBNET || '192.168.100.0/24'}`);
        
        // Show current batman interface IP if it exists
        console.log('\nCurrent batman interface status:');
        try {
            const currentIP = await netManager.getBatmanInterfaceIP();
            if (currentIP) {
                console.log(`Current batman IP: ${currentIP}`);
            } else {
                console.log('Batman interface not configured or no IP assigned');
            }
            
            // Show batman interface details
            const batmanInfo = await netManager.executeCommand('ip addr show bat0 2>/dev/null || echo "Batman interface not found"');
            console.log('\nBatman interface details:');
            console.log(batmanInfo);
            
        } catch (error) {
            console.log('Batman interface not available:', error.message);
        }
        
        // Show system MAC addresses for reference
        console.log('\nSystem network interfaces:');
        const os = require('os');
        const interfaces = os.networkInterfaces();
        for (const [name, addrs] of Object.entries(interfaces)) {
            for (const addr of addrs) {
                if (!addr.internal && addr.mac && addr.mac !== '00:00:00:00:00:00') {
                    console.log(`${name}: ${addr.mac} (${addr.family})`);
                    break;
                }
            }
        }
        
        console.log('\n=== Test Complete ===');
        
    } catch (error) {
        console.error('Test failed:', error);
        process.exit(1);
    }
}

// Allow running as both script and module
if (require.main === module) {
    testNodeIPGeneration();
}

module.exports = { testNodeIPGeneration };
