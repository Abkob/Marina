// Read-only real PostgreSQL experiment. Requires an explicitly local test DB.
// No schema writes, extension installs, or access to application rows.
import pg from 'pg';
const url = new URL(process.env.DATABASE_URL_TEST || 'invalid:');
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !url.pathname.includes('test')) {
  throw new Error('Requires DATABASE_URL_TEST pointing to a local isolated test database');
}
const cases = [
  ['natural_question', 'What is the exception for isomorphism?', 'The isomorphism exception applies to the zero ring.'],
  ['targeted_terms', 'exception isomorphism', 'The isomorphism exception applies to the zero ring.'],
  ['word_inflection', 'Which procedures measure oscillations?', 'The procedure measures oscillation.'],
  ['exact_identifier', 'NEBULA-731', 'The calibration code is NEBULA-731.'],
  ['no_evidence', 'quasar emissions', 'The calibration code is NEBULA-731.'],
  ['english_stop_words', 'What are the limitations of the method?', 'Limitations of this method include sensitivity to noise.'],
  ['negation', 'not reversible', 'The operation is reversible.'],
  ['arabic_exact', 'معايرة', 'طريقة معايرة الجهاز'],
];
const client = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 5000 });
await client.connect();
try {
  await client.query('BEGIN READ ONLY');
  const results = [];
  for (const [id, question, passage] of cases) {
    const { rows } = await client.query(`SELECT
      to_tsvector('simple',$2) @@ plainto_tsquery('simple',$1) AS current_simple,
      to_tsvector('english',$2) @@ plainto_tsquery('english',$1) AS english_candidate`, [question, passage]);
    results.push({ id, ...rows[0] });
  }
  console.log(JSON.stringify({ experiment: 'Real PostgreSQL lexical matching, not semantic answer accuracy', results }, null, 2));
} finally { await client.query('ROLLBACK').catch(() => {}); await client.end(); }
