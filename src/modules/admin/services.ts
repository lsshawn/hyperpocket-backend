import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { transaction, walletAccount } from "../../db/schema.js";

/**
 * Get paginated transaction list with fee breakdown for admin dashboard
 */
export async function getTransactionList(params: {
	page?: number;
	limit?: number;
	userId?: string;
	type?: "deposit" | "withdrawal" | "transfer" | "payment" | "fee" | "refund";
	currency?: string;
	processor?: "braintree" | "stripe" | "adyen" | "razorpay";
	startDate?: Date;
	endDate?: Date;
}) {
	const {
		page = 1,
		limit = 50,
		userId,
		type,
		currency,
		processor,
		startDate,
		endDate,
	} = params;

	const offset = (page - 1) * limit;

	// Build where conditions
	const conditions = [];

	if (type) {
		conditions.push(eq(transaction.type, type));
	}

	if (currency) {
		conditions.push(eq(transaction.currency, currency.toUpperCase()));
	}

	if (processor) {
		conditions.push(eq(transaction.processor, processor));
	}

	if (startDate) {
		conditions.push(gte(transaction.createdAt, startDate));
	}

	if (endDate) {
		conditions.push(lte(transaction.createdAt, endDate));
	}

	// If userId is provided, we need to join with walletAccount to filter by userId
	let query = db
		.select({
			id: transaction.id,
			type: transaction.type,
			direction: transaction.direction,
			status: transaction.status,
			grossAmount: transaction.grossAmount,
			fee: transaction.fee,
			netAmount: transaction.netAmount,
			currency: transaction.currency,
			processor: transaction.processor,
			processorTransactionId: transaction.processorTransactionId,
			productType: transaction.productType,
			sourceEntityType: transaction.sourceEntityType,
			sourceEntityId: transaction.sourceEntityId,
			platformRef: transaction.platformRef,
			description: transaction.description,
			reference: transaction.reference,
			createdAt: transaction.createdAt,
			settledAt: transaction.settledAt,
			walletAccountId: transaction.walletAccountId,
		})
		.from(transaction);

	if (conditions.length > 0) {
		query = query.where(and(...conditions)) as any;
	}

	const transactions = await query
		.orderBy(desc(transaction.createdAt))
		.limit(limit)
		.offset(offset);

	// Get total count for pagination
	const countQuery = db
		.select({ count: sql<number>`count(*)::int` })
		.from(transaction);

	if (conditions.length > 0) {
		countQuery.where(and(...conditions));
	}

	const [{ count: total }] = await countQuery;

	return {
		transactions,
		pagination: {
			page,
			limit,
			total,
			totalPages: Math.ceil(total / limit),
		},
	};
}

/**
 * Get fee summary/totals for admin dashboard
 * Shows total fees paid to processors vs potential platform revenue
 */
export async function getFeeSummary(params: {
	currency?: string;
	startDate?: Date;
	endDate?: Date;
	processor?: "braintree" | "stripe" | "adyen" | "razorpay";
}) {
	const { currency, startDate, endDate, processor } = params;

	const conditions = [];

	// Only include completed transactions in fee summary
	conditions.push(eq(transaction.status, "completed"));

	if (currency) {
		conditions.push(eq(transaction.currency, currency.toUpperCase()));
	}

	if (processor) {
		conditions.push(eq(transaction.processor, processor));
	}

	if (startDate) {
		conditions.push(gte(transaction.createdAt, startDate));
	}

	if (endDate) {
		conditions.push(lte(transaction.createdAt, endDate));
	}

	// Get totals by transaction type
	const summary = await db
		.select({
			type: transaction.type,
			currency: transaction.currency,
			processor: transaction.processor,
			totalGrossAmount: sql<string>`SUM(${transaction.grossAmount})`,
			totalFees: sql<string>`SUM(${transaction.fee})`,
			totalNetAmount: sql<string>`SUM(${transaction.netAmount})`,
			transactionCount: sql<number>`COUNT(*)::int`,
		})
		.from(transaction)
		.where(and(...conditions))
		.groupBy(transaction.type, transaction.currency, transaction.processor);

	// Calculate overall totals
	const overallTotals = await db
		.select({
			totalGrossAmount: sql<string>`SUM(${transaction.grossAmount})`,
			totalProcessorFees: sql<string>`SUM(${transaction.fee})`,
			totalNetAmount: sql<string>`SUM(${transaction.netAmount})`,
			transactionCount: sql<number>`COUNT(*)::int`,
		})
		.from(transaction)
		.where(and(...conditions));

	return {
		summary,
		totals: overallTotals[0],
	};
}

/**
 * Get processor-specific fee breakdown
 */
export async function getProcessorFeeBreakdown(params: {
	startDate?: Date;
	endDate?: Date;
}) {
	const { startDate, endDate } = params;

	const conditions = [eq(transaction.status, "completed")];

	if (startDate) {
		conditions.push(gte(transaction.createdAt, startDate));
	}

	if (endDate) {
		conditions.push(lte(transaction.createdAt, endDate));
	}

	const breakdown = await db
		.select({
			processor: transaction.processor,
			currency: transaction.currency,
			totalTransactions: sql<number>`COUNT(*)::int`,
			totalVolume: sql<string>`SUM(${transaction.grossAmount})`,
			totalFeesPaid: sql<string>`SUM(${transaction.fee})`,
			avgFeePercentage: sql<string>`
				CASE
					WHEN SUM(${transaction.grossAmount}) > 0
					THEN (SUM(${transaction.fee}) / SUM(${transaction.grossAmount}) * 100)
					ELSE 0
				END
			`,
		})
		.from(transaction)
		.where(and(...conditions))
		.groupBy(transaction.processor, transaction.currency);

	return breakdown;
}
