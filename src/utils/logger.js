const winston = require('winston');
const path = require('path');

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, '..', '..', 'logs');
require('fs').mkdirSync(logsDir, { recursive: true });

// Define log levels
const logLevels = {
    error: 0,
    warn: 1,
    info: 2,
    http: 3,
    verbose: 4,
    debug: 5,
    silly: 6
};

// Define log colors
const logColors = {
    error: 'red',
    warn: 'yellow',
    info: 'green',
    http: 'magenta',
    verbose: 'grey',
    debug: 'white',
    silly: 'grey'
};

winston.addColors(logColors);

// Custom format for console output
const consoleFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.colorize({ all: true }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
        let log = `${timestamp} [${level}]: ${message}`;
        
        // Add metadata if present
        if (Object.keys(meta).length > 0) {
            log += ` ${JSON.stringify(meta, null, 2)}`;
        }
        
        return log;
    })
);

// Custom format for file output
const fileFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
);

// Determine log level from environment
const logLevel = process.env.LOG_LEVEL || 'info';
const enableDebugLogs = process.env.ENABLE_DEBUG_LOGS === 'true';

// Create the logger
const logger = winston.createLogger({
    level: enableDebugLogs ? 'debug' : logLevel,
    levels: logLevels,
    defaultMeta: {
        service: process.env.NODE_ENV === 'node' ? 'mesh-node' : 'coordinator',
        pid: process.pid
    },
    transports: [
        // Console transport
        new winston.transports.Console({
            format: consoleFormat,
            level: enableDebugLogs ? 'debug' : logLevel
        }),
        
        // File transport for all logs
        new winston.transports.File({
            filename: path.join(logsDir, 'combined.log'),
            format: fileFormat,
            maxsize: 10485760, // 10MB
            maxFiles: 5,
            tailable: true
        }),
        
        // File transport for error logs only
        new winston.transports.File({
            filename: path.join(logsDir, 'error.log'),
            level: 'error',
            format: fileFormat,
            maxsize: 5242880, // 5MB
            maxFiles: 5,
            tailable: true
        }),
        
        // File transport for coordinator-specific logs
        new winston.transports.File({
            filename: path.join(logsDir, 'coordinator.log'),
            format: fileFormat,
            maxsize: 10485760, // 10MB
            maxFiles: 5,
            tailable: true,
            // Only log if this is the coordinator
            silent: process.env.NODE_ENV === 'node'
        }),
        
        // File transport for node-specific logs
        new winston.transports.File({
            filename: path.join(logsDir, 'node.log'),
            format: fileFormat,
            maxsize: 10485760, // 10MB
            maxFiles: 5,
            tailable: true,
            // Only log if this is a node
            silent: process.env.NODE_ENV !== 'node'
        })
    ],
    
    // Handle uncaught exceptions
    exceptionHandlers: [
        new winston.transports.File({
            filename: path.join(logsDir, 'exceptions.log'),
            format: fileFormat
        })
    ],
    
    // Handle uncaught promise rejections
    rejectionHandlers: [
        new winston.transports.File({
            filename: path.join(logsDir, 'rejections.log'),
            format: fileFormat
        })
    ]
});

// Add custom methods for specific log types
logger.network = (message, meta = {}) => {
    logger.info(message, { ...meta, category: 'network' });
};

logger.security = (message, meta = {}) => {
    logger.warn(message, { ...meta, category: 'security' });
};

logger.batman = (message, meta = {}) => {
    logger.info(message, { ...meta, category: 'batman' });
};

logger.zerotier = (message, meta = {}) => {
    logger.info(message, { ...meta, category: 'zerotier' });
};

logger.stats = (message, meta = {}) => {
    logger.debug(message, { ...meta, category: 'stats' });
};

logger.heartbeat = (message, meta = {}) => {
    logger.debug(message, { ...meta, category: 'heartbeat' });
};

// Method to change log level at runtime
logger.setLevel = (level) => {
    logger.transports.forEach(transport => {
        transport.level = level;
    });
    logger.info(`Log level changed to: ${level}`);
};

// Method to get current log level
logger.getLevel = () => {
    return logger.level;
};

// Method to log performance metrics
logger.performance = (operation, duration, meta = {}) => {
    logger.info(`Performance: ${operation} completed in ${duration}ms`, {
        ...meta,
        category: 'performance',
        operation: operation,
        duration: duration
    });
};

// Method to log system events
logger.system = (event, meta = {}) => {
    logger.info(`System event: ${event}`, {
        ...meta,
        category: 'system',
        event: event
    });
};

// Method to log node events
logger.node = (nodeId, event, meta = {}) => {
    logger.info(`Node ${nodeId}: ${event}`, {
        ...meta,
        category: 'node',
        nodeId: nodeId,
        event: event
    });
};

// Method to flush logs (useful for testing)
logger.flush = () => {
    return new Promise((resolve) => {
        const transports = logger.transports.filter(t => t.filename);
        let pending = transports.length;
        
        if (pending === 0) {
            resolve();
            return;
        }
        
        transports.forEach(transport => {
            if (transport.close) {
                transport.close(() => {
                    pending--;
                    if (pending === 0) resolve();
                });
            } else {
                pending--;
                if (pending === 0) resolve();
            }
        });
    });
};

// Export the logger
module.exports = logger;
