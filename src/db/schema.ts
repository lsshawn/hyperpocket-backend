import {
	pgTable,
	foreignKey,
	uuid,
	timestamp,
	text,
	bigint,
	json,
	real,
	jsonb,
	boolean,
	integer,
	unique,
	varchar,
	pgPolicy,
	check,
	numeric,
	date,
	serial,
	index,
	doublePrecision,
	primaryKey,
	pgView,
	pgSequence,
	pgEnum
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const walletStatusEnum = pgEnum('wallet_status', ['active', 'inactive', 'frozen']);
export const transactionTypeEnum = pgEnum('transaction_type', ['deposit', 'withdrawal', 'transfer', 'payment']);
export const transactionStatusEnum = pgEnum('transaction_status', [
	'pending',
	'completed',
	'failed',
	'cancelled',
	'reversed'
]);

export const user = pgTable('users', {
	id: uuid().defaultRandom().primaryKey().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
	updatedAt: timestamp('updated_at').defaultNow().notNull(),
	deletedAt: timestamp('deleted_at'),
	name: text(),
	email: text().unique(),
  phone: text(),
	otp: integer(),
	otpExpiry: integer('otp_expiry'),
	otpAttempts: integer('otp_attempts'),
})

export const wallet = pgTable('wallets', {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid('user_id')
		.notNull()
		.references(() => user.id, { onDelete: 'cascade' })
		.unique(),
	status: walletStatusEnum('status').default('active').notNull(),
	createdAt: timestamp('created_at').defaultNow().notNull(),
	updatedAt: timestamp('updated_at').defaultNow().notNull(),
	deletedAt: timestamp('deleted_at')
});

export const walletAccount = pgTable(
	'wallet_accounts',
	{
		id: uuid().defaultRandom().primaryKey().notNull(),
		walletId: uuid('wallet_id')
			.notNull()
			.references(() => wallet.id, { onDelete: 'cascade' }),
		currency: varchar('currency', { length: 10 }).notNull(), // ISO 4217 currency codes e.g. 'USD', 'NGN'
		balance: numeric('balance', { precision: 19, scale: 4 }).default('0').notNull(),
		createdAt: timestamp('created_at').defaultNow().notNull(),
		updatedAt: timestamp('updated_at').defaultNow().notNull(),
		deletedAt: timestamp('deleted_at')
	},
	table => {
		return {
			walletCurrencyUnique: unique('wallet_currency_unique').on(table.walletId, table.currency)
		};
	}
);

export const transaction = pgTable('transactions', {
	id: uuid().defaultRandom().primaryKey().notNull(),
	walletAccountId: uuid('wallet_account_id')
		.notNull()
		.references(() => walletAccount.id, { onDelete: 'restrict' }),
	type: transactionTypeEnum('type').notNull(),
	status: transactionStatusEnum('status').default('pending').notNull(),
	// Amount is always positive. The direction is implied by the type.
	amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
	description: text('description'),
	metadata: jsonb('metadata'), // e.g. { "paymentGateway": "stripe", "chargeId": "ch_123...", "recipientBank": "...", "recipientAccount": "..." }
	createdAt: timestamp('created_at').defaultNow().notNull(),
	updatedAt: timestamp('updated_at').defaultNow().notNull(),
	reference: text('reference').unique() // For idempotency and external references
});
