import { query } from '../db.js';
import { ARCHIVE_SCOPE_SQL, proposalTouchesArchive } from '../utils/archiveVisibility.js';

export async function activeProposals<T extends Record<string, unknown>>(proposals: T[]): Promise<T[]> {
  if (!proposals.length) return proposals;
  const { rows } = await query<{ entity_key: string }>(`${ARCHIVE_SCOPE_SQL} SELECT entity_key FROM archived_entities`);
  const archived = new Set(rows.map(row => row.entity_key));
  return proposals.filter(proposal => !proposalTouchesArchive(proposal, archived));
}
