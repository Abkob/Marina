import Dexie, { type EntityTable } from 'dexie';
import type {
  DBGoal, DBTask, DBTaskNote, DBTaskNoteFile, DBNote, DBResource,
  DBEvent, DBDailyScore, DBEdge, DBTag, DBEntityTag,
} from './schema';

const LEGACY_GOAL_CATEGORY_MAP: Record<string, string> = {
  'Product Development': 'Work',
  'Strategy Planning': 'Work',
  'Languages': 'Learning',
  'DevOps & Storage': 'Home',
  'Health & Fitness': 'Health',
  'Finance': 'Money',
  'Other': 'Personal',
};

export class MarinaDB extends Dexie {
  goals!:            EntityTable<DBGoal,         'id'>;
  tasks!:            EntityTable<DBTask,         'id'>;
  task_notes!:       EntityTable<DBTaskNote,     'id'>;
  task_note_files!:  EntityTable<DBTaskNoteFile, 'id'>;
  notes!:            EntityTable<DBNote,         'id'>;
  resources!:   EntityTable<DBResource,   'id'>;
  events!:      EntityTable<DBEvent,      'id'>;
  daily_scores!:EntityTable<DBDailyScore, 'id'>;
  edges!:       EntityTable<DBEdge,       'id'>;
  tags!:        EntityTable<DBTag,        'id'>;
  entity_tags!: EntityTable<DBEntityTag,  'id'>;

  constructor(name = 'marina-os-v3') {
    super(name);

    this.version(1).stores({
      // Primary key first, then all indexed columns
      goals:
        'id, status, category, deadline, overdue, created_at',
      tasks:
        'id, goal_id, parent_task_id, status, kind, priority, due_date, completed, created_at',
      task_notes:
        'id, task_id, created_at',
      notes:
        'id, type, suggested_action_applied, created_at',
      resources:
        'id, type, created_at',
      events:
        'id, type, day_index, week_start, created_at',
      daily_scores:
        'id, &date',                // & = unique constraint on date
      edges:
        'id, source_id, target_id, source_type, target_type, relationship, [source_id+target_id]',
      tags:
        'id, &name',
      entity_tags:
        'id, entity_id, tag_id, [entity_id+entity_type]',
    });

    this.version(2).stores({
      goals:
        'id, status, category, deadline, overdue, archived_at, created_at',
      tasks:
        'id, goal_id, parent_task_id, status, kind, priority, due_date, completed, created_at',
      task_notes:
        'id, task_id, created_at',
      notes:
        'id, type, suggested_action_applied, created_at',
      resources:
        'id, type, created_at',
      events:
        'id, type, day_index, week_start, created_at',
      daily_scores:
        'id, &date',
      edges:
        'id, source_id, target_id, source_type, target_type, relationship, [source_id+target_id]',
      tags:
        'id, &name',
      entity_tags:
        'id, entity_id, tag_id, [entity_id+entity_type]',
    }).upgrade(async (tx) => {
      await tx.table('goals').toCollection().modify((goal) => {
        if (!('archived_at' in goal)) goal.archived_at = null;
      });
    });

    this.version(3).stores({
      goals:
        'id, status, category, deadline, overdue, archived_at, created_at',
      tasks:
        'id, goal_id, parent_task_id, status, kind, priority, due_date, completed, created_at',
      task_notes:
        'id, task_id, created_at',
      notes:
        'id, type, suggested_action_applied, created_at',
      resources:
        'id, type, created_at',
      events:
        'id, type, day_index, week_start, created_at',
      daily_scores:
        'id, &date',
      edges:
        'id, source_id, target_id, source_type, target_type, relationship, [source_id+target_id]',
      tags:
        'id, &name',
      entity_tags:
        'id, entity_id, tag_id, [entity_id+entity_type]',
    }).upgrade(async (tx) => {
      await tx.table('goals').toCollection().modify((goal) => {
        goal.category = LEGACY_GOAL_CATEGORY_MAP[goal.category] ?? goal.category;
      });
    });

    // v4: adds task_note_files table (binary attachments per journal entry)
    this.version(4).stores({
      goals:           'id, status, category, deadline, overdue, archived_at, created_at',
      tasks:           'id, goal_id, parent_task_id, status, kind, priority, due_date, completed, created_at',
      task_notes:      'id, task_id, created_at',
      task_note_files: 'id, note_id, created_at',
      notes:           'id, type, suggested_action_applied, created_at',
      resources:       'id, type, created_at',
      events:          'id, type, day_index, week_start, created_at',
      daily_scores:    'id, &date',
      edges:           'id, source_id, target_id, source_type, target_type, relationship, [source_id+target_id]',
      tags:            'id, &name',
      entity_tags:     'id, entity_id, tag_id, [entity_id+entity_type]',
    });
    this.version(5).stores({ brand_migrations: 'id' });
  }
}

export const db = new MarinaDB();
db.on('ready', async () => {
  const legacyName = 'amina-os-v3';
  if (await db.table('brand_migrations').get('device-brand')) return;
  if (!await Dexie.exists(legacyName)) return;
  const legacy = new Dexie(legacyName);
  try {
    await legacy.open();
    const copies = await Promise.all(legacy.tables.filter(table => table.name !== 'brand_migrations').map(async table => ({ name: table.name, rows: await table.toArray() })));
    await db.transaction('rw', db.tables, async () => {
      for (const { name, rows } of copies) {
        const table = db.table(name);
        const existing = new Set(await table.toCollection().primaryKeys());
        const missing = rows.filter(row => !existing.has(row.id));
        if (missing.length) await table.bulkAdd(missing);
      }
      await db.table('brand_migrations').put({ id: 'device-brand' });
    });
  } finally { legacy.close(); }
});
