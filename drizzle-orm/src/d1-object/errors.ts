export class D1ObjectReplicaWriteError extends Error {
	readonly code = 'D1_OBJECT_REPLICA_WRITE';

	constructor(message = 'D1 object write queries must run on the primary object') {
		super(message);
		this.name = 'D1ObjectReplicaWriteError';
	}
}

export function isD1ObjectReplicaWriteError(error: unknown): error is D1ObjectReplicaWriteError {
	const seen = new Set<unknown>();
	let current = error;

	while (current && typeof current === 'object' && !seen.has(current)) {
		seen.add(current);

		if (
			current instanceof D1ObjectReplicaWriteError
			|| (current as { code?: unknown }).code === 'D1_OBJECT_REPLICA_WRITE'
			|| (current as { name?: unknown }).name === 'D1ObjectReplicaWriteError'
		) {
			return true;
		}

		current = (current as { cause?: unknown }).cause;
	}

	return false;
}
