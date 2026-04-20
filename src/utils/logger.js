// Wrapper for the nLogger submodule

import { createLogger, resetLogger } from '../../nLogger/src/logger.js';
import { config } from '../config.js';

// Initialize logger with configurable settings from config.js
const loggerOptions = {
    logsDir: config.logs?.dir,
    sessionPrefix: 'nidx'
};

// Create singleton logger instance for nIndexer
const loggerInstance = createLogger(loggerOptions);

// Export the instance as default getLogger
export function getLogger() {
    return new Proxy(loggerInstance, {
        get(target, prop) {
            if (['info', 'warn', 'error', 'debug'].includes(prop)) {
                return (msg, meta, type, opts = {}) => {
                    const method = prop === 'error' ? console.error : console.log;
                    method(`[${String(type || 'System').padEnd(10)}] [${prop.toUpperCase().padEnd(5)}] ${msg}`, meta ? Object.keys(meta).length ? meta : '' : '');
                    return target[prop](msg, meta, type, opts);
                };
            }
            return target[prop];
        }
    });
}

export { createLogger, resetLogger };
