/**
 * Payment Services (Multi-Processor Version)
 *
 * This version uses the processor abstraction layer to support
 * multiple payment processors (Braintree, Stripe, Adyen, etc.)
 */

import { and, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import {
	paymentAuthorization,
	refund,
	transaction,
	wallet,
	walletAccount,
} from "../../db/schema.js";
import type { ProcessorType } from "./processors/base.js";
import { ProcessorFactory, selectProcessor } from "./processors/factory.js";

// Helper to normalize currency
function normalizeCurrency(currency: string): string {
	return currency.trim().toUpperCase();
}

// Helper to get or create wallet account
async function getOrCreateWalletAccountTx(
	tx: any,
	userId: string,
	currency: string,
) {
	const normalizedCurrency = normalizeCurrency(currency);

	// Ensure wallet exists
	await tx
		.insert(wallet)
		.values({ userId })
		.onConflictDoNothing({ target: wallet.userId });

	const userWallet = await tx.query.wallet.findFirst({
		where: eq(wallet.userId, userId),
	});
	if (!userWallet) {
		throw new Error("Failed to create wallet");
	}

	// Ensure wallet account exists
	await tx
		.insert(walletAccount)
		.values({
			walletId: userWallet.id,
			currency: normalizedCurrency,
			balance: "0",
			availableBalance: "0",
		})
		.onConflictDoNothing({
			target: [walletAccount.walletId, walletAccount.currency],
		});

	const account = await tx.query.walletAccount.findFirst({
		where: and(
			eq(walletAccount.walletId, userWallet.id),
			eq(walletAccount.currency, normalizedCurrency),
		),
	});

	if (!account) {
		throw new Error("Failed to create wallet account");
	}

	return account;
}

/**
 * Generate client token for payment UI
 */
export async function generateClientToken(
	customerId?: string,
	processorType?: ProcessorType,
) {
	const processor = ProcessorFactory.getProcessor(processorType || "braintree");
	return processor.generateClientToken(customerId);
}

/**
 * Create or get customer in processor's system
 */
export async function createOrGetCustomer(
	userId: string,
	customerData: any,
	processorType?: ProcessorType,
) {
	const processor = ProcessorFactory.getProcessor(processorType || "braintree");
	return processor.createCustomer({
		userId,
		...customerData,
	});
}

/**
 * Authorize payment (hold funds without capturing)
 */
export async function authorizePayment(params: {
	userId: string;
	amount: number;
	currency: string;
	paymentMethodNonce: string;
	productType: "ride_hailing" | "car_rental" | "delivery";
	sourceEntityType: string;
	sourceEntityId: string;
	description?: string;
	idempotencyKey: string;
	country?: string;
	processorType?: ProcessorType; // Optional override
}) {
	const {
		userId,
		amount,
		currency,
		paymentMethodNonce,
		productType,
		sourceEntityType,
		sourceEntityId,
		description,
		idempotencyKey,
		country,
		processorType,
	} = params;

	return db.transaction(async (tx) => {
		// Check idempotency
		const existing = await tx.query.paymentAuthorization.findFirst({
			where: eq(paymentAuthorization.idempotencyKey, idempotencyKey),
		});

		if (existing) {
			return existing;
		}

		// Select processor based on routing rules (or use override)
		const selectedProcessor =
			processorType ||
			selectProcessor({
				country,
				currency,
			});

		const processor = ProcessorFactory.getProcessor(selectedProcessor);

		// Authorize with selected processor
		const result = await processor.authorize({
			amount,
			currency: normalizeCurrency(currency),
			paymentMethodToken: paymentMethodNonce,
			description,
			metadata: {
				productType,
				sourceEntityType,
				sourceEntityId,
			},
		});

		const platformRef = `PAY-${nanoid()}`;

		// Create authorization record
		const [auth] = await tx
			.insert(paymentAuthorization)
			.values({
				gatewayTransactionId: result.processorTransactionId,
				gatewayAuthorizationId: result.processorAuthorizationId,
				paymentMethod: "credit_card",
				processor: selectedProcessor,
				userId,
				authorizedAmount: amount.toString(),
				capturedAmount: "0",
				remainingAmount: amount.toString(),
				currency: normalizeCurrency(currency),
				status: "authorized",
				expiresAt: result.expiresAt || null,
				productType,
				sourceEntityType,
				sourceEntityId,
				platformRef,
				idempotencyKey,
				description: description || `Authorization for ${sourceEntityType}`,
				metadata: {
					processor: selectedProcessor,
					...result.metadata,
				},
			})
			.returning();

		return auth;
	});
}

/**
 * Capture previously authorized payment (full or partial)
 */
export async function capturePayment(params: {
	authorizationId: string;
	amount?: number;
	userId: string;
	currency: string;
}) {
	const { authorizationId, amount, userId, currency } = params;

	return db.transaction(async (tx) => {
		// Get authorization
		const auth = await tx.query.paymentAuthorization.findFirst({
			where: eq(paymentAuthorization.id, authorizationId),
		});

		if (!auth) {
			throw new Error("Authorization not found");
		}

		if (auth.userId !== userId) {
			throw new Error("Unauthorized: User ID mismatch");
		}

		if (auth.status !== "authorized" && auth.status !== "partially_captured") {
			throw new Error(
				`Cannot capture authorization with status: ${auth.status}`,
			);
		}

		const captureAmount = amount || Number.parseFloat(auth.remainingAmount);

		if (captureAmount > Number.parseFloat(auth.remainingAmount)) {
			throw new Error("Capture amount exceeds remaining authorized amount");
		}

		// Get processor and capture
		const processor = ProcessorFactory.getProcessor(auth.processor);
		const result = await processor.capture({
			transactionId: auth.gatewayTransactionId,
			amount: captureAmount,
		});

		const newCapturedAmount =
			Number.parseFloat(auth.capturedAmount) + captureAmount;
		const newRemainingAmount =
			Number.parseFloat(auth.authorizedAmount) - newCapturedAmount;

		// Update authorization
		const [updatedAuth] = await tx
			.update(paymentAuthorization)
			.set({
				capturedAmount: newCapturedAmount.toString(),
				remainingAmount: newRemainingAmount.toString(),
				status: newRemainingAmount > 0 ? "partially_captured" : "captured",
				capturedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(eq(paymentAuthorization.id, authorizationId))
			.returning();

		// Create wallet transaction (credit to platform)
		const account = await getOrCreateWalletAccountTx(tx, userId, currency);

		const grossAmount = captureAmount.toString();
		const fee = "0";
		const netAmount = grossAmount;

		const [txn] = await tx
			.insert(transaction)
			.values({
				walletAccountId: account.id,
				type: "payment",
				direction: "credit",
				status: "completed",
				grossAmount,
				fee,
				netAmount,
				currency: normalizeCurrency(currency),
				productType: auth.productType,
				sourceEntityType: auth.sourceEntityType,
				sourceEntityId: auth.sourceEntityId,
				platformRef: `CAP-${nanoid()}`,
				description: `Payment captured from authorization ${auth.platformRef}`,
				reference: `PAY-${nanoid()}`,
				settledAt: new Date(),
			})
			.returning();

		// Update wallet balance
		await tx
			.update(walletAccount)
			.set({
				balance: sql`${walletAccount.balance} + ${netAmount}`,
				availableBalance: sql`${walletAccount.availableBalance} + ${netAmount}`,
			})
			.where(eq(walletAccount.id, account.id));

		return { authorization: updatedAuth, transaction: txn };
	});
}

/**
 * Void/Release authorization without capturing
 */
export async function voidAuthorization(params: {
	authorizationId: string;
	userId: string;
}) {
	const { authorizationId, userId } = params;

	return db.transaction(async (tx) => {
		// Get authorization
		const auth = await tx.query.paymentAuthorization.findFirst({
			where: eq(paymentAuthorization.id, authorizationId),
		});

		if (!auth) {
			throw new Error("Authorization not found");
		}

		if (auth.userId !== userId) {
			throw new Error("Unauthorized: User ID mismatch");
		}

		if (auth.status !== "authorized" && auth.status !== "partially_captured") {
			throw new Error(`Cannot void authorization with status: ${auth.status}`);
		}

		// Get processor and void
		const processor = ProcessorFactory.getProcessor(auth.processor);
		await processor.void({
			transactionId: auth.gatewayTransactionId,
		});

		// Update authorization
		const [updatedAuth] = await tx
			.update(paymentAuthorization)
			.set({
				status: "voided",
				voidedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(eq(paymentAuthorization.id, authorizationId))
			.returning();

		return updatedAuth;
	});
}

/**
 * Immediate charge (sale) - authorize and capture in one step
 */
export async function chargePayment(params: {
	userId: string;
	amount: number;
	currency: string;
	paymentMethodNonce: string;
	productType: "ride_hailing" | "car_rental" | "delivery";
	sourceEntityType: string;
	sourceEntityId: string;
	description?: string;
	idempotencyKey: string;
	country?: string;
	processorType?: ProcessorType; // Optional override
}) {
	const {
		userId,
		amount,
		currency,
		paymentMethodNonce,
		productType,
		sourceEntityType,
		sourceEntityId,
		description,
		idempotencyKey,
		country,
		processorType,
	} = params;

	return db.transaction(async (tx) => {
		// Check idempotency
		const existingAuth = await tx.query.paymentAuthorization.findFirst({
			where: eq(paymentAuthorization.idempotencyKey, idempotencyKey),
		});

		if (existingAuth) {
			const existingTxn = await tx.query.transaction.findFirst({
				where: eq(transaction.platformRef, existingAuth.platformRef),
			});
			return { authorization: existingAuth, transaction: existingTxn };
		}

		// Select processor
		const selectedProcessor =
			processorType ||
			selectProcessor({
				country,
				currency,
			});

		const processor = ProcessorFactory.getProcessor(selectedProcessor);

		// Charge with processor
		const result = await processor.charge({
			amount,
			currency: normalizeCurrency(currency),
			paymentMethodToken: paymentMethodNonce,
			description,
			metadata: {
				productType,
				sourceEntityType,
				sourceEntityId,
			},
		});

		const platformRef = `CHG-${nanoid()}`;

		// Create authorization record (captured state)
		const [auth] = await tx
			.insert(paymentAuthorization)
			.values({
				gatewayTransactionId: result.processorTransactionId,
				gatewayAuthorizationId: result.processorAuthorizationId,
				paymentMethod: "credit_card",
				processor: selectedProcessor,
				userId,
				authorizedAmount: amount.toString(),
				capturedAmount: amount.toString(),
				remainingAmount: "0",
				currency: normalizeCurrency(currency),
				status: "captured",
				productType,
				sourceEntityType,
				sourceEntityId,
				platformRef,
				idempotencyKey,
				description: description || `Charge for ${sourceEntityType}`,
				capturedAt: new Date(),
				metadata: {
					processor: selectedProcessor,
					...result.metadata,
				},
			})
			.returning();

		// Create wallet transaction
		const account = await getOrCreateWalletAccountTx(tx, userId, currency);

		const grossAmount = amount.toString();
		const fee = "0";
		const netAmount = grossAmount;

		const [txn] = await tx
			.insert(transaction)
			.values({
				walletAccountId: account.id,
				type: "payment",
				direction: "credit",
				status: "completed",
				grossAmount,
				fee,
				netAmount,
				currency: normalizeCurrency(currency),
				productType,
				sourceEntityType,
				sourceEntityId,
				platformRef,
				description: description || `Payment for ${sourceEntityType}`,
				reference: `PAY-${nanoid()}`,
				settledAt: new Date(),
			})
			.returning();

		// Update wallet balance
		await tx
			.update(walletAccount)
			.set({
				balance: sql`${walletAccount.balance} + ${netAmount}`,
				availableBalance: sql`${walletAccount.availableBalance} + ${netAmount}`,
			})
			.where(eq(walletAccount.id, account.id));

		return { authorization: auth, transaction: txn };
	});
}

/**
 * Refund a completed payment (full or partial)
 */
export async function refundPayment(params: {
	authorizationId: string;
	amount?: number;
	reason?: string;
	userId: string;
	currency: string;
}) {
	const { authorizationId, amount, reason, userId, currency } = params;

	return db.transaction(async (tx) => {
		// Get authorization
		const auth = await tx.query.paymentAuthorization.findFirst({
			where: eq(paymentAuthorization.id, authorizationId),
		});

		if (!auth) {
			throw new Error("Authorization not found");
		}

		if (auth.userId !== userId) {
			throw new Error("Unauthorized: User ID mismatch");
		}

		if (auth.status !== "captured" && auth.status !== "settled") {
			throw new Error(
				`Cannot refund authorization with status: ${auth.status}`,
			);
		}

		const refundAmount = amount || Number.parseFloat(auth.capturedAmount);

		if (refundAmount > Number.parseFloat(auth.capturedAmount)) {
			throw new Error("Refund amount exceeds captured amount");
		}

		// Get processor and process refund
		const processor = ProcessorFactory.getProcessor(auth.processor);
		const result = await processor.refund({
			transactionId: auth.gatewayTransactionId,
			amount: refundAmount,
			reason,
		});

		const platformRef = `REF-${nanoid()}`;

		// Get original transaction
		const originalTxn = await tx.query.transaction.findFirst({
			where: eq(transaction.platformRef, auth.platformRef),
		});

		// Create refund record
		const [refundRecord] = await tx
			.insert(refund)
			.values({
				gatewayRefundId: result.processorRefundId,
				originalGatewayTransactionId: auth.gatewayTransactionId,
				originalTransactionId: originalTxn?.id,
				processor: auth.processor,
				refundAmount: refundAmount.toString(),
				currency: normalizeCurrency(currency),
				status: "completed",
				productType: auth.productType,
				sourceEntityType: auth.sourceEntityType,
				sourceEntityId: auth.sourceEntityId,
				platformRef,
				reason: reason || "Customer requested refund",
				description: `Refund for ${auth.platformRef}`,
				completedAt: new Date(),
			})
			.returning();

		// Create wallet transaction (debit from platform)
		const account = await getOrCreateWalletAccountTx(tx, userId, currency);

		const grossAmount = refundAmount.toString();
		const fee = "0";
		const netAmount = grossAmount;

		const [refundTxn] = await tx
			.insert(transaction)
			.values({
				walletAccountId: account.id,
				type: "refund",
				direction: "debit",
				status: "completed",
				grossAmount,
				fee,
				netAmount,
				currency: normalizeCurrency(currency),
				productType: auth.productType,
				sourceEntityType: auth.sourceEntityType,
				sourceEntityId: auth.sourceEntityId,
				platformRef,
				description: `Refund for ${auth.platformRef}`,
				reference: `REF-${nanoid()}`,
				settledAt: new Date(),
			})
			.returning();

		// Update refund record with transaction ID
		await tx
			.update(refund)
			.set({ refundTransactionId: refundTxn.id })
			.where(eq(refund.id, refundRecord.id));

		// Update wallet balance
		await tx
			.update(walletAccount)
			.set({
				balance: sql`${walletAccount.balance} - ${netAmount}`,
				availableBalance: sql`${walletAccount.availableBalance} - ${netAmount}`,
			})
			.where(eq(walletAccount.id, account.id));

		return { refund: refundRecord, transaction: refundTxn };
	});
}

/**
 * Get payment authorization details
 */
export async function getAuthorization(authorizationId: string) {
	const auth = await db.query.paymentAuthorization.findFirst({
		where: eq(paymentAuthorization.id, authorizationId),
	});

	if (!auth) {
		throw new Error("Authorization not found");
	}

	return auth;
}

/**
 * Get authorizations by source entity (e.g., booking ID)
 */
export async function getAuthorizationsBySourceEntity(sourceEntityId: string) {
	const authorizations = await db.query.paymentAuthorization.findMany({
		where: eq(paymentAuthorization.sourceEntityId, sourceEntityId),
	});

	return authorizations;
}
