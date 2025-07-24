// Batman Mesh Coordinator Web Interface
class BatmanCoordinator {
    constructor() {
        this.socket = null;
        this.isConnected = false;
        this.currentTab = 'overview';
        this.nodes = new Map();
        this.stats = {};
        this.charts = {};
        this.topology = null;
        
        this.init();
    }

    async init() {
        this.setupEventListeners();
        this.connectWebSocket();
        this.initializeCharts();
        this.showTab('overview');
    }

    // WebSocket Connection
    connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.host;
        
        try {
            this.socket = io();
            
            this.socket.on('connect', () => {
                console.log('Connected to coordinator');
                this.isConnected = true;
                this.updateConnectionStatus(true);
                this.requestInitialData();
            });

            this.socket.on('disconnect', () => {
                console.log('Disconnected from coordinator');
                this.isConnected = false;
                this.updateConnectionStatus(false);
            });

            this.socket.on('status-update', (data) => {
                this.updateSystemStatus(data);
            });

            this.socket.on('nodes-update', (data) => {
                this.updateNodes(data);
            });

            this.socket.on('stats-update', (data) => {
                this.updateStats(data);
            });

            this.socket.on('topology-update', (data) => {
                this.updateTopology(data);
            });

            this.socket.on('gateway-status', (data) => {
                this.updateGatewayStatus(data);
            });

            this.socket.on('alert', (data) => {
                this.showAlert(data);
            });

            this.socket.on('security-alert', (data) => {
                this.showSecurityAlert(data);
            });

            this.socket.on('error', (error) => {
                console.error('Socket error:', error);
                this.showNotification('Connection error: ' + error.message, 'error');
            });

        } catch (error) {
            console.error('Failed to connect:', error);
            this.updateConnectionStatus(false);
        }
    }

    requestInitialData() {
        if (!this.isConnected) return;
        
        this.socket.emit('request-status');
        this.socket.emit('request-nodes');
        this.socket.emit('request-stats');
        this.socket.emit('request-topology');
        this.socket.emit('request-gateway-status');
    }

    // Event Listeners
    setupEventListeners() {
        // Tab navigation
        document.querySelectorAll('.nav-tab').forEach(tab => {
            tab.addEventListener('click', (e) => {
                const tabName = e.target.getAttribute('data-tab');
                this.showTab(tabName);
            });
        });

        // Refresh buttons
        document.getElementById('refreshTopology')?.addEventListener('click', () => {
            this.socket?.emit('request-topology');
        });

        document.getElementById('refreshNodes')?.addEventListener('click', () => {
            this.socket?.emit('request-nodes');
        });

        // Auto refresh
        setInterval(() => {
            if (this.isConnected) {
                this.socket.emit('request-status');
                this.socket.emit('request-stats');
                this.socket.emit('request-gateway-status');
            }
        }, 5000); // Every 5 seconds
    }

    // Tab Management
    showTab(tabName) {
        // Hide all tabs
        document.querySelectorAll('.tab-content').forEach(tab => {
            tab.classList.remove('active');
        });

        // Show selected tab
        const targetTab = document.getElementById(tabName);
        if (targetTab) {
            targetTab.classList.add('active');
        }

        // Update nav
        document.querySelectorAll('.nav-tab').forEach(tab => {
            tab.classList.remove('active');
        });
        
        const navTab = document.querySelector(`[data-tab="${tabName}"]`);
        if (navTab) {
            navTab.classList.add('active');
        }

        this.currentTab = tabName;

        // Load tab-specific data
        if (tabName === 'topology' && this.isConnected) {
            this.socket.emit('request-topology');
        } else if (tabName === 'stats' && this.isConnected) {
            this.socket.emit('request-performance', { minutes: 60 });
        }
    }

    // Status Updates
    updateConnectionStatus(connected) {
        const statusIndicator = document.getElementById('coordinatorStatus');
        const statusDot = statusIndicator.querySelector('.status-dot');
        const statusText = statusIndicator.querySelector('.status-text');

        if (connected) {
            statusDot.className = 'status-dot online';
            statusText.textContent = 'Connected';
        } else {
            statusDot.className = 'status-dot offline';
            statusText.textContent = 'Disconnected';
        }
    }

    updateSystemStatus(data) {
        if (!data) return;

        // Update last update time
        document.getElementById('lastUpdate').textContent = 
            `Last update: ${new Date().toLocaleTimeString()}`;

        // Update system metrics
        if (data.summary) {
            const summary = data.summary;
            
            document.getElementById('systemUptime').textContent = 
                this.formatUptime(summary.uptime || 0);
            
            document.getElementById('cpuUsage').textContent = 
                `${Math.round(summary.cpu?.usage || 0)}%`;
            
            document.getElementById('memoryUsage').textContent = 
                `${Math.round(summary.memory?.usage || 0)}%`;
            
            document.getElementById('cpuTemp').textContent = 
                `${Math.round(summary.cpu?.temperature || 0)}°C`;
        }

        // Update network status
        if (data.summary?.batman) {
            this.updateNetworkStatus('batmanStatus', data.summary.batman.active);
        }

        if (data.summary?.zerotier) {
            this.updateNetworkStatus('zeroTierStatus', data.summary.zerotier.online);
        }

        // Update gateway status
        if (data.batman) {
            this.updateGatewayStatus(data.batman);
        }
    }

    updateGatewayStatus(batmanData) {
        if (!batmanData) return;

        // Update gateway mode
        const gatewayModeElement = document.getElementById('gatewayModeStatus');
        if (gatewayModeElement && batmanData.gatewayMode) {
            const mode = batmanData.gatewayMode.toLowerCase();
            gatewayModeElement.textContent = batmanData.gatewayMode;
            
            // Update badge styling based on mode
            gatewayModeElement.className = 'status-badge';
            if (mode.includes('server')) {
                gatewayModeElement.classList.add('server');
            } else if (mode.includes('client')) {
                gatewayModeElement.classList.add('client');
            } else if (mode.includes('off')) {
                gatewayModeElement.classList.add('off');
            } else {
                gatewayModeElement.classList.add('unknown');
            }
        }

        // Update neighbor count
        const neighborCountElement = document.getElementById('neighborCount');
        if (neighborCountElement) {
            neighborCountElement.textContent = batmanData.neighborCount || 0;
        }

        // Update route count
        const routeCountElement = document.getElementById('routeCount');
        if (routeCountElement) {
            routeCountElement.textContent = batmanData.routeCount || 0;
        }

        // Update interface name
        const interfaceNameElement = document.getElementById('interfaceName');
        if (interfaceNameElement) {
            interfaceNameElement.textContent = batmanData.interface || 'bat0';
        }
    }

    updateNetworkStatus(elementId, isOnline) {
        const element = document.getElementById(elementId);
        if (!element) return;

        const statusDot = element.querySelector('.status-dot');
        const statusText = element.querySelector('span:last-child');

        if (isOnline) {
            statusDot.className = 'status-dot online';
            statusText.textContent = 'Online';
        } else {
            statusDot.className = 'status-dot offline';
            statusText.textContent = 'Offline';
        }
    }

    // Nodes Management
    updateNodes(nodes) {
        if (!Array.isArray(nodes)) return;

        this.nodes.clear();
        nodes.forEach(node => {
            this.nodes.set(node.id, node);
        });

        this.updateNodesDisplay();
        this.updateNodesTable();
    }

    updateNodesDisplay() {
        const total = this.nodes.size;
        const online = Array.from(this.nodes.values()).filter(n => n.status === 'online').length;
        const warning = Array.from(this.nodes.values()).filter(n => n.status === 'warning').length;
        const offline = total - online - warning;

        document.getElementById('totalNodes').textContent = total;
        document.getElementById('onlineNodes').textContent = online;
        document.getElementById('warningNodes').textContent = warning;
        document.getElementById('offlineNodes').textContent = offline;
    }

    updateNodesTable() {
        const tbody = document.getElementById('nodesTableBody');
        if (!tbody) return;

        if (this.nodes.size === 0) {
            tbody.innerHTML = '<tr><td colspan="7" class="no-data">No nodes detected</td></tr>';
            return;
        }

        const rows = Array.from(this.nodes.values()).map(node => {
            const lastSeen = node.lastSeen ? 
                new Date(node.lastSeen).toLocaleString() : 'Never';
            
            const cpu = node.stats?.cpu?.usage ? 
                `${Math.round(node.stats.cpu.usage)}%` : '--';
            
            const memory = node.stats?.memory?.usage ? 
                `${Math.round(node.stats.memory.usage)}%` : '--';

            return `
                <tr>
                    <td>${node.id}</td>
                    <td>${node.address}</td>
                    <td>
                        <div class="node-status">
                            <span class="status-dot ${node.status}"></span>
                            <span>${node.status}</span>
                        </div>
                    </td>
                    <td>${lastSeen}</td>
                    <td>${cpu}</td>
                    <td>${memory}</td>
                    <td>
                        <div class="node-actions">
                            <button class="btn btn-sm" onclick="coordinator.pingNode('${node.id}')">
                                Ping
                            </button>
                            <button class="btn btn-sm btn-danger" onclick="coordinator.disconnectNode('${node.id}')">
                                Disconnect
                            </button>
                        </div>
                    </td>
                </tr>
            `;
        });

        tbody.innerHTML = rows.join('');
    }

    // Stats Management
    updateStats(stats) {
        if (!stats) return;

        this.stats = stats;
        this.updateTrafficStats();
        this.updateCharts();
    }

    updateTrafficStats() {
        if (!this.stats.zerotier?.traffic) return;

        const traffic = this.stats.zerotier.traffic;
        
        document.getElementById('rxTraffic').textContent = 
            this.formatBytes(traffic.rxBytes || 0);
        
        document.getElementById('txTraffic').textContent = 
            this.formatBytes(traffic.txBytes || 0);
        
        document.getElementById('totalPackets').textContent = 
            this.formatNumber((traffic.rxPackets || 0) + (traffic.txPackets || 0));
        
        document.getElementById('errorCount').textContent = 
            this.formatNumber((traffic.rxErrors || 0) + (traffic.txErrors || 0));
    }

    // Charts
    initializeCharts() {
        const perfCtx = document.getElementById('performanceChart');
        const trafficCtx = document.getElementById('trafficChart');

        if (perfCtx) {
            this.charts.performance = new Chart(perfCtx, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [{
                        label: 'CPU Usage (%)',
                        data: [],
                        borderColor: '#3498db',
                        backgroundColor: 'rgba(52, 152, 219, 0.1)',
                        tension: 0.1
                    }, {
                        label: 'Memory Usage (%)',
                        data: [],
                        borderColor: '#e74c3c',
                        backgroundColor: 'rgba(231, 76, 60, 0.1)',
                        tension: 0.1
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        y: {
                            beginAtZero: true,
                            max: 100
                        }
                    }
                }
            });
        }

        if (trafficCtx) {
            this.charts.traffic = new Chart(trafficCtx, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [{
                        label: 'RX (MB/s)',
                        data: [],
                        borderColor: '#27ae60',
                        backgroundColor: 'rgba(39, 174, 96, 0.1)',
                        tension: 0.1
                    }, {
                        label: 'TX (MB/s)',
                        data: [],
                        borderColor: '#f39c12',
                        backgroundColor: 'rgba(243, 156, 18, 0.1)',
                        tension: 0.1
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        y: {
                            beginAtZero: true
                        }
                    }
                }
            });
        }
    }

    updateCharts() {
        if (!this.stats) return;

        // Update performance chart
        if (this.charts.performance && this.stats.system) {
            const now = new Date().toLocaleTimeString();
            const cpu = this.stats.system.cpu?.usage || 0;
            const memory = this.stats.system.memory?.usage || 0;

            const chart = this.charts.performance;
            chart.data.labels.push(now);
            chart.data.datasets[0].data.push(cpu);
            chart.data.datasets[1].data.push(memory);

            // Keep only last 20 points
            if (chart.data.labels.length > 20) {
                chart.data.labels.shift();
                chart.data.datasets[0].data.shift();
                chart.data.datasets[1].data.shift();
            }

            chart.update('none');
        }

        // Update traffic chart
        if (this.charts.traffic && this.stats.zerotier?.traffic) {
            const now = new Date().toLocaleTimeString();
            const traffic = this.stats.zerotier.traffic;
            
            // Calculate rates (simplified)
            const rxRate = (traffic.rxBytes || 0) / (1024 * 1024); // MB
            const txRate = (traffic.txBytes || 0) / (1024 * 1024); // MB

            const chart = this.charts.traffic;
            chart.data.labels.push(now);
            chart.data.datasets[0].data.push(rxRate);
            chart.data.datasets[1].data.push(txRate);

            if (chart.data.labels.length > 20) {
                chart.data.labels.shift();
                chart.data.datasets[0].data.shift();
                chart.data.datasets[1].data.shift();
            }

            chart.update('none');
        }
    }

    // Topology Visualization
    updateTopology(data) {
        if (!data) return;

        this.topology = data;
        this.renderTopology();
    }

    renderTopology() {
        const svg = d3.select('#topologyGraph');
        svg.selectAll('*').remove();

        if (!this.topology || !this.topology.nodes.length) {
            svg.append('text')
                .attr('x', '50%')
                .attr('y', '50%')
                .attr('text-anchor', 'middle')
                .attr('dominant-baseline', 'middle')
                .style('fill', '#999')
                .text('No topology data available');
            return;
        }

        const width = parseInt(svg.style('width'));
        const height = parseInt(svg.style('height'));

        // Create force simulation
        const simulation = d3.forceSimulation(this.topology.nodes)
            .force('link', d3.forceLink(this.topology.links)
                .id(d => d.id)
                .distance(100))
            .force('charge', d3.forceManyBody().strength(-300))
            .force('center', d3.forceCenter(width / 2, height / 2));

        // Add links
        const link = svg.append('g')
            .selectAll('line')
            .data(this.topology.links)
            .enter().append('line')
            .attr('stroke', d => {
                const quality = parseFloat(d.quality) || 0;
                return quality > 0.8 ? '#27ae60' : '#f39c12';
            })
            .attr('stroke-width', 2);

        // Add nodes
        const node = svg.append('g')
            .selectAll('circle')
            .data(this.topology.nodes)
            .enter().append('circle')
            .attr('r', d => d.type === 'coordinator' ? 12 : 8)
            .attr('fill', d => d.type === 'coordinator' ? '#3498db' : '#27ae60')
            .attr('stroke', '#fff')
            .attr('stroke-width', 2)
            .call(d3.drag()
                .on('start', dragstarted)
                .on('drag', dragged)
                .on('end', dragended));

        // Add labels
        const label = svg.append('g')
            .selectAll('text')
            .data(this.topology.nodes)
            .enter().append('text')
            .text(d => d.id)
            .style('font-size', '12px')
            .style('text-anchor', 'middle')
            .attr('dy', -15);

        // Update positions
        simulation.on('tick', () => {
            link
                .attr('x1', d => d.source.x)
                .attr('y1', d => d.source.y)
                .attr('x2', d => d.target.x)
                .attr('y2', d => d.target.y);

            node
                .attr('cx', d => d.x)
                .attr('cy', d => d.y);

            label
                .attr('x', d => d.x)
                .attr('y', d => d.y);
        });

        // Drag functions
        function dragstarted(event, d) {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
        }

        function dragged(event, d) {
            d.fx = event.x;
            d.fy = event.y;
        }

        function dragended(event, d) {
            if (!event.active) simulation.alphaTarget(0);
            d.fx = null;
            d.fy = null;
        }
    }

    // Node Actions
    pingNode(nodeId) {
        if (!this.isConnected) return;
        
        this.socket.emit('node-action', {
            nodeId: nodeId,
            action: 'ping'
        });

        this.showNotification(`Pinging node ${nodeId}...`, 'info');
    }

    disconnectNode(nodeId) {
        if (!this.isConnected) return;
        
        if (confirm(`Are you sure you want to disconnect node ${nodeId}?`)) {
            this.socket.emit('node-action', {
                nodeId: nodeId,
                action: 'disconnect'
            });

            this.showNotification(`Disconnecting node ${nodeId}...`, 'warning');
        }
    }

    // Utility Functions
    formatUptime(seconds) {
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        
        if (days > 0) {
            return `${days}d ${hours}h ${minutes}m`;
        } else if (hours > 0) {
            return `${hours}h ${minutes}m`;
        } else {
            return `${minutes}m`;
        }
    }

    formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    formatNumber(num) {
        if (num >= 1000000) {
            return (num / 1000000).toFixed(1) + 'M';
        } else if (num >= 1000) {
            return (num / 1000).toFixed(1) + 'K';
        } else {
            return num.toString();
        }
    }

    showNotification(message, type = 'info') {
        // Create notification element
        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        notification.innerHTML = `
            <span>${message}</span>
            <button onclick="this.parentElement.remove()">×</button>
        `;

        // Add to page
        document.body.appendChild(notification);

        // Auto remove after 5 seconds
        setTimeout(() => {
            if (notification.parentElement) {
                notification.remove();
            }
        }, 5000);
    }

    showAlert(alert) {
        this.addEvent(alert.type, alert.message);
    }

    showSecurityAlert(alert) {
        this.addEvent('security', alert.message);
        this.addSecurityLog(alert);
    }

    addEvent(type, message) {
        const eventsList = document.getElementById('recentEvents');
        if (!eventsList) return;

        const eventItem = document.createElement('div');
        eventItem.className = 'event-item fade-in';
        eventItem.innerHTML = `
            <span class="event-time">${new Date().toLocaleTimeString()}</span>
            <span class="event-type ${type}">${type.toUpperCase()}</span>
            <span class="event-message">${message}</span>
        `;

        eventsList.insertBefore(eventItem, eventsList.firstChild);

        // Keep only last 20 events
        while (eventsList.children.length > 20) {
            eventsList.removeChild(eventsList.lastChild);
        }
    }

    addSecurityLog(log) {
        const logContainer = document.getElementById('securityLogs');
        if (!logContainer) return;

        const logEntry = document.createElement('div');
        logEntry.className = 'log-entry fade-in';
        logEntry.innerHTML = `
            <span class="log-time">${new Date().toLocaleTimeString()}</span>
            <span class="log-level ${log.severity || 'warning'}">${(log.severity || 'warning').toUpperCase()}</span>
            <span class="log-message">${log.message}</span>
        `;

        logContainer.insertBefore(logEntry, logContainer.firstChild);

        // Keep only last 50 logs
        while (logContainer.children.length > 50) {
            logContainer.removeChild(logContainer.lastChild);
        }
    }
}

// Initialize the application
const coordinator = new BatmanCoordinator();
