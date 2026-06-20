/// <reference types="@cloudflare/workers-types" />

import type { WithCacheConfig } from '~/cache/core/types.ts';
import { entityKind } from '~/entity.ts';
import type { Logger } from '~/logger.ts';
import { NoopLogger } from '~/logger.ts';
import type { RelationalSchemaConfig, TablesRelationalConfig } from '~/relations.ts';
import { fillPlaceholders, type Query, type SQL } from '~/sql/sql.ts';
import { type SQLiteSyncDialect, SQLiteTransaction } from '~/sqlite-core/index.ts';
import type { SelectedFieldsOrdered } from '~/sqlite-core/query-builders/select.types.ts';
import {
	type PreparedQueryConfig as PreparedQueryConfigBase,
	type SQLiteExecuteMethod,
	SQLiteSession,
	type SQLiteTransactionConfig,
} from '~/sqlite-core/session.ts';
import { SQLitePreparedQuery as PreparedQueryBase } from '~/sqlite-core/session.ts';
import { mapResultRow } from '~/utils.ts';
import { D1ObjectReplicaWriteError } from './errors.ts';
import { isD1ObjectReplica } from './setup.ts';
import type { D1ObjectQueryEvent } from './types.ts';

export interface SQLiteD1ObjectSessionOptions {
	logger?: Logger;
	replicaWrites?: 'throw';
	onQuery?: (event: D1ObjectQueryEvent) => void;
}

type PreparedQueryConfig = Omit<PreparedQueryConfigBase, 'statement' | 'run'>;

type QueryMetadata = {
	type: 'select' | 'update' | 'delete' | 'insert';
	tables: string[];
};

export class SQLiteD1ObjectSession<
	TFullSchema extends Record<string, unknown>,
	TSchema extends TablesRelationalConfig,
> extends SQLiteSession<
	'sync',
	SqlStorageCursor<Record<string, SqlStorageValue>>,
	TFullSchema,
	TSchema
> {
	static override readonly [entityKind]: string = 'SQLiteD1ObjectSession';

	private logger: Logger;
	private onQuery?: (event: D1ObjectQueryEvent) => void;

	constructor(
		private ctx: DurableObjectState,
		dialect: SQLiteSyncDialect,
		private schema: RelationalSchemaConfig<TSchema> | undefined,
		private options: SQLiteD1ObjectSessionOptions = {},
	) {
		super(dialect);
		this.logger = options.logger ?? new NoopLogger();
		this.onQuery = options.onQuery;
	}

	prepareQuery<T extends Omit<PreparedQueryConfig, 'run'>>(
		query: Query,
		fields: SelectedFieldsOrdered | undefined,
		executeMethod: SQLiteExecuteMethod,
		isResponseInArrayMode: boolean,
		customResultMapper?: (rows: unknown[][], mapColumnValue?: (value: unknown) => unknown) => unknown,
		queryMetadata?: QueryMetadata,
		_cacheConfig?: WithCacheConfig,
	): SQLiteD1ObjectPreparedQuery<T> {
		return new SQLiteD1ObjectPreparedQuery(
			this.ctx,
			query,
			this.logger,
			fields,
			executeMethod,
			isResponseInArrayMode,
			customResultMapper,
			queryMetadata,
			this.onQuery,
		);
	}

	override transaction<T>(
		transaction: (
			tx: SQLiteTransaction<'sync', SqlStorageCursor<Record<string, SqlStorageValue>>, TFullSchema, TSchema>,
		) => T,
		_config?: SQLiteTransactionConfig,
	): T {
		if (isD1ObjectReplica(this.ctx)) {
			throw new D1ObjectReplicaWriteError('D1 object transactions must run on the primary object');
		}
		const tx = new SQLiteD1ObjectTransaction('sync', this.dialect, this, this.schema);
		return this.ctx.storage.transactionSync(() => transaction(tx));
	}

	override async count(query: SQL): Promise<number> {
		const result = this.prepareOneTimeQuery(
			this.dialect.sqlToQuery(query),
			undefined,
			'run',
			false,
			undefined,
			{ type: 'select', tables: [] },
		).values() as [[number]];

		return result[0][0];
	}
}

export class SQLiteD1ObjectTransaction<
	TFullSchema extends Record<string, unknown>,
	TSchema extends TablesRelationalConfig,
> extends SQLiteTransaction<
	'sync',
	SqlStorageCursor<Record<string, SqlStorageValue>>,
	TFullSchema,
	TSchema
> {
	static override readonly [entityKind]: string = 'SQLiteD1ObjectTransaction';

	override transaction<T>(transaction: (tx: SQLiteD1ObjectTransaction<TFullSchema, TSchema>) => T): T {
		const tx = new SQLiteD1ObjectTransaction('sync', this.dialect, this.session, this.schema, this.nestedIndex + 1);
		return this.session.transaction(() => transaction(tx));
	}
}

