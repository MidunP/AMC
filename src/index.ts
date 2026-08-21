/**
 * Broadway FDFS Ticket Watcher & Booking Assistant
 *
 * Entry point — re-exports from worker.ts for process management.
 * Run the worker directly with: npm run worker
 * Use the CLI with: npm run watch:add / watch:list / etc.
 * Use the MCP server with: npm run mcp
 */
export * from './worker';
