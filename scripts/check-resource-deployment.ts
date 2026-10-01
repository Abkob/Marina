import { verifyResourceDeployment } from './lib/resourceDeployment.js';

try {
  await verifyResourceDeployment(process.env);
  console.log('PASS Resource deployment prerequisites: storage, worker keys, and additive database schema are present. Sync and smoke-test the worker after deployment.');
} catch (error) {
  // Connection errors can contain credentials/hosts; only our own actionable
  // messages are safe to publish in build logs.
  const message = error instanceof Error && error.message.startsWith('Resource deployment is not ready:')
    ? error.message : 'Resource deployment is not ready: the read-only database check failed. Check the selected deployment environment and database connection.';
  console.error(message);
  process.exitCode = 1;
}
