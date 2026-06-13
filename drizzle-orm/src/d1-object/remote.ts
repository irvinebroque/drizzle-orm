/// <reference types="@cloudflare/workers-types" />

import { type Cache, NoopCache } from '~/cache/core/index.ts';
import type { WithCacheConfig } from '~/cache/core/types.ts';
import { entityKind } from '~/entity.ts';
import { DefaultLogger, NoopLogger } from '~/logger.ts';
import type { Logger } from '~/logger.ts';
import {
	createTableRelationsHelpers,
	extractTablesRelationalConfig,
	type ExtractTablesWithRelations,
	type RelationalSchemaConfig,
	type TablesRelationalConfig,
} from '~/relations.ts';
import { fillPlaceholders, type Query } from '~/sql/sql.ts';
import { BaseSQLiteDatabase } from '~/sqlite-core/db.ts';
import { SQLiteAsyncDialect } from '~/sqlite-core/dialect.ts';
import { SQLiteTransaction } from '~/sqlite-core/index.ts';
import type { SelectedFieldsOrdered } from '~/sqlite-core/query-builders/select.types.ts';
import type {
	PreparedQueryConfig as PreparedQueryConfigBase,
	SQLiteExecuteMethod,
	SQLiteTransactionConfig,
} from '~/sqlite-core/session.ts';
import { SQLitePreparedQuery, SQLiteSession } from '~/sqlite-core/session.ts';
import { mapResultRow } from '~/utils.ts';
import type {
	D1ObjectQueryEvent,
	D1ObjectQueryMethod,
	D1ObjectQueryRequest,
	D1ObjectQueryResponse,
	D1ObjectRemoteDrizzleConfig,
} from './types.ts';

type PreparedQueryConfig = Omit<PreparedQueryConfigBase, 'statement' | 'run'>;

type QueryMetadata = {
	type: 'select' | 'update' | 'delete' | 'insert';
	tables: string[];
};

export interface D1ObjectRemoteStub {
	runDrizzleQuery?(request: D1ObjectQueryRequest): Promise<D1ObjectQueryResponse>;
}

export interface D1ObjectRemoteSessionController {
	getBookmark(): string | undefined;
	setBookmark(bookmark: string | null | undefined): void;
	getSequence?(): number | undefined;
	enqueue<T>(operation: () => Promise<T>): Promise<T>;
}

export class DrizzleD1ObjectRemoteDatabase<
	TSchema extends Record<string, unknown> = Record<string, never>,
> extends BaseSQLiteDatabase<'async', D1ObjectQueryResponse, TSchema> {
	static override readonly [entityKind]: string = 'DrizzleD1ObjectRemoteDatabase';

	/** @internal */
	declare readonly session: SQLiteD1ObjectRemoteSession<TSchema, ExtractTablesWithRelations<TSchema>>;
}

export function createD1ObjectRemoteDatabase<
	TSchema extends Record<string, unknown> = Record<string, never>,
	TClient extends D1ObjectRemoteStub = D1ObjectRemoteStub,
>(
	client: TClient,
	controller: D1ObjectRemoteSessionController,
	config: D1ObjectRemoteDrizzleConfig<TSchema> = {},
): DrizzleD1ObjectRemoteDatabase<TSchema> & {
	$client: TClient;
} {
	const dialect = new SQLiteAsyncDialect({ casing: config.casing });
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

	const session = new SQLiteD1ObjectRemoteSession(client, controller, dialect, schema, {
		logger,
		cache: config.cache,
		onQuery: config.onQuery,
	});
	const db = new DrizzleD1ObjectRemoteDatabase(
		'async',
		dialect,
		session,
		schema,
	) as DrizzleD1ObjectRemoteDatabase<TSchema>;
	(<any> db).$client = client;
	(<any> db).$cache = config.cache;
	if ((<any> db).$cache) {
		(<any> db).$cache['invalidate'] = config.cache?.onMutate;
	}

	return db as any;
}

export interface SQLiteD1ObjectRemoteSessionOptions {
	logger?: Logger;
	cache?: Cache;
	onQuery?: (event: D1ObjectQueryEvent) => void;
}

