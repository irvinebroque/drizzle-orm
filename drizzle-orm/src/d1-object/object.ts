/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from 'cloudflare:workers';
import { drizzle } from './driver.ts';
import { D1ObjectReplicaWriteError } from './errors.ts';
import { migrate } from './migrator.ts';
import { isD1ObjectReplica, setupD1Object } from './setup.ts';
import type {
	D1ObjectMethodRequest,
	D1ObjectMethodResponse,
	D1ObjectMigrationConfig,
	D1ObjectMigrationResult,
	D1ObjectQueryRequest,
	D1ObjectQueryResponse,
	D1ObjectRuntimeConfig,
	D1ObjectState,
	D1ObjectStorage,
} from './types.ts';

const reservedD1ObjectMethodNames = [
	'constructor',
	'isReplica',
	'assertPrimary',
	'configureD1ReadReplication',
	'runDrizzleObjectMethod',
	'runDrizzleQuery',
	'applyDrizzleMigrations',
] as const;

const reservedD1ObjectMethods = new Set<string>(reservedD1ObjectMethodNames);

const objectPrototypeMethods = new Set(Object.getOwnPropertyNames(Object.prototype));

type AnyD1ObjectMethod = (...args: any[]) => any;
type ReservedD1ObjectMethod = typeof reservedD1ObjectMethodNames[number];

export type D1ObjectPrimaryMethod<TObject extends object> = Extract<
	{
		[K in keyof TObject]: K extends ReservedD1ObjectMethod ? never
			: TObject[K] extends AnyD1ObjectMethod ? K
			: never;
	}[keyof TObject],
	string
>;

export function d1PrimaryMethods<TObject extends object>() {
	return <TMethods extends readonly D1ObjectPrimaryMethod<TObject>[]>(...methods: TMethods): TMethods => methods;
}

/** Base Durable Object for Drizzle-backed D1 application objects. */
export abstract class DrizzleD1Object<Env = unknown> extends DurableObject<Env> {
	static readonly primaryMethods: readonly string[] = [];

	constructor(ctx: DurableObjectState, env: Env, config: D1ObjectRuntimeConfig = {}) {
		super(ctx, env);
		setupD1Object(ctx, config);
	}

	protected isReplica(): boolean {
		return isD1ObjectReplica(this.ctx);
	}

	protected assertPrimary(operation = 'operation'): void {
		if (this.isReplica()) {
			throw new D1ObjectReplicaWriteError(`D1 object ${operation} must run on the primary object`);
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

	async runDrizzleObjectMethod(request: D1ObjectMethodRequest): Promise<D1ObjectMethodResponse> {
		const method = this.getDrizzleObjectMethod(request.method);
		if (this.shouldForwardD1ObjectMethodToPrimary(request.method)) {
			const response = await (this.ctx as D1ObjectState).primaryStub?.runDrizzleObjectMethod?.(request);
			if (!response) {
				throw new Error('Primary D1 object does not implement runDrizzleObjectMethod');
			}
			return response;
		}

		await this.waitForD1ObjectBookmark(request.bookmark);

		const value = await method.apply(this, request.args);
		return {
			value,
			bookmark: await this.ctx.storage.getCurrentBookmark(),
		};
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
				return this.withWriteBookmark(
					this.createQueryResponse(row.done ? [] : [row.value], cursor, false),
					request.write,
				);
			}
			const row = cursor.next();
			return this.withWriteBookmark(
				this.createQueryResponse(row.done ? [] : [row.value], cursor, false),
				request.write,
			);
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

	private getDrizzleObjectMethod(methodName: string): (...args: unknown[]) => unknown {
		if (
			reservedD1ObjectMethods.has(methodName) || objectPrototypeMethods.has(methodName) || methodName.startsWith('_')
		) {
			throw new Error(`D1 object method '${methodName}' cannot be called through a Drizzle object session`);
		}

		const method = (this as Record<string, unknown>)[methodName];
		if (typeof method !== 'function') {
			throw new Error(`D1 object method '${methodName}' does not exist`);
		}

		return method as (...args: unknown[]) => unknown;
	}

	private shouldForwardD1ObjectMethodToPrimary(methodName: string): boolean {
		if (!this.isReplica()) {
			return false;
		}

		const constructor = this.constructor as typeof DrizzleD1Object;
		return constructor.primaryMethods.includes(methodName);
	}

	private async waitForD1ObjectBookmark(bookmark: string | null | undefined): Promise<void> {
		if (!bookmark) {
			return;
		}

		const storage = this.ctx.storage as D1ObjectStorage;
		if (typeof storage.waitForBookmark !== 'function') {
			throw new Error('D1 bookmark waiting is not available in this runtime');
		}
		await storage.waitForBookmark(bookmark);
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
