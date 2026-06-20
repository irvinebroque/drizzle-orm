import { integer, sqliteTable, text } from '~/sqlite-core/index.ts';

export const posts = sqliteTable('posts', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	title: text('title').notNull(),
});

export const schema = { posts };
