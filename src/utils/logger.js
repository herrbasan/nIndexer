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
    return loggerInstance;
}

export { createLogger, resetLogger };
