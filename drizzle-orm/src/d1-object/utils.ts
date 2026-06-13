import type { Query } from '~/sql/sql.ts';

export function isD1ObjectMutationSql(sql: string): boolean {
	const token = getFirstSqlToken(sql);
	if (!token) {
		return false;
	}

	return token !== 'select' && token !== 'explain';
}

export function assertD1ObjectReadQuery(query: Query): void {
	if (isD1ObjectMutationSql(query.sql)) {
		throw new Error(
			'D1 object read helpers only accept SELECT or EXPLAIN statements. Run mutation SQL on the primary object.',
		);
	}
}

function getFirstSqlToken(sql: string): string | undefined {
	let source = sql.trimStart();

	while (source.startsWith('--') || source.startsWith('/*')) {
		if (source.startsWith('--')) {
			const newlineIndex = source.indexOf('\n');
			source = newlineIndex === -1 ? '' : source.slice(newlineIndex + 1).trimStart();
			continue;
		}

		const commentEndIndex = source.indexOf('*/');
		if (commentEndIndex === -1) {
			return undefined;
		}
		source = source.slice(commentEndIndex + 2).trimStart();
	}

	return /^[A-Za-z]+/.exec(source)?.[0].toLowerCase();
}
