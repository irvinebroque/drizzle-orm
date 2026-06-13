import { test as brotest } from '@drizzle-team/brocli';
import { assert, expect, test } from 'vitest';
import { drop } from '../src/cli/schema';

test('drop bundles d1-object migrations', async () => {
	const res = await brotest(drop, '--config=d1-object.config.ts');
	if (res.type !== 'handler') assert.fail(res.type, 'handler');
	expect(res.options).toStrictEqual({
		out: 'drizzle',
		bundle: true,
		driver: 'd1-object',
	});
});