export class SQLiteD1ObjectPreparedQuery<T extends PreparedQueryConfig = PreparedQueryConfig>
	extends PreparedQueryBase<{
		type: 'sync';
		run: SqlStorageCursor<Record<string, SqlStorageValue>>;
		all: T['all'];
		get: T['get'];
		values: T['values'];
		execute: T['execute'];
	}>
{
	static override readonly [entityKind]: string = 'SQLiteD1ObjectPreparedQuery';

	constructor(
		private ctx: DurableObjectState,
		query: Query,
		private logger: Logger,
		private fields: SelectedFieldsOrdered | undefined,
		executeMethod: SQLiteExecuteMethod,
		private _isResponseInArrayMode: boolean,
		private customResultMapper?: (rows: unknown[][], mapColumnValue?: (value: unknown) => unknown) => unknown,
		private d1QueryMetadata?: QueryMetadata,
		private onQuery?: (event: D1ObjectQueryEvent) => void,
	) {
		// 3-6 params are for cache. As long as we don't support sync cache - it will be skipped here.
		super('sync', executeMethod, query, undefined, undefined, undefined);
	}

	run(placeholderValues?: Record<string, unknown>): SqlStorageCursor<Record<string, SqlStorageValue>> {
		this.ensureCanExecute();
		const params = fillPlaceholders(this.query.params, placeholderValues ?? {});
		this.logger.logQuery(this.query.sql, params);
		const startedAt = Date.now();
		const cursor = this.ctx.storage.sql.exec(this.query.sql, ...params);
		this.emitQueryEvent('run', params, startedAt, cursor, undefined);
		return cursor;
	}

	all(placeholderValues?: Record<string, unknown>): T['all'] {
		this.ensureCanExecute();
		const { fields, joinsNotNullableMap, query, logger, customResultMapper } = this;
		const params = fillPlaceholders(query.params, placeholderValues ?? {});
		logger.logQuery(query.sql, params);
		const startedAt = Date.now();

		if (!fields && !customResultMapper) {
			const cursor = this.ctx.storage.sql.exec(query.sql, ...params);
			const rows = cursor.toArray();
			this.emitQueryEvent('all', params, startedAt, cursor, rows.length);
			return rows as T['all'];
		}

		const cursor = this.ctx.storage.sql.exec(query.sql, ...params);
		const rows = Array.from(cursor.raw<SqlStorageValue[]>()) as unknown[][];
		this.emitQueryEvent('all', params, startedAt, cursor, rows.length);

		if (customResultMapper) {
			return customResultMapper(rows) as T['all'];
		}

		return rows.map((row) => mapResultRow(fields!, row, joinsNotNullableMap)) as T['all'];
	}

	get(placeholderValues?: Record<string, unknown>): T['get'] {
		this.ensureCanExecute();
		const params = fillPlaceholders(this.query.params, placeholderValues ?? {});
		this.logger.logQuery(this.query.sql, params);
		const startedAt = Date.now();
		const { fields, joinsNotNullableMap, customResultMapper, query } = this;

		if (!fields && !customResultMapper) {
			const cursor = this.ctx.storage.sql.exec(query.sql, ...params);
			const row = cursor.next().value;
			this.emitQueryEvent('get', params, startedAt, cursor, row === undefined ? 0 : 1);
			return row as T['get'];
		}

		const cursor = this.ctx.storage.sql.exec(query.sql, ...params);
		const rows = Array.from(cursor.raw<SqlStorageValue[]>()) as unknown[][];
		this.emitQueryEvent('get', params, startedAt, cursor, rows.length);
		const row = rows[0];

		if (!row) {
			return undefined as T['get'];
		}

		if (customResultMapper) {
			return customResultMapper(rows) as T['get'];
		}

		return mapResultRow(fields!, row, joinsNotNullableMap) as T['get'];
	}

	values(placeholderValues?: Record<string, unknown>): T['values'] {
		this.ensureCanExecute();
		const params = fillPlaceholders(this.query.params, placeholderValues ?? {});
		this.logger.logQuery(this.query.sql, params);
		const startedAt = Date.now();
		const cursor = this.ctx.storage.sql.exec(this.query.sql, ...params);
		const rows = Array.from(cursor.raw<SqlStorageValue[]>()) as T['values'];
		this.emitQueryEvent('values', params, startedAt, cursor, (rows as unknown[]).length);
		return rows;
	}

	/** @internal */
	isResponseInArrayMode(): boolean {
		return this._isResponseInArrayMode;
	}

	private ensureCanExecute(): void {
		if (!this.isWrite()) {
			return;
		}
		if (isD1ObjectReplica(this.ctx)) {
			throw new D1ObjectReplicaWriteError(
				'D1 object write queries must run on the primary object. Route known writes to the primary or use an explicit primary-forwarding method.',
			);
		}
	}

	private isWrite(): boolean {
		if (this.d1QueryMetadata) {
			return this.d1QueryMetadata.type !== 'select';
		}

		// Relational queries provide a mapper but no query metadata.
		// Raw SQL has neither, so it stays write-classified by default.
		return this.customResultMapper === undefined;
	}

	private emitQueryEvent(
		method: 'run' | 'all' | 'get' | 'values',
		params: unknown[],
		startedAt: number,
		cursor: SqlStorageCursor<Record<string, SqlStorageValue>>,
		rowCount: number | undefined,
	): void {
		this.onQuery?.({
			sql: this.query.sql,
			params,
			method,
			queryType: this.d1QueryMetadata?.type,
			tables: this.d1QueryMetadata?.tables,
			durationMs: Date.now() - startedAt,
			rowsRead: cursor.rowsRead,
			rowsWritten: cursor.rowsWritten,
			rowCount,
			servedBy: isD1ObjectReplica(this.ctx) ? 'replica' : 'primary',
			forwarded: false,
		});
	}
}