export class SQLiteD1ObjectRemoteSession<
	TFullSchema extends Record<string, unknown>,
	TSchema extends TablesRelationalConfig,
> extends SQLiteSession<'async', D1ObjectQueryResponse, TFullSchema, TSchema> {
	static override readonly [entityKind]: string = 'SQLiteD1ObjectRemoteSession';

	private logger: Logger;
	private cache: Cache;
	private onQuery?: (event: D1ObjectQueryEvent) => void;

	constructor(
		private client: D1ObjectRemoteStub,
		private controller: D1ObjectRemoteSessionController,
		dialect: SQLiteAsyncDialect,
		_schema: RelationalSchemaConfig<TSchema> | undefined,
		options: SQLiteD1ObjectRemoteSessionOptions = {},
	) {
		super(dialect);
		this.logger = options.logger ?? new NoopLogger();
		this.cache = options.cache ?? new NoopCache();
		this.onQuery = options.onQuery;
	}

	prepareQuery<T extends Omit<PreparedQueryConfig, 'run'>>(
		query: Query,
		fields: SelectedFieldsOrdered | undefined,
		executeMethod: SQLiteExecuteMethod,
		isResponseInArrayMode: boolean,
		customResultMapper?: (rows: unknown[][], mapColumnValue?: (value: unknown) => unknown) => unknown,
		queryMetadata?: QueryMetadata,
		cacheConfig?: WithCacheConfig,
	): SQLiteD1ObjectRemotePreparedQuery<T> {
		return new SQLiteD1ObjectRemotePreparedQuery(
			this.client,
			this.controller,
			query,
			this.logger,
			this.cache,
			queryMetadata,
			cacheConfig,
			fields,
			executeMethod,
			isResponseInArrayMode,
			customResultMapper,
			this.onQuery,
		);
	}

	override async transaction<T>(
		_transaction: (tx: SQLiteD1ObjectRemoteTransaction<TFullSchema, TSchema>) => Promise<T>,
		_config?: SQLiteTransactionConfig,
	): Promise<T> {
		throw new Error(
			'D1 object remote Drizzle sessions do not support transactions. Define a Durable Object method and run db.transaction() inside the object.',
		);
	}

	override extractRawAllValueFromBatchResult(result: unknown): unknown {
		return (result as D1ObjectQueryResponse).rows;
	}

	override extractRawGetValueFromBatchResult(result: unknown): unknown {
		return (result as D1ObjectQueryResponse).rows[0];
	}

	override extractRawValuesValueFromBatchResult(result: unknown): unknown {
		return (result as D1ObjectQueryResponse).rows;
	}
}

export class SQLiteD1ObjectRemoteTransaction<
	TFullSchema extends Record<string, unknown>,
	TSchema extends TablesRelationalConfig,
> extends SQLiteTransaction<'async', D1ObjectQueryResponse, TFullSchema, TSchema> {
	static override readonly [entityKind]: string = 'SQLiteD1ObjectRemoteTransaction';

	override transaction<T>(
		_transaction: (tx: SQLiteD1ObjectRemoteTransaction<TFullSchema, TSchema>) => Promise<T>,
	): Promise<T> {
		throw new Error(
			'D1 object remote Drizzle sessions do not support transactions. Define a Durable Object method and run db.transaction() inside the object.',
		);
	}
}

