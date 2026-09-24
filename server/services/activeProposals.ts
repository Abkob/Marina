import { query } from '../db.js';
import { ARCHIVE_SCOPE_SQL, proposalTouchesArchive, activeGoalSql } from '../utils/archiveVisibility.js';

export async function activeProposals<T extends Record<string, unknown>>(proposals: T[]): Promise<T[]> {
  if (!proposals.length) return proposals;
  const { rows } = await query<{ entity_key: string }>(`${ARCHIVE_SCOPE_SQL} SELECT entity_key FROM archived_entities`);
  const archived = new Set(rows.map(row => row.entity_key));
  if (proposals.some(proposal => ['update_routine', 'check_in_routine'].includes(String(proposal.action_type)))) {
    const { rows: routines } = await query<{ id: string }>(`SELECT id FROM routines WHERE archived_at IS NOT NULL OR NOT ${activeGoalSql()}`);
    routines.forEach(row => archived.add(`routine:${row.id}`));
  }
  return proposals.filter(proposal => !proposalTouchesArchive(proposal, archived));
}
