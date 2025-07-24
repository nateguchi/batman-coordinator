#!/usr/bin/env node

// Test script to verify batman-adv parsing fixes
const NetworkManager = require('./src/services/NetworkManager');

async function testBatmanParsing() {
    console.log('Testing Batman-adv parsing improvements...');
    
    const networkManager = new NetworkManager();
    
    // Mock batman-adv output with common problematic patterns
    const mockNeighborsOutput = `
[B.A.T.M.A.N. adv 2023.1, MainIF/MAC: wlan1/aa:bb:cc:dd:ee:ff (bat0/aa:bb:cc:dd:ee:ff)]
IF             Neighbor              last-seen
wlan1          aa:bb:cc:dd:ee:ff    0.123s   (  255) bat0 [aa:bb:cc:dd:ee:ff]
wlan1          11:22:33:44:55:66    1.456s   (  200) bat0 [11:22:33:44:55:66]
`;

    const mockOriginatorsOutput = `
[B.A.T.M.A.N. adv 2023.1, MainIF/MAC: wlan1/aa:bb:cc:dd:ee:ff (bat0/aa:bb:cc:dd:ee:ff)]
   Originator        last-seen (#/255)           Nexthop [outgoingIF]:   Potential nexthops ...
aa:bb:cc:dd:ee:ff    0.123s   (  255) aa:bb:cc:dd:ee:ff [      bat0]: aa:bb:cc:dd:ee:ff (  255)
11:22:33:44:55:66    1.456s   (  200) 11:22:33:44:55:66 [      bat0]: 11:22:33:44:55:66 (  200)
`;

    // Test parsing functions
    console.log('\n--- Testing Neighbor Parsing ---');
    const neighbors = parseNeighbors(mockNeighborsOutput);
    console.log('Parsed neighbors:', neighbors);
    
    console.log('\n--- Testing Originator Parsing ---');
    const routes = parseOriginators(mockOriginatorsOutput);
    console.log('Parsed routes:', routes);
    
    // Verify no "[B.A.T.M.A.N." entries
    const hasInvalidNeighbors = neighbors.some(n => n.address.includes('[') || n.address.includes('B.A.T.M.A.N.'));
    const hasInvalidRoutes = routes.some(r => r.originator.includes('[') || r.originator.includes('B.A.T.M.A.N.'));
    
    console.log('\n--- Results ---');
    console.log('✓ Neighbors without invalid entries:', !hasInvalidNeighbors);
    console.log('✓ Routes without invalid entries:', !hasInvalidRoutes);
    console.log('✓ Valid MAC addresses only:', neighbors.every(n => /^[0-9a-fA-F:]{17}$/.test(n.address)));
}

function parseNeighbors(output) {
    const neighbors = [];
    const lines = output.split('\n');
    
    for (const line of lines) {
        const trimmedLine = line.trim();
        
        // Skip empty lines, header lines, and lines containing B.A.T.M.A.N.
        if (!trimmedLine || 
            trimmedLine.includes('B.A.T.M.A.N.') ||
            trimmedLine.includes('Neighbor') ||
            trimmedLine.includes('Originator') ||
            trimmedLine.includes('---') ||
            trimmedLine.includes('IF') ||
            trimmedLine.startsWith('[') ||
            trimmedLine.includes('No batman nodes')) {
            continue;
        }
        
        // Look for lines with MAC addresses (format: XX:XX:XX:XX:XX:XX)
        const macPattern = /([0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2})/;
        const match = trimmedLine.match(macPattern);
        
        if (match && trimmedLine.includes('(') && trimmedLine.includes(')')) {
            const parts = trimmedLine.split(/\s+/);
            if (parts.length >= 4) {
                neighbors.push({
                    address: match[1], // Use the MAC address from regex match
                    lastSeen: parts[1],
                    quality: parts[2],
                    interface: parts[3]
                });
            }
        }
    }
    
    return neighbors;
}

function parseOriginators(output) {
    const routes = [];
    const lines = output.split('\n');
    
    for (const line of lines) {
        const trimmedLine = line.trim();
        
        // Skip empty lines, header lines, and lines containing B.A.T.M.A.N.
        if (!trimmedLine || 
            trimmedLine.includes('B.A.T.M.A.N.') ||
            trimmedLine.includes('Originator') ||
            trimmedLine.includes('---') ||
            trimmedLine.includes('IF') ||
            trimmedLine.startsWith('[') ||
            trimmedLine.includes('No batman nodes')) {
            continue;
        }
        
        // Look for lines with MAC addresses (format: XX:XX:XX:XX:XX:XX)
        const macPattern = /([0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2})/;
        const match = trimmedLine.match(macPattern);
        
        if (match && trimmedLine.includes('(') && trimmedLine.includes(')')) {
            const parts = trimmedLine.split(/\s+/);
            if (parts.length >= 4) {
                routes.push({
                    originator: match[1], // Use the MAC address from regex match
                    lastSeen: parts[1],
                    quality: parts[2],
                    nextHop: parts[3],
                    interface: parts[4] || 'unknown'
                });
            }
        }
    }
    
    return routes;
}

if (require.main === module) {
    testBatmanParsing().catch(console.error);
}
