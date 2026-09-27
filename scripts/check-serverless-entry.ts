process.env.VERCEL = '1';
process.env.NODE_ENV = 'production';

const entry = await import('../api/index.js');
if (typeof entry.default !== 'function') {
  throw new Error('api/index.ts must default-export an Express request handler');
}

console.log(JSON.stringify({ ok: true, listener_started: false, database_touched: false }));
