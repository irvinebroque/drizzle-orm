/// <reference types="@cloudflare/workers-types" />

import type { SQLWrapper } from '~/sql/sql.ts';
import type { DrizzleConfig } from '~/utils.ts';

export interface D1ObjectRuntimeConfig {
	/** Enable D1 read replicas for this object. Enabled by default. */
	readReplication?:
		| false
		| {
			mode: 'auto' | 'disabled';
			enabled?: boolean | ((ctx: DurableObjectState) => boolean | Promise<boolean>);
		};
}

export interface D1ObjectQueryEvent {
	sql: string;
	params: unknown[];
	method: 'run' | 'all' | 'get' | 'values';
	queryType?: 'select' | 'insert' | 'update' | 'delete';
	tables?: string[];
	durationMs: number;
	rowsRead?: number;
	rowsWritten?: number;
	rowCount?: number;
	servedBy: 'primary' | 'replica';
	forwarded: boolean;
}

export interface D1ObjectDrizzleConfig<TSchema extends Record<string, unknown>> extends DrizzleConfig<TSchema> {
	/** Replica writes throw in the sync adapter. Use object methods for primary forwarding. */
	replicaWrites?: 'throw';
	/** Receives query timing and cursor row counters after each local query. */
	onQuery?: (event: D1ObjectQueryEvent) => void;
}

export interface D1ObjectHelpers {
	/** True when this object instance is a read replica. */
	isReplica(): boolean;
	/** Configure read replicas on the primary object. */
	configureReadReplication(): Promise<void>;
	/** Wait until this object has observed a bookmark. */
	waitForBookmark(bookmark: string | null | undefined): Promise<void>;
	/** Return a bookmark for this object's current storage state. */
	getCurrentBookmark(): Promise<string>;
	getBookmarkForTime(timestamp: number | Date): Promise<string>;
	onNextSessionRestoreBookmark(bookmark: string): Promise<string>;
	/** Execute caller-declared read-only raw SQL on primary or replica. */
	readAll<T = unknown>(query: SQLWrapper | string): T[];
	/** Execute caller-declared read-only raw SQL and return one row. */
	readGet<T = unknown>(query: SQLWrapper | string): T | undefined;
	/** Execute caller-declared read-only raw SQL and return arrays. */
	readValues<T extends unknown[] = unknown[]>(query: SQLWrapper | string): T[];
}

export type D1ObjectQueryMethod = 'run' | 'all' | 'get' | 'values';

export interface D1ObjectQueryRequest {
	sql: string;
	params: unknown[];
	method: D1ObjectQueryMethod;
	responseMode: 'object' | 'array';
	write: boolean;
	tables?: string[];
	queryType?: 'select' | 'insert' | 'update' | 'delete';
}

export interface D1ObjectQueryResponse {
	rows: unknown[];
	bookmark?: string;
	rowsRead?: number;
	rowsWritten?: number;
	servedBy: 'primary' | 'replica';
	forwarded?: boolean;
}

export interface D1ObjectMethodRequest {
	method: string;
	args: unknown[];
	bookmark?: string | null;
}

export interface D1ObjectMethodResponse<T = unknown> {
	value: T;
	bookmark: string;
}

export interface D1ObjectMigrationConfig {
	journal: {
		entries: { idx: number; when: number; tag: string; breakpoints: boolean }[];
	};
	migrations: Record<string, string>;
	migrationsTable?: string;
}

export interface D1ObjectMigrationResult {
	applied: string[];
}

export interface D1ObjectPrimaryStub {
	runDrizzleQuery?(request: D1ObjectQueryRequest): Promise<D1ObjectQueryResponse>;
	applyDrizzleMigrations?(migrations: D1ObjectMigrationConfig): Promise<D1ObjectMigrationResult>;
}

export type D1ObjectState = DurableObjectState & {
	primaryStub?: D1ObjectPrimaryStub;
	configureReadReplication(config: { mode: 'auto' | 'disabled' }): Promise<void>;
};

export type D1ObjectStorage = DurableObjectStorage & {
	waitForBookmark(bookmark: string): Promise<void>;
};
