import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import {
	invoice,
	invoiceLineItem,
	transaction,
	walletAccount,
} from "../../db/schema.js";

/**
 * Create a new invoice for platform fees
 */
export async function createInvoice(params: {
	userId: string;
	currency: string;
	productType?: "ride_hailing" | "car_rental" | "delivery";
	periodStart: Date;
	periodEnd: Date;
	dueDate: Date;
	lineItems: Array<{
		description: string;
		quantity: number;
		unitPrice: number;
		sourceEntityType?: string;
		sourceEntityId?: string;
	}>;
	description?: string;
	notes?: string;
}) {
	const {
		userId,
		currency,
		productType,
		periodStart,
		periodEnd,
		dueDate,
		lineItems,
		description,
		notes,
	} = params;

	return db.transaction(async (tx) => {
		// Calculate totals
		const subtotal = lineItems.reduce(
			(sum, item) => sum + item.quantity * item.unitPrice,
			0,
		);
		const taxAmount = 0; // TODO: Add tax calculation logic if needed
		const totalAmount = subtotal + taxAmount;

		// Generate invoice number
		const invoiceNumber = `INV-${new Date().getFullYear()}-${nanoid(6)}`;

		// Create invoice
		const [newInvoice] = await tx
			.insert(invoice)
			.values({
				invoiceNumber,
				userId,
				subtotal: subtotal.toFixed(4),
				taxAmount: taxAmount.toFixed(4),
				totalAmount: totalAmount.toFixed(4),
				currency: currency.toUpperCase(),
				status: "pending",
				dueDate,
				productType: productType as any,
				periodStart,
				periodEnd,
				description,
				notes,
			})
			.returning();

		// Create line items
		const lineItemsToInsert = lineItems.map((item) => ({
			invoiceId: newInvoice.id,
			description: item.description,
			quantity: item.quantity.toString(),
			unitPrice: item.unitPrice.toFixed(4),
			amount: (item.quantity * item.unitPrice).toFixed(4),
			sourceEntityType: item.sourceEntityType,
			sourceEntityId: item.sourceEntityId,
		}));

		await tx.insert(invoiceLineItem).values(lineItemsToInsert);

		// Return invoice with line items
		const items = await tx.query.invoiceLineItem.findMany({
			where: eq(invoiceLineItem.invoiceId, newInvoice.id),
		});

		return {
			...newInvoice,
			lineItems: items,
		};
	});
}

/**
 * Get invoice by ID
 */
export async function getInvoiceById(invoiceId: string) {
	const invoiceData = await db.query.invoice.findFirst({
		where: eq(invoice.id, invoiceId),
	});

	if (!invoiceData) {
		throw new Error("Invoice not found");
	}

	const items = await db.query.invoiceLineItem.findMany({
		where: eq(invoiceLineItem.invoiceId, invoiceId),
	});

	return {
		...invoiceData,
		lineItems: items,
	};
}

/**
 * Get invoices for a user
 */
export async function getInvoicesByUser(params: {
	userId: string;
	status?: "draft" | "pending" | "paid" | "cancelled" | "overdue";
	page?: number;
	limit?: number;
}) {
	const { userId, status, page = 1, limit = 50 } = params;
	const offset = (page - 1) * limit;

	const conditions = [eq(invoice.userId, userId)];

	if (status) {
		conditions.push(eq(invoice.status, status));
	}

	const invoices = await db.query.invoice.findMany({
		where: and(...conditions),
		orderBy: [desc(invoice.createdAt)],
		limit,
		offset,
	});

	// Get line items for each invoice
	const invoicesWithItems = await Promise.all(
		invoices.map(async (inv) => {
			const items = await db.query.invoiceLineItem.findMany({
				where: eq(invoiceLineItem.invoiceId, inv.id),
			});
			return { ...inv, lineItems: items };
		}),
	);

	// Get total count
	const countQuery = db
		.select({ count: sql<number>`count(*)::int` })
		.from(invoice)
		.where(and(...conditions));

	const [{ count: total }] = await countQuery;

	return {
		invoices: invoicesWithItems,
		pagination: {
			page,
			limit,
			total,
			totalPages: Math.ceil(total / limit),
		},
	};
}

