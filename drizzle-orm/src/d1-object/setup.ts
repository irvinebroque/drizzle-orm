/// <reference types="@cloudflare/workers-types" />

import type { D1ObjectRuntimeConfig, D1ObjectState } from './types.ts';

const configuredStates = new WeakSet<DurableObjectState>();

/** Configure D1 object runtime behavior from the Durable Object constructor. */
export function setupD1Object(ctx: DurableObjectState, config: D1ObjectRuntimeConfig = {}): void {
	if (configuredStates.has(ctx)) {
		return;
	}
	configuredStates.add(ctx);

	ctx.blockConcurrencyWhile(async () => {
		const d1Ctx = ctx as D1ObjectState;
		if (d1Ctx.primaryStub) {
			return;
		}

		if (config.readReplication === false) {
			await configureD1ReadReplicationIfAvailable(d1Ctx, 'disabled');
			return;
		}

		const readReplication = config.readReplication ?? { mode: 'auto' as const };
		if (readReplication.enabled !== undefined) {
			const enabled = typeof readReplication.enabled === 'function'
				? await readReplication.enabled(ctx)
				: readReplication.enabled;
			if (!enabled) {
				await configureD1ReadReplicationIfAvailable(d1Ctx, 'disabled');
				return;
			}
		}

		if (readReplication.mode === 'disabled') {
			await configureD1ReadReplicationIfAvailable(d1Ctx, 'disabled');
			return;
		}

		if (typeof d1Ctx.configureReadReplication !== 'function') {
			throw new Error('D1 read replication is not available in this runtime');
		}
		await d1Ctx.configureReadReplication({ mode: readReplication.mode });
	});
}

async function configureD1ReadReplicationIfAvailable(
	ctx: D1ObjectState,
	mode: 'auto' | 'disabled',
): Promise<void> {
	if (typeof ctx.configureReadReplication === 'function') {
		await ctx.configureReadReplication({ mode });
	}
}

export function isD1ObjectReplica(ctx: DurableObjectState): boolean {
	return (ctx as D1ObjectState).primaryStub !== undefined;
}
