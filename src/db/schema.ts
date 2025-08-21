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
	pgEnum,
	char
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const walletStatusEnum = pgEnum('wallet_status', ['active', 'inactive', 'frozen']);
export const transactionTypeEnum = pgEnum('transaction_type', ['deposit', 'withdrawal', 'transfer', 'payment', 'fee']);
export const transactionStatusEnum = pgEnum('transaction_status', [
	'pending',
	'completed',
	'failed',
	'cancelled',
	'reversed'
]);
export const transactionDirectionEnum = pgEnum('transaction_direction', ['credit', 'debit']);

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
		// `balance` is the ledger balance, which includes all funds (available + pending).
		balance: numeric('balance', { precision: 19, scale: 4 }).default('0').notNull(),
		// `availableBalance` is the portion of the balance that is settled and can be spent.
		availableBalance: numeric('available_balance', { precision: 19, scale: 4 }).default('0').notNull(),
		createdAt: timestamp('created_at').defaultNow().notNull(),
		updatedAt: timestamp('updated_at').defaultNow().notNull(),
		deletedAt: timestamp('deleted_at')
	},
	table => {
		return {
			walletCurrencyUnique: unique('wallet_currency_unique').on(table.walletId, table.currency),
			balanceCheck: check('balance_check', sql`${table.availableBalance} <= ${table.balance}`)
		};
	}
);

export const transfer = pgTable('transfer', {
  id: uuid().defaultRandom().primaryKey().notNull(),
  reference: text('reference').unique().notNull(), // idempotency
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const transaction = pgTable(
  'transactions',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),

    // Wallet account
    walletAccountId: uuid('wallet_account_id')
      .notNull()
      .references(() => walletAccount.id, { onDelete: 'restrict' }),

    // Business info
    type: transactionTypeEnum('type').notNull(),
    direction: transactionDirectionEnum('direction').notNull(),
    status: transactionStatusEnum('status').default('pending').notNull(),

    // Amounts
    grossAmount: numeric('gross_amount', { precision: 19, scale: 4 }).notNull(),
    fee: numeric('fee', { precision: 19, scale: 4 }).default('0').notNull(),
    netAmount: numeric('net_amount', { precision: 19, scale: 4 }).notNull(),

    currency: char('currency', { length: 3 }).default('USD').notNull(),

    // Optional references
    transferId: uuid('transfer_id'), // FK to transfers table
    reversalOf: uuid('reversal_of'), // self-reference

    description: text('description'),
    metadata: jsonb('metadata'),
    createdBy: uuid('created_by'),

    // Timestamps
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    settledAt: timestamp('settled_at'),

    reference: text('reference').unique(),
  },
  (table) => {
    return {
      // Ensure positive amounts and gross = net + fee
      amountCheck: check(
        'amount_check',
        sql`${table.grossAmount} >= 0 AND ${table.fee} >= 0 AND ${table.netAmount} >= 0 AND ${table.grossAmount} = ${table.netAmount} + ${table.fee}`
      ),

      // Indexes
      idxWalletDate: index('idx_wallet_date').on(table.walletAccountId, table.createdAt),
      idxReference: index('idx_reference').on(table.reference),
      idxTransfer: index('idx_transfer').on(table.transferId),
    };
  }
);
