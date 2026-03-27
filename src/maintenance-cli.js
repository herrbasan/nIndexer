/**
 * Maintenance CLI
 *
 * Run maintenance on all codebases in data/codebases.json
 * Usage: npm run start:maintenance
 */

import { config } from './config.js';
import { LLMClient } from './llm-client.js';
import { init as initIndexingService, shutdown as shutdownIndexingService } from './services/indexing.service.js';

async function main() {
  console.log('[Maintenance] Starting...');

  // Initialize LLM client (may not be needed for refresh-only)
  const llmClient = new LLMClient();

  // Initialize the indexing service
  const serviceConfig = {
    ...config.indexing,
    spaces: config.spaces,
    maintenance: config.maintenance
  };
  const indexingService = await initIndexingService({
    config: { codebase: serviceConfig },
    gateway: llmClient
  });

  // Run initial maintenance with if_missing + analyze
  console.log('[Maintenance] Running initial maintenance...');

  const result = await indexingService.runMaintenance({
    reindex: 'if_missing',
    analyze: true
  });

  console.log('[Maintenance] Initial result:', JSON.stringify(result, null, 2));

  // Keep process running - maintenance will be handled by periodic interval in the service
  console.log('[Maintenance] Continuous mode active. Press Ctrl+C to stop.');

  // Handle shutdown
  process.on('SIGINT', async () => {
    console.log('[Maintenance] Shutting down...');
    await shutdownIndexingService();
    llmClient?.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[Maintenance] Error:', err);
  process.exit(1);
});