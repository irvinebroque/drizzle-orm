import type { MigrationMeta } from '~/migrator.ts';
import { sql } from '~/sql/index.ts';
import type { DrizzleD1ObjectDatabase } from './driver.ts';
import type { D1ObjectMigrationConfig, D1ObjectMigrationResult } from './types.ts';

function readMigrationFiles({ journal, migrations }: D1ObjectMigrationConfig): MigrationMeta[] {
	const migrationQueries: MigrationMeta[] = [];

	for (const journalEntry of journal.entries) {
		const query = migrations[`m${journalEntry.idx.toString().padStart(4, '0')}`];

		if (!query) {
			throw new Error(`Missing migration: ${journalEntry.tag}`);
		}

		try {
			const result = query.split('--> statement-breakpoint').map((it) => {
				return it;
			});

			migrationQueries.push({
				sql: result,
				bps: journalEntry.breakpoints,
				folderMillis: journalEntry.when,
				hash: '',
			});
		} catch {
			throw new Error(`Failed to parse migration: ${journalEntry.tag}`);
		}
	}

	return migrationQueries;
}

/** Apply bundled SQLite migrations on the primary object. */
export function migrate<TSchema extends Record<string, unknown>>(
	db: DrizzleD1ObjectDatabase<TSchema>,
	config: D1ObjectMigrationConfig,
): D1ObjectMigrationResult {
	const migrations = readMigrationFiles(config);
	const migrationsTable = config.migrationsTable ?? '__drizzle_migrations';
	const applied: string[] = [];

	db.transaction((tx) => {
		try {
			const migrationTableCreate = sql`
				CREATE TABLE IF NOT EXISTS ${sql.identifier(migrationsTable)} (
					id SERIAL PRIMARY KEY,
					hash text NOT NULL,
					created_at numeric
				)
			`;
			db.run(migrationTableCreate);

			const dbMigrations = db.values<[number, string, string]>(
				sql`SELECT id, hash, created_at FROM ${sql.identifier(migrationsTable)} ORDER BY created_at DESC LIMIT 1`,
			);

			const lastDbMigration = dbMigrations[0] ?? undefined;

			for (const migration of migrations) {
				if (!lastDbMigration || Number(lastDbMigration[2])! < migration.folderMillis) {
					for (const stmt of migration.sql) {
						db.run(sql.raw(stmt));
					}
					db.run(
						sql`INSERT INTO ${
							sql.identifier(migrationsTable)
						} ("hash", "created_at") VALUES(${migration.hash}, ${migration.folderMillis})`,
					);
					applied.push(String(migration.folderMillis));
				}
			}
		} catch (error: any) {
			try {
				tx.rollback();
			} catch {
				// Preserve the original migration error; rollback() throws by design.
			}
			throw error;
		}
	});

	return { applied };
}
