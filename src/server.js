import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { indexRoutes } from './api/indexing.routes.js';
import { searchRoutes } from './api/search.routes.js';
import { analysisRoutes } from './api/analysis.routes.js';
import { fileRoutes } from './api/file.routes.js';

const app = express();

// Middleware
app.use(helmet());
app.use(express.json({ limit: '10mb' }));

if (config.service.cors) {
  app.use(cors());
}

// Rate limiting for search endpoints
const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes
const apiPrefix = '/api/v1';
app.use(`${apiPrefix}/index`, indexRoutes);
app.use(`${apiPrefix}/search`, searchLimiter, searchRoutes);
app.use(`${apiPrefix}`, analysisRoutes);
app.use(`${apiPrefix}`, fileRoutes);

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    success: false,
    error: err.message || 'Internal server error'
  });
});

const { host, port } = config.service;
app.listen(port, host, () => {
  console.log(`nIndexer service running at http://${host}:${port}`);
  console.log(`API available at http://${host}:${port}${apiPrefix}`);
});
