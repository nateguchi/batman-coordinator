#!/usr/bin/env node

const ZeroTierManager = require('./src/services/ZeroTierManager');

async function debugZeroTier() {
    const ztManager = new ZeroTierManager();
    
    try {
        console.log('🔍 Debugging ZeroTier Process-Based Routing...\n');
        
        // Initialize ZeroTier
        await ztManager.initialize();
        
        // Monitor process-based routing status
        await ztManager.monitorProcessBasedRouting();
        
        console.log('\n' + '='.repeat(50) + '\n');
        
        // Show traffic flow analysis
        await ztManager.showTrafficFlow();
        
    } catch (error) {
        console.error('❌ Debug failed:', error.message);
        process.exit(1);
    }
}

debugZeroTier();
