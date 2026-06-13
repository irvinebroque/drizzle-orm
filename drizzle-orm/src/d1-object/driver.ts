/// <reference types="@cloudflare/workers-types" />

import { entityKind } from '~/entity.ts';
import { DefaultLogger } from '~/logger.ts';
import {
	createTableRelationsHelpers,
	extractTablesRelationalConfig,
	type ExtractTablesWithRelations,
	type RelationalSchemaConfig,
	type TablesRelationalConfig,
} from '~/relations.ts';
import type { SQLWrapper } from '~/sql/sql.ts';
import { sql } from '~/sql/sql.ts';
import { BaseSQLiteDatabase } from '~/sqlite-core/db.ts';
import { SQLiteSyncDialect } from '~/sqlite-core/dialect.ts';
import { SQLiteD1ObjectSession } from './session.ts';
import { isD1ObjectReplica } from './setup.ts';
import type { D1ObjectDrizzleConfig, D1ObjectHelpers, D1ObjectState, D1ObjectStorage } from './types.ts';
import { assertD1ObjectReadQuery } from './utils.ts';

export class DrizzleD1ObjectDatabase<
	TSchema extends Record<string, unknown> = Record<string, never>,
> extends BaseSQLiteDatabase<'sync', SqlStorageCursor<Record<string, SqlStorageValue>>, TSchema> {
	static override readonly [entityKind]: string = 'DrizzleD1ObjectDatabase';

	/** @internal */
	declare readonly session: SQLiteD1ObjectSession<TSchema, ExtractTablesWithRelations<TSchema>>;

	declare readonly d1: D1ObjectHelpers;
}

/** Create a Drizzle client for SQL running inside a D1 application object. */
export function drizzle<
	TSchema extends Record<string, unknown> = Record<string, never>,
	TClient extends DurableObjectState = DurableObjectState,
>(
	client: TClient,
	config: D1ObjectDrizzleConfig<TSchema> = {},
): DrizzleD1ObjectDatabase<TSchema> & {
	$client: TClient;
} {
	const dialect = new SQLiteSyncDialect({ casing: config.casing });
	let logger;
	if (config.logger === true) {
		logger = new DefaultLogger();
	} else if (config.logger !== false) {
		logger = config.logger;
	}

	let schema: RelationalSchemaConfig<TablesRelationalConfig> | undefined;
	if (config.schema) {
		const tablesConfig = extractTablesRelationalConfig(
			config.schema,
			createTableRelationsHelpers,
		);
		schema = {
			fullSchema: config.schema,
			schema: tablesConfig.tables,
			tableNamesMap: tablesConfig.tableNamesMap,
		};
	}

	const session = new SQLiteD1ObjectSession(client, dialect, schema, {
		logger,
		replicaWrites: config.replicaWrites,
		onQuery: config.onQuery,
	});
	const db = new DrizzleD1ObjectDatabase('sync', dialect, session, schema) as DrizzleD1ObjectDatabase<TSchema>;
	(<any> db).$client = client;
	(<any> db).d1 = createD1Helpers(client, dialect);

	return db as any;
}

// Raw SQL is write-classified by default. These helpers are explicit read intent.
function createD1Helpers(ctx: DurableObjectState, dialect: SQLiteSyncDialect): D1ObjectHelpers {
	return {
		isReplica() {
			return isD1ObjectReplica(ctx);
		},
		async configureReadReplication() {
			const d1Ctx = ctx as D1ObjectState;
			if (!d1Ctx.primaryStub) {
				if (typeof d1Ctx.configureReadReplication !== 'function') {
					throw new Error('D1 read replication is not available in this runtime');
				}
				await d1Ctx.configureReadReplication({ mode: 'auto' });
			}
		},
		async waitForBookmark(bookmark) {
			if (bookmark) {
				const storage = ctx.storage as D1ObjectStorage;
				if (typeof storage.waitForBookmark !== 'function') {
					throw new Error('D1 bookmark waiting is not available in this runtime');
				}
				await storage.waitForBookmark(bookmark);
			}
		},
		getCurrentBookmark() {
			return ctx.storage.getCurrentBookmark();
		},
		getBookmarkForTime(timestamp) {
			return ctx.storage.getBookmarkForTime(timestamp);
		},
		onNextSessionRestoreBookmark(bookmark) {
			return ctx.storage.onNextSessionRestoreBookmark(bookmark);
		},
		readAll<T = unknown>(query: SQLWrapper | string): T[] {
			const builtQuery = toQuery(query, dialect);
			assertD1ObjectReadQuery(builtQuery);
			return ctx.storage.sql.exec<T & Record<string, SqlStorageValue>>(builtQuery.sql, ...builtQuery.params).toArray();
		},
		readGet<T = unknown>(query: SQLWrapper | string): T | undefined {
			const builtQuery = toQuery(query, dialect);
			assertD1ObjectReadQuery(builtQuery);
			return ctx.storage.sql.exec<T & Record<string, SqlStorageValue>>(builtQuery.sql, ...builtQuery.params).next()
				.value;
		},
		readValues<T extends unknown[] = unknown[]>(query: SQLWrapper | string): T[] {
			const builtQuery = toQuery(query, dialect);
			assertD1ObjectReadQuery(builtQuery);
			return Array.from(ctx.storage.sql.exec(builtQuery.sql, ...builtQuery.params).raw<SqlStorageValue[]>()) as T[];
		},
	};
}

function toQuery(query: SQLWrapper | string, dialect: SQLiteSyncDialect) {
	return dialect.sqlToQuery(typeof query === 'string' ? sql.raw(query) : query.getSQL());
}
