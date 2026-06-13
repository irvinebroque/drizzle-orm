/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from 'cloudflare:workers';
import { drizzle } from './driver.ts';
import { migrate } from './migrator.ts';
import { isD1ObjectReplica, setupD1Object } from './setup.ts';
import type {
	D1ObjectMigrationConfig,
	D1ObjectMigrationResult,
	D1ObjectQueryRequest,
	D1ObjectQueryResponse,
	D1ObjectRuntimeConfig,
	D1ObjectState,
} from './types.ts';

/** Base Durable Object for Drizzle-backed D1 application objects. */
export abstract class DrizzleD1Object<Env = unknown> extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env, config: D1ObjectRuntimeConfig = {}) {
		super(ctx, env);
		setupD1Object(ctx, config);
	}

	protected isReplica(): boolean {
		return isD1ObjectReplica(this.ctx);
	}

	protected assertPrimary(operation = 'operation'): void {
		if (this.isReplica()) {
			throw new Error(`D1 object ${operation} must run on the primary object`);
		}
	}

	protected async configureD1ReadReplication(config: { mode: 'auto' } = { mode: 'auto' }): Promise<void> {
		const d1Ctx = this.ctx as D1ObjectState;
		if (!d1Ctx.primaryStub) {
			if (typeof d1Ctx.configureReadReplication !== 'function') {
				throw new Error('D1 read replication is not available in this runtime');
			}
			await d1Ctx.configureReadReplication(config);
		}
	}

	async runDrizzleQuery(request: D1ObjectQueryRequest): Promise<D1ObjectQueryResponse> {
		const d1Ctx = this.ctx as D1ObjectState;
		if (d1Ctx.primaryStub && request.write) {
			const response = await d1Ctx.primaryStub.runDrizzleQuery?.(request);
			if (!response) {
				throw new Error('Primary D1 object does not implement runDrizzleQuery');
			}
			return { ...response, forwarded: true };
		}

		const cursor = this.ctx.storage.sql.exec(request.sql, ...request.params);
		if (request.method === 'run') {
			return this.withWriteBookmark(this.createQueryResponse([], cursor, false), request.write);
		}

		if (request.method === 'get') {
			if (request.responseMode === 'array') {
				const row = cursor.raw<SqlStorageValue[]>().next();
				return this.withWriteBookmark(this.createQueryResponse(row.done ? [] : [row.value], cursor, false), request.write);
			}
			const row = cursor.next();
			return this.withWriteBookmark(this.createQueryResponse(row.done ? [] : [row.value], cursor, false), request.write);
		}

		const rows = request.responseMode === 'array'
			? Array.from(cursor.raw<SqlStorageValue[]>())
			: cursor.toArray();
		return this.withWriteBookmark(this.createQueryResponse(rows, cursor, false), request.write);
	}

	async applyDrizzleMigrations(config: D1ObjectMigrationConfig): Promise<D1ObjectMigrationResult> {
		const d1Ctx = this.ctx as D1ObjectState;
		if (d1Ctx.primaryStub) {
			// Migrations are writes. Replicas forward them to the primary.
			const response = await d1Ctx.primaryStub.applyDrizzleMigrations?.(config);
			if (!response) {
				throw new Error('Primary D1 object does not implement applyDrizzleMigrations');
			}
			return response;
		}

		const db = drizzle(this.ctx, { logger: false });
		return migrate(db, config);
	}

	private createQueryResponse(
		rows: unknown[],
		cursor: SqlStorageCursor<Record<string, SqlStorageValue>>,
		forwarded: boolean,
	): D1ObjectQueryResponse {
		return {
			rows,
			rowsRead: cursor.rowsRead,
			rowsWritten: cursor.rowsWritten,
			servedBy: this.isReplica() ? 'replica' : 'primary',
			forwarded,
		};
	}

	private async withWriteBookmark(response: D1ObjectQueryResponse, write: boolean): Promise<D1ObjectQueryResponse> {
		if (!write) {
			return response;
		}

		return {
			...response,
			bookmark: await this.ctx.storage.getCurrentBookmark(),
		};
	}
}
