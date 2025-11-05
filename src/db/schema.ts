import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	char,
	check,
	date,
	doublePrecision,
	foreignKey,
	index,
	integer,
	json,
	jsonb,
	numeric,
	pgEnum,
	pgPolicy,
	pgSequence,
	pgTable,
	pgView,
	primaryKey,
	real,
	serial,
	text,
	timestamp,
	unique,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";

export const walletStatusEnum = pgEnum("wallet_status", [
	"active",
	"inactive",
	"frozen",
]);
export const transactionTypeEnum = pgEnum("transaction_type", [
	"deposit",
	"withdrawal",
	"transfer",
	"payment",
	"fee",
	"refund",
]);
export const transactionStatusEnum = pgEnum("transaction_status", [
	"pending",
	"completed",
	"failed",
	"cancelled",
	"reversed",
]);
export const transactionDirectionEnum = pgEnum("transaction_direction", [
	"credit",
	"debit",
]);
export const productTypeEnum = pgEnum("product_type", [
	"ride_hailing",
	"car_rental",
	"delivery",
]);
export const paymentMethodEnum = pgEnum("payment_method", [
	"credit_card",
	"debit_card",
	"cash",
	"bank_transfer",
	"wallet",
]);
export const authorizationStatusEnum = pgEnum("authorization_status", [
	"authorized",
	"captured",
	"voided",
	"expired",
	"settled",
	"partially_captured",
]);
export const paymentProcessorEnum = pgEnum("payment_processor", [
	"braintree",
	"stripe",
	"adyen",
	"razorpay",
]);

export const user = pgTable("users", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	createdAt: timestamp("created_at").defaultNow().notNull(),
	updatedAt: timestamp("updated_at").defaultNow().notNull(),
	deletedAt: timestamp("deleted_at"),
	name: text(),
	email: text().unique(),
	phone: text(),
	otp: integer(),
	otpExpiry: integer("otp_expiry"),
	otpAttempts: integer("otp_attempts"),
});

export const wallet = pgTable("wallets", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" })
		.unique(),
	status: walletStatusEnum("status").default("active").notNull(),
	createdAt: timestamp("created_at").defaultNow().notNull(),
	updatedAt: timestamp("updated_at").defaultNow().notNull(),
	deletedAt: timestamp("deleted_at"),
});

export const walletAccount = pgTable(
	"wallet_accounts",
	{
		id: uuid().defaultRandom().primaryKey().notNull(),
		walletId: uuid("wallet_id")
			.notNull()
			.references(() => wallet.id, { onDelete: "cascade" }),
		currency: varchar("currency", { length: 10 }).notNull(), // ISO 4217 currency codes e.g. 'USD', 'NGN'
		// `balance` is the ledger balance, which includes all funds (available + pending).
		balance: numeric("balance", { precision: 19, scale: 4 })
			.default("0")
			.notNull(),
		// `availableBalance` is the portion of the balance that is settled and can be spent.
		availableBalance: numeric("available_balance", { precision: 19, scale: 4 })
			.default("0")
			.notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
		deletedAt: timestamp("deleted_at"),
	},
	(table) => {
		return {
			walletCurrencyUnique: unique("wallet_currency_unique").on(
				table.walletId,
				table.currency,
			),
			balanceCheck: check(
				"balance_check",
				sql`${table.availableBalance} <= ${table.balance}`,
			),
		};
	},
);

