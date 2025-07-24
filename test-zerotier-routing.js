#!/usr/bin/env node

// Test script to verify ZeroTier process-based routing configuration
const ZeroTierManager = require('./src/services/ZeroTierManager');

async function testProcessRouting() {
    console.log('Testing ZeroTier Process-Based Routing Configuration...');
    
    const ztManager = new ZeroTierManager();
    
    try {
        // Test the routing configuration setup
        console.log('\n--- Testing Configuration Setup ---');
        await ztManager.configureProcessBasedRouting('bat0');
        
        // Verify the configuration
        console.log('\n--- Verifying Configuration ---');
        const status = await ztManager.verifyProcessBasedRouting();
        console.log('Routing status:', status);
        
        // Test commands that should be configured
        console.log('\n--- Testing Individual Components ---');
        
        // Check iptables rules
        try {
            const iptablesOutput = await ztManager.executeCommand('iptables -t mangle -L OUTPUT -n -v | grep -E "(zerotier|0x100)"');
            console.log('✓ Found iptables marking rules:', iptablesOutput ? 'Yes' : 'No');
        } catch (error) {
            console.log('✗ No iptables marking rules found');
        }
        
        // Check ip rules
        try {
            const ipRulesOutput = await ztManager.executeCommand('ip rule show | grep -E "(0x100|100)"');
            console.log('✓ Found custom routing rules:', ipRulesOutput ? 'Yes' : 'No');
        } catch (error) {
            console.log('✗ No custom routing rules found');
        }
        
        // Check custom routing table
        try {
            const tableOutput = await ztManager.executeCommand('ip route show table 100');
            console.log('✓ Custom routing table has routes:', tableOutput ? 'Yes' : 'No');
        } catch (error) {
            console.log('✗ No routes in custom table 100');
        }
        
        // Test cleanup
        console.log('\n--- Testing Cleanup ---');
        await ztManager.cleanupProcessBasedRouting();
        
        const statusAfterCleanup = await ztManager.verifyProcessBasedRouting();
        console.log('Status after cleanup:', statusAfterCleanup);
        
        console.log('\n--- Test Summary ---');
        console.log('✓ Configuration setup:', status.isConfigured ? 'PASS' : 'FAIL');
        console.log('✓ Cleanup successful:', !statusAfterCleanup.isConfigured ? 'PASS' : 'FAIL');
        
    } catch (error) {
        console.error('Test failed:', error);
    }
}

async function showCurrentNetworkState() {
    console.log('\n=== Current Network State ===');
    
    const ztManager = new ZeroTierManager();
    
    try {
        // Show current iptables mangle rules
        console.log('\n--- Current iptables mangle OUTPUT rules ---');
        const iptables = await ztManager.executeCommand('iptables -t mangle -L OUTPUT -n -v --line-numbers || true');
        console.log(iptables || 'No rules found');
        
        // Show current ip rules
        console.log('\n--- Current IP rules ---');
        const ipRules = await ztManager.executeCommand('ip rule show || true');
        console.log(ipRules || 'No rules found');
        
        // Show routing tables
        console.log('\n--- Main routing table ---');
        const mainTable = await ztManager.executeCommand('ip route show || true');
        console.log(mainTable || 'No routes found');
        
        // Show custom table 100 if it exists
        console.log('\n--- Custom table 100 ---');
        const customTable = await ztManager.executeCommand('ip route show table 100 2>/dev/null || echo "Table 100 empty or not found"');
        console.log(customTable);
        
        // Show ZeroTier status
        console.log('\n--- ZeroTier Status ---');
        const ztStatus = await ztManager.getStatus();
        console.log('Online:', ztStatus.online);
        console.log('Networks:', ztStatus.networks.length);
        if (ztStatus.networks.length > 0) {
            ztStatus.networks.forEach(network => {
                console.log(`  - ${network.id}: ${network.status} (${network.assignedAddresses.join(', ')})`);
            });
        }
        
    } catch (error) {
        console.error('Failed to show network state:', error);
    }
}

if (require.main === module) {
    const command = process.argv[2];
    
    if (command === 'state') {
        showCurrentNetworkState().catch(console.error);
    } else {
        testProcessRouting().catch(console.error);
    }
}