/**
 * Get all invoices (admin)
 */
export async function getAllInvoices(params: {
	status?: "draft" | "pending" | "paid" | "cancelled" | "overdue";
	productType?: "ride_hailing" | "car_rental" | "delivery";
	startDate?: Date;
	endDate?: Date;
	page?: number;
	limit?: number;
}) {
	const { status, productType, startDate, endDate, page = 1, limit = 50 } = params;
	const offset = (page - 1) * limit;

	const conditions = [];

	if (status) {
		conditions.push(eq(invoice.status, status));
	}

	if (productType) {
		conditions.push(eq(invoice.productType, productType));
	}

	if (startDate) {
		conditions.push(gte(invoice.createdAt, startDate));
	}

	if (endDate) {
		conditions.push(lte(invoice.createdAt, endDate));
	}

	let query = db.query.invoice.findMany({
		orderBy: [desc(invoice.createdAt)],
		limit,
		offset,
	});

	if (conditions.length > 0) {
		query = db.query.invoice.findMany({
			where: and(...conditions),
			orderBy: [desc(invoice.createdAt)],
			limit,
			offset,
		});
	}

	const invoices = await query;

	// Get total count
	const countQuery = db
		.select({ count: sql<number>`count(*)::int` })
		.from(invoice);

	if (conditions.length > 0) {
		countQuery.where(and(...conditions));
	}

	const [{ count: total }] = await countQuery;

	return {
		invoices,
		pagination: {
			page,
			limit,
			total,
			totalPages: Math.ceil(total / limit),
		},
	};
}

/**
 * Mark invoice as paid
 * Debits the user's wallet to clear the invoice
 */
export async function markInvoiceAsPaid(params: {
	invoiceId: string;
	debitFromWallet?: boolean; // If true, automatically debit user's wallet
}) {
	const { invoiceId, debitFromWallet = true } = params;

	return db.transaction(async (tx) => {
		const invoiceData = await tx.query.invoice.findFirst({
			where: eq(invoice.id, invoiceId),
		});

		if (!invoiceData) {
			throw new Error("Invoice not found");
		}

		if (invoiceData.status === "paid") {
			throw new Error("Invoice already paid");
		}

		let transactionId: string | null = null;

		// Debit user's wallet if requested
		if (debitFromWallet) {
			// Find user's wallet account
			const userWallet = await tx.query.wallet.findFirst({
				where: sql`${sql.identifier("user_id")} = ${invoiceData.userId}`,
			});

			if (!userWallet) {
				throw new Error("User wallet not found");
			}

			const account = await tx.query.walletAccount.findFirst({
				where: and(
					eq(walletAccount.walletId, userWallet.id),
					eq(walletAccount.currency, invoiceData.currency),
				),
			});

			if (!account) {
				throw new Error(
					`Wallet account not found for currency ${invoiceData.currency}`,
				);
			}

			// Check available balance
			const amount = Number.parseFloat(invoiceData.totalAmount);

			// Debit wallet atomically
			const updated = await tx
				.update(walletAccount)
				.set({
					balance: sql`${walletAccount.balance} - ${amount}`,
					availableBalance: sql`${walletAccount.availableBalance} - ${amount}`,
				})
				.where(
					and(
						eq(walletAccount.id, account.id),
						sql`${walletAccount.availableBalance} >= ${amount}`,
					),
				)
				.returning();

			if (updated.length === 0) {
				throw new Error("Insufficient available balance to pay invoice");
			}

			// Create transaction record
			const [newTransaction] = await tx
				.insert(transaction)
				.values({
					walletAccountId: account.id,
					type: "fee",
					status: "completed",
					direction: "debit",
					currency: invoiceData.currency,
					grossAmount: invoiceData.totalAmount,
					fee: "0",
					netAmount: invoiceData.totalAmount,
					description: `Payment for invoice ${invoiceData.invoiceNumber}`,
					reference: `FEE-${nanoid()}`,
					productType: invoiceData.productType as any,
					platformRef: `INV-PAY-${nanoid()}`,
				})
				.returning();

			transactionId = newTransaction.id;
		}

		// Update invoice status
		const [updatedInvoice] = await tx
			.update(invoice)
			.set({
				status: "paid",
				paidAt: new Date(),
				paymentTransactionId: transactionId,
				updatedAt: new Date(),
			})
			.where(eq(invoice.id, invoiceId))
			.returning();

		return updatedInvoice;
	});
}

