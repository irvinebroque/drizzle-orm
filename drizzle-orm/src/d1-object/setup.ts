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
		if (config.readReplication === false) {
			return;
		}

		const d1Ctx = ctx as D1ObjectState;
		if (d1Ctx.primaryStub) {
			return;
		}

		const readReplication = config.readReplication ?? { mode: 'auto' as const };
		if (readReplication.enabled !== undefined) {
			const enabled = typeof readReplication.enabled === 'function'
				? await readReplication.enabled(ctx)
				: readReplication.enabled;
			if (!enabled) {
				return;
			}
		}

		if (typeof d1Ctx.configureReadReplication !== 'function') {
			throw new Error('D1 read replication is not available in this runtime');
		}

		await d1Ctx.configureReadReplication({ mode: readReplication.mode });
	});
}

export function isD1ObjectReplica(ctx: DurableObjectState): boolean {
	return (ctx as D1ObjectState).primaryStub !== undefined;
}
