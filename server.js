#!/usr/bin/env node
/**
 * Entry point for PM2 / Production
 * Starts the Express server from src/server.js
 */
import('./src/server.js').catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
