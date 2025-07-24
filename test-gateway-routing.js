#!/usr/bin/env node

const ZeroTierManager = require('./src/services/ZeroTierManager');

async function testGatewayRouting() {
    console.log('=== Testing Gateway Routing Configuration ===');
    
    const ztManager = new ZeroTierManager();
    
    try {
        // Test as coordinator
        console.log('\n--- Testing Coordinator Gateway Setup ---');
        await ztManager.configureCoordinatorGateway('bat0');
        console.log('✓ Coordinator gateway configured');
        
        // Show current iptables NAT rules
        console.log('\nCurrent NAT rules:');
        const natRules = await ztManager.executeCommand('iptables -t nat -L POSTROUTING -n -v');
        console.log(natRules);
        
        // Show current forwarding rules  
        console.log('\nCurrent FORWARD rules:');
        const forwardRules = await ztManager.executeCommand('iptables -L FORWARD -n -v');
        console.log(forwardRules);
        
        // Test cleanup
        console.log('\n--- Testing Coordinator Cleanup ---');
        await ztManager.cleanupGatewayRouting(true);
        console.log('✓ Coordinator gateway cleanup complete');
        
        // Show NAT rules after cleanup (should be empty)
        console.log('\nNAT rules after coordinator cleanup:');
        const natAfterCleanup = await ztManager.executeCommand('iptables -t nat -L POSTROUTING -n -v');
        console.log(natAfterCleanup);
        
        // Test as node
        console.log('\n--- Testing Node Gateway Setup ---');
        await ztManager.configureNodeGatewayRouting('bat0');
        console.log('✓ Node gateway configured');
        
        // Show current routing table
        console.log('\nCurrent routing table:');
        const routes = await ztManager.executeCommand('ip route show');
        console.log(routes);
        
        // Test node cleanup
        console.log('\n--- Testing Node Cleanup ---');
        await ztManager.cleanupGatewayRouting(false);
        console.log('✓ Node gateway cleanup complete');
        
        // Show routing table after cleanup
        console.log('\nRouting table after node cleanup:');
        const routesAfterCleanup = await ztManager.executeCommand('ip route show');
        console.log(routesAfterCleanup);
        
        console.log('\n=== Gateway Routing Test Complete ===');
        
    } catch (error) {
        console.error('Test failed:', error);
        process.exit(1);
    }
}

// Allow running as both script and module
if (require.main === module) {
    const args = process.argv.slice(2);
    
    if (args.includes('--help') || args.includes('-h')) {
        console.log(`
Usage: node test-gateway-routing.js [options]

Options:
  --coordinator    Test coordinator gateway setup only
  --node          Test node gateway setup only  
  --cleanup       Test cleanup only
  --status        Show current gateway status
  --help, -h      Show this help
`);
        process.exit(0);
    }
    
    if (args.includes('--status')) {
        console.log('=== Current Gateway Status ===');
        const ztManager = new ZeroTierManager();
        
        (async () => {
            try {
                console.log('\nNAT rules:');
                const nat = await ztManager.executeCommand('iptables -t nat -L POSTROUTING -n --line-numbers');
                console.log(nat);
                
                console.log('\nForward rules:');
                const forward = await ztManager.executeCommand('iptables -L FORWARD -n --line-numbers');
                console.log(forward);
                
                console.log('\nRouting table:');
                const routes = await ztManager.executeCommand('ip route show');
                console.log(routes);
                
                console.log('\nIP forwarding status:');
                const forwarding = await ztManager.executeCommand('cat /proc/sys/net/ipv4/ip_forward');
                console.log(`IP forwarding: ${forwarding}`);
                
            } catch (error) {
                console.error('Status check failed:', error);
            }
        })();
    } else if (args.includes('--coordinator')) {
        (async () => {
            const ztManager = new ZeroTierManager();
            await ztManager.configureCoordinatorGateway('bat0');
            console.log('Coordinator gateway configured');
        })();
    } else if (args.includes('--node')) {
        (async () => {
            const ztManager = new ZeroTierManager();
            await ztManager.configureNodeGatewayRouting('bat0');
            console.log('Node gateway configured');
        })();
    } else if (args.includes('--cleanup')) {
        (async () => {
            const ztManager = new ZeroTierManager();
            
            console.log('Cleaning up all routing configurations...');
            
            // Clean up both old and new routing methods
            await ztManager.cleanupProcessBasedRouting();
            await ztManager.cleanupGatewayRouting(true);  // coordinator cleanup
            await ztManager.cleanupGatewayRouting(false); // node cleanup
            
            console.log('All routing cleanup complete');
        })();
    } else {
        testGatewayRouting();
    }
}

module.exports = { testGatewayRouting };
