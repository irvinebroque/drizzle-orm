import chalk from 'chalk';
import { readFileSync, rmSync, writeFileSync } from 'fs';
import fs from 'fs';
import { render } from 'hanji';
import { join } from 'path';
import { Journal } from '../../utils';
import type { Driver } from '../validations/common';
import { DropMigrationView } from '../views';
import { embeddedMigrations } from './migrate';

export const dropMigration = async ({
	out,
	bundle,
	driver,
}: {
	out: string;
	bundle: boolean;
	driver?: Driver;
}) => {
	const metaFilePath = join(out, 'meta', '_journal.json');
	const journal = JSON.parse(readFileSync(metaFilePath, 'utf-8')) as Journal;

	if (journal.entries.length === 0) {
		console.log(
			`[${chalk.blue('i')}] no migration entries found in ${metaFilePath}`,
		);
		return;
	}

	const result = await render(new DropMigrationView(journal.entries));
	if (result.status === 'aborted') return;

	delete journal.entries[journal.entries.indexOf(result.data!)];

	const resultJournal: Journal = {
		...journal,
		entries: journal.entries.filter(Boolean),
	};
	const sqlFilePath = join(out, `${result.data.tag}.sql`);
	const snapshotFilePath = join(
		out,
		'meta',
		`${result.data.tag.split('_')[0]}_snapshot.json`,
	);
	rmSync(sqlFilePath);
	rmSync(snapshotFilePath);
	writeFileSync(metaFilePath, JSON.stringify(resultJournal, null, 2));

	if (bundle) {
		fs.writeFileSync(
			join(out, `migrations.js`),
			embeddedMigrations(resultJournal, driver),
		);
	}

	console.log(
		`[${chalk.green('✓')}] ${
			chalk.bold(
				result.data.tag,
			)
		} migration successfully dropped`,
	);
};
