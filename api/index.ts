import { createApp } from '../server/app.js';

// Vercel invokes this Express instance per request. Startup migrations,
// seeding, listeners, and interval workers intentionally stay in
// server/index.ts for local/long-running deployments only.
export default createApp();