/**
 * Cancel invoice
 */
export async function cancelInvoice(invoiceId: string) {
	const [updatedInvoice] = await db
		.update(invoice)
		.set({
			status: "cancelled",
			updatedAt: new Date(),
		})
		.where(eq(invoice.id, invoiceId))
		.returning();

	if (!updatedInvoice) {
		throw new Error("Invoice not found");
	}

	return updatedInvoice;
}

/**
 * Mark overdue invoices
 * This should be run periodically (e.g., daily CRON job)
 */
export async function markOverdueInvoices() {
	const now = new Date();

	const overdueInvoices = await db
		.update(invoice)
		.set({
			status: "overdue",
			updatedAt: now,
		})
		.where(
			and(
				eq(invoice.status, "pending"),
				lte(invoice.dueDate, now),
			),
		)
		.returning();

	return overdueInvoices;
}

/**
 * Generate weekly invoice for platform fees
 * This is a helper function that can be called from a CRON job
 */
export async function generateWeeklyInvoicesForFees(params: {
	periodStart: Date;
	periodEnd: Date;
	dueDate: Date;
	feePercentage: number; // e.g., 0.15 for 15%
	productType?: "ride_hailing" | "car_rental" | "delivery";
}) {
	const { periodStart, periodEnd, dueDate, feePercentage, productType } = params;

	// TODO: Query your source entities (bookings, rides, orders) to find
	// completed transactions where fees are owed
	// For now, this is a placeholder implementation

	// Example: Find all completed bookings in the period and calculate fees
	const conditions = [
		eq(transaction.type, "payment"),
		eq(transaction.status, "completed"),
		gte(transaction.createdAt, periodStart),
		lte(transaction.createdAt, periodEnd),
	];

	if (productType) {
		conditions.push(eq(transaction.productType, productType));
	}

	// Group by user and calculate total fees owed
	const feesOwed = await db
		.select({
			userId: sql<string>`u.id`,
			currency: transaction.currency,
			totalAmount: sql<string>`SUM(${transaction.netAmount})`,
			transactionCount: sql<number>`COUNT(*)::int`,
		})
		.from(transaction)
		.innerJoin(
			sql`wallets w`,
			sql`${transaction.walletAccountId} IN (SELECT id FROM wallet_accounts WHERE wallet_id = w.id)`,
		)
		.innerJoin(sql`users u`, sql`w.user_id = u.id`)
		.where(and(...conditions))
		.groupBy(sql`u.id`, transaction.currency);

	// Create invoices for each user
	const createdInvoices = await Promise.all(
		feesOwed.map(async (fee) => {
			const feeAmount = Number.parseFloat(fee.totalAmount) * feePercentage;

			return createInvoice({
				userId: fee.userId,
				currency: fee.currency,
				productType,
				periodStart,
				periodEnd,
				dueDate,
				lineItems: [
					{
						description: `Platform fee (${(feePercentage * 100).toFixed(1)}%) for ${fee.transactionCount} transactions`,
						quantity: 1,
						unitPrice: feeAmount,
					},
				],
				description: `Weekly platform fees for ${periodStart.toISOString().split("T")[0]} to ${periodEnd.toISOString().split("T")[0]}`,
			});
		}),
	);

	return createdInvoices;
}