export const transfer = pgTable("transfer", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	reference: text("reference").unique().notNull(), // idempotency
	createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const transaction = pgTable(
	"transactions",
	{
		id: uuid().defaultRandom().primaryKey().notNull(),

		// Wallet account
		walletAccountId: uuid("wallet_account_id")
			.notNull()
			.references(() => walletAccount.id, { onDelete: "restrict" }),

		// Business info
		type: transactionTypeEnum("type").notNull(),
		direction: transactionDirectionEnum("direction").notNull(),
		status: transactionStatusEnum("status").default("pending").notNull(),

		// Amounts
		grossAmount: numeric("gross_amount", { precision: 19, scale: 4 }).notNull(),
		fee: numeric("fee", { precision: 19, scale: 4 }).default("0").notNull(),
		netAmount: numeric("net_amount", { precision: 19, scale: 4 }).notNull(),

		currency: char("currency", { length: 3 }).default("USD").notNull(),

		// Optional references
		transferId: uuid("transfer_id"), // FK to transfers table
		reversalOf: uuid("reversal_of"), // self-reference

		// Multi-product SOA fields (as per CLAUDE.md)
		productType: productTypeEnum("product_type"), // ride_hailing, car_rental, delivery
		sourceEntityType: text("source_entity_type"), // e.g., 'rental_booking', 'ride_request'
		sourceEntityId: uuid("source_entity_id"), // UUID from originating product's DB
		platformRef: text("platform_ref").unique(), // globally unique reference for audit

		// Payment processor tracking
		processor: paymentProcessorEnum("processor"), // Which processor handled this transaction
		processorTransactionId: text("processor_transaction_id"), // Transaction ID from processor

		description: text("description"),
		metadata: jsonb("metadata"),
		createdBy: uuid("created_by"),

		// Timestamps
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
		settledAt: timestamp("settled_at"),

		reference: text("reference").unique(),
	},
	(table) => {
		return {
			// Ensure positive amounts and gross = net + fee
			amountCheck: check(
				"amount_check",
				sql`${table.grossAmount} >= 0 AND ${table.fee} >= 0 AND ${table.netAmount} >= 0 AND ${table.grossAmount} = ${table.netAmount} + ${table.fee}`,
			),

			// Indexes
			idxWalletDate: index("idx_wallet_date").on(
				table.walletAccountId,
				table.createdAt,
			),
			idxReference: index("idx_reference").on(table.reference),
			idxTransfer: index("idx_transfer").on(table.transferId),
			idxPlatformRef: index("idx_platform_ref").on(table.platformRef),
			idxSourceEntity: index("idx_source_entity").on(table.sourceEntityId),
		};
	},
);

// Payment authorization table (for pre-auth, holds, deposits)
export const paymentAuthorization = pgTable(
	"payment_authorizations",
	{
		id: uuid().defaultRandom().primaryKey().notNull(),

		// Gateway info
		gatewayTransactionId: text("gateway_transaction_id").unique().notNull(), // Processor transaction ID
		gatewayAuthorizationId: text("gateway_authorization_id"), // For auth-only transactions
		paymentMethod: paymentMethodEnum("payment_method").notNull(),
		processor: paymentProcessorEnum("processor").default("braintree").notNull(), // Which processor handled this

		// User and amounts
		userId: uuid("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "restrict" }),
		authorizedAmount: numeric("authorized_amount", {
			precision: 19,
			scale: 4,
		}).notNull(),
		capturedAmount: numeric("captured_amount", { precision: 19, scale: 4 })
			.default("0")
			.notNull(),
		remainingAmount: numeric("remaining_amount", {
			precision: 19,
			scale: 4,
		}).notNull(),
		currency: char("currency", { length: 3 }).default("USD").notNull(),

		// Status and lifecycle
		status: authorizationStatusEnum("status").default("authorized").notNull(),
		expiresAt: timestamp("expires_at"),

		// Multi-product SOA fields
		productType: productTypeEnum("product_type"), // ride_hailing, car_rental, delivery
		sourceEntityType: text("source_entity_type"), // e.g., 'rental_booking', 'ride_request'
		sourceEntityId: uuid("source_entity_id"), // UUID from originating product's DB
		platformRef: text("platform_ref").unique(), // globally unique reference

		// Idempotency
		idempotencyKey: text("idempotency_key").unique(),

		// Metadata
		description: text("description"),
		metadata: jsonb("metadata"),

		// Timestamps
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
		capturedAt: timestamp("captured_at"),
		voidedAt: timestamp("voided_at"),
	},
	(table) => {
		return {
			// Ensure remaining = authorized - captured
			amountCheck: check(
				"auth_amount_check",
				sql`${table.capturedAmount} <= ${table.authorizedAmount} AND ${table.remainingAmount} = ${table.authorizedAmount} - ${table.capturedAmount}`,
			),

			// Indexes
			idxUserId: index("idx_auth_user_id").on(table.userId),
			idxGatewayTxn: index("idx_gateway_txn").on(table.gatewayTransactionId),
			idxSourceEntity: index("idx_auth_source_entity").on(table.sourceEntityId),
			idxPlatformRef: index("idx_auth_platform_ref").on(table.platformRef),
			idxIdempotency: index("idx_auth_idempotency").on(table.idempotencyKey),
		};
	},
);

// Refund table (tracks all refunds)
export const refund = pgTable(
	"refunds",
	{
		id: uuid().defaultRandom().primaryKey().notNull(),

		// Gateway and transaction references
		gatewayRefundId: text("gateway_refund_id").unique().notNull(), // Processor refund ID
		originalGatewayTransactionId: text(
			"original_gateway_transaction_id",
		).notNull(),
		originalTransactionId: uuid("original_transaction_id").references(
			() => transaction.id,
			{ onDelete: "restrict" },
		),
		refundTransactionId: uuid("refund_transaction_id").references(
			() => transaction.id,
			{ onDelete: "restrict" },
		),
		processor: paymentProcessorEnum("processor").default("braintree").notNull(), // Which processor handled this refund

		// Amounts
		refundAmount: numeric("refund_amount", {
			precision: 19,
			scale: 4,
		}).notNull(),
		currency: char("currency", { length: 3 }).default("USD").notNull(),

		// Status
		status: transactionStatusEnum("status").default("pending").notNull(),

		// Multi-product SOA fields
		productType: productTypeEnum("product_type"),
		sourceEntityType: text("source_entity_type"),
		sourceEntityId: uuid("source_entity_id"),
		platformRef: text("platform_ref").unique(),

		// Reason and metadata
		reason: text("reason"),
		description: text("description"),
		metadata: jsonb("metadata"),

		// Timestamps
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
		completedAt: timestamp("completed_at"),
	},
	(table) => {
		return {
			// Indexes
			idxGatewayRefund: index("idx_gateway_refund").on(table.gatewayRefundId),
			idxOriginalTxn: index("idx_original_txn").on(table.originalTransactionId),
			idxRefundTxn: index("idx_refund_txn").on(table.refundTransactionId),
			idxSourceEntity: index("idx_refund_source_entity").on(
				table.sourceEntityId,
			),
		};
	},
);
