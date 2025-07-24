#!/usr/bin/env node

// Test script to check for conflicting ZeroTier routing rules
const ZeroTierManager = require('./src/services/ZeroTierManager');

async function checkConflictingRules() {
    console.log('Checking for conflicting ZeroTier routing rules...\n');
    
    const ztManager = new ZeroTierManager();
    
    try {
        // Check for old conflicting iptables rules
        console.log('=== Checking iptables rules ===');
        
        try {
            const dropRules = await ztManager.executeCommand('iptables -L OUTPUT -n -v | grep -E "(DROP.*9993|9993.*DROP)" || echo "No DROP rules for port 9993"');
            console.log('ZeroTier DROP rules:', dropRules);
        } catch (error) {
            console.log('Could not check DROP rules');
        }
        
        try {
            const mangleRules = await ztManager.executeCommand('iptables -t mangle -L OUTPUT -n -v | grep -E "(9993|zerotier|0x100)" || echo "No mangle rules found"');
            console.log('Mangle rules:', mangleRules);
        } catch (error) {
            console.log('Could not check mangle rules');
        }
        
        // Check for old routing rules
        console.log('\n=== Checking IP rules ===');
        
        try {
            const ipRules = await ztManager.executeCommand('ip rule show | grep -E "(zerotier|0x1|100)" || echo "No custom routing rules"');
            console.log('Custom IP rules:', ipRules);
        } catch (error) {
            console.log('Could not check IP rules');
        }
        
        // Check routing tables
        console.log('\n=== Checking routing tables ===');
        
        try {
            const table100 = await ztManager.executeCommand('ip route show table 100 || echo "Table 100 empty"');
            console.log('Table 100:', table100);
        } catch (error) {
            console.log('Table 100: Not accessible or empty');
        }
        
        try {
            const tableZerotier = await ztManager.executeCommand('ip route show table zerotier || echo "Table zerotier empty"');
            console.log('Table zerotier:', tableZerotier);
        } catch (error) {
            console.log('Table zerotier: Not accessible or empty');
        }
        
        // Check ZeroTier status
        console.log('\n=== ZeroTier Status ===');
        
        const ztStatus = await ztManager.getStatus();
        console.log('ZeroTier online:', ztStatus.online);
        console.log('Networks:', ztStatus.networks.length);
        if (ztStatus.networks.length > 0) {
            ztStatus.networks.forEach(network => {
                console.log(`  - ${network.id}: ${network.status} (Interface: ${network.interface})`);
                console.log(`    IPs: ${network.assignedAddresses.join(', ')}`);
            });
        }
        
        // Run cleanup
        console.log('\n=== Running Cleanup ===');
        await ztManager.cleanupConflictingRules();
        console.log('Cleanup complete');
        
        // Verify process-based routing configuration
        console.log('\n=== Testing Process-Based Routing ===');
        const batmanInterface = process.env.BATMAN_INTERFACE || 'bat0';
        await ztManager.configureProcessBasedRouting(batmanInterface);
        
        const routingStatus = await ztManager.verifyProcessBasedRouting();
        console.log('Routing configured:', routingStatus.isConfigured);
        console.log('Marking method:', routingStatus.markingMethod);
        console.log('Details:', routingStatus);
        
    } catch (error) {
        console.error('Test failed:', error);
    }
}

if (require.main === module) {
    checkConflictingRules().catch(console.error);
}
