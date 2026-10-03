import 'dotenv/config';
import { createServer } from 'node:http';
import { assertPlanningTestDatabase, validatePlanningTestUrl } from './databaseFixtures.js';

// A real app and schema, but no background providers, seeding or unknown server.
process.env.NODE_ENV = 'test';
validatePlanningTestUrl(process.env.DATABASE_URL_TEST, process.env.PLANNING_TEST_DB);
const { getPool, initSchema } = await import('../../server/db.js');
const client = await getPool().connect();
try { await assertPlanningTestDatabase(client); } finally { client.release(); }
await initSchema();
const { createApp } = await import('../../server/app.js');
createServer(createApp()).listen(3001, '127.0.0.1');