export class SQLiteD1ObjectRemotePreparedQuery<T extends PreparedQueryConfig = PreparedQueryConfig>
	extends SQLitePreparedQuery<{
		type: 'async';
		run: D1ObjectQueryResponse;
		all: T['all'];
		get: T['get'];
		values: T['values'];
		execute: T['execute'];
	}>
{
	static override readonly [entityKind]: string = 'SQLiteD1ObjectRemotePreparedQuery';

	constructor(
		private client: D1ObjectRemoteStub,
		private controller: D1ObjectRemoteSessionController,
		query: Query,
		private logger: Logger,
		cache: Cache,
		private d1QueryMetadata: QueryMetadata | undefined,
		cacheConfig: WithCacheConfig | undefined,
		private fields: SelectedFieldsOrdered | undefined,
		executeMethod: SQLiteExecuteMethod,
		private _isResponseInArrayMode: boolean,
		private customResultMapper?: (rows: unknown[][], mapColumnValue?: (value: unknown) => unknown) => unknown,
		private onQuery?: (event: D1ObjectQueryEvent) => void,
	) {
		super('async', executeMethod, query, cache, d1QueryMetadata, cacheConfig);
	}

	async run(placeholderValues?: Record<string, unknown>): Promise<D1ObjectQueryResponse> {
		const response = await this.request('run', 'object', placeholderValues);
		return response;
	}

	async all(placeholderValues?: Record<string, unknown>): Promise<T['all']> {
		if (!this.fields && !this.customResultMapper) {
			const response = await this.request('all', 'object', placeholderValues);
			return response.rows as T['all'];
		}

		const rows = await this.values(placeholderValues);
		return this.mapAllResult(rows) as T['all'];
	}

	override mapAllResult(rows: unknown, isFromBatch?: boolean): unknown {
		if (isFromBatch) {
			rows = (rows as D1ObjectQueryResponse).rows;
		}

		if (!this.fields && !this.customResultMapper) {
			return rows;
		}

		if (this.customResultMapper) {
			return this.customResultMapper(rows as unknown[][]);
		}

		return (rows as unknown[][]).map((row) => mapResultRow(this.fields!, row, this.joinsNotNullableMap));
	}

	async get(placeholderValues?: Record<string, unknown>): Promise<T['get']> {
		if (!this.fields && !this.customResultMapper) {
			const response = await this.request('get', 'object', placeholderValues);
			return response.rows[0] as T['get'];
		}

		const response = await this.request('get', 'array', placeholderValues);
		return this.mapGetResult(response.rows[0]) as T['get'];
	}

	override mapGetResult(result: unknown, isFromBatch?: boolean): unknown {
		if (isFromBatch) {
			result = (result as D1ObjectQueryResponse).rows[0];
		}

		if (!result) {
			return undefined;
		}

		if (!this.fields && !this.customResultMapper) {
			return result;
		}

		if (this.customResultMapper) {
			return this.customResultMapper([result as unknown[]]);
		}

		return mapResultRow(this.fields!, result as unknown[], this.joinsNotNullableMap);
	}

	async values<TValues extends any[] = unknown[]>(placeholderValues?: Record<string, unknown>): Promise<TValues[]> {
		const response = await this.request('values', 'array', placeholderValues);
		return response.rows as TValues[];
	}

	/** @internal */
	isResponseInArrayMode(): boolean {
		return this._isResponseInArrayMode;
	}

	private async request(
		method: D1ObjectQueryMethod,
		responseMode: 'object' | 'array',
		placeholderValues?: Record<string, unknown>,
	): Promise<D1ObjectQueryResponse> {
		const params = fillPlaceholders(this.query.params, placeholderValues ?? {});
		this.logger.logQuery(this.query.sql, params);
		const startedAt = Date.now();

		const response = await this.controller.enqueue(async () => {
			const response = await this.queryWithCache(this.query.sql, params, async () => {
				if (!this.client.runDrizzleQuery) {
					throw new Error('D1 object stub does not implement runDrizzleQuery');
				}

				return await this.client.runDrizzleQuery({
					sql: this.query.sql,
					params,
					method,
					responseMode,
					write: this.isWrite(),
					bookmark: this.controller.getBookmark(),
					sequence: this.controller.getSequence?.(),
					queryType: this.d1QueryMetadata?.type,
					tables: this.d1QueryMetadata?.tables,
				});
			});

			if (response.bookmark !== undefined) {
				this.controller.setBookmark(response.bookmark);
			}

			return response;
		});
		this.onQuery?.({
			sql: this.query.sql,
			params,
			method,
			queryType: this.d1QueryMetadata?.type,
			tables: this.d1QueryMetadata?.tables,
			durationMs: Date.now() - startedAt,
			rowsRead: response.rowsRead,
			rowsWritten: response.rowsWritten,
			rowCount: response.rows.length,
			servedBy: response.servedBy,
			forwarded: response.forwarded ?? false,
		});

		return response;
	}

	private isWrite(): boolean {
		if (this.d1QueryMetadata) {
			return this.d1QueryMetadata.type !== 'select';
		}

		return this.customResultMapper === undefined;
	}
}
