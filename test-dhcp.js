#!/usr/bin/env node

const DHCPManager = require('../src/services/DHCPManager');
const logger = require('../src/utils/logger');

async function testDHCP() {
    const dhcp = new DHCPManager();
    
    try {
        logger.info('=== Testing DHCP Manager ===');
        
        // Test configuration generation
        logger.info('Testing DHCP configuration generation...');
        const config = await dhcp.generateDHCPConfig();
        logger.info('Generated DHCP config preview:');
        console.log(config.substring(0, 500) + '...');
        
        // Test status check
        logger.info('Checking DHCP server status...');
        const status = await dhcp.getStatus();
        logger.info('DHCP Status:', status);
        
        if (process.argv.includes('--install')) {
            logger.info('Installing and configuring DHCP server...');
            await dhcp.initialize();
            
            logger.info('Final DHCP status:');
            const finalStatus = await dhcp.getStatus();
            logger.info(finalStatus);
            
            if (finalStatus.active) {
                logger.info('✅ DHCP server is running!');
                logger.info('📋 Active leases:', finalStatus.leases || []);
            } else {
                logger.error('❌ DHCP server failed to start');
            }
        } else {
            logger.info('To actually install and start DHCP, run with --install flag');
        }
        
    } catch (error) {
        logger.error('DHCP test failed:', error);
        process.exit(1);
    }
}

if (require.main === module) {
    testDHCP();
}

module.exports = testDHCP;
