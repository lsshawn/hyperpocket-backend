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
import { gateway } from "./braintree-client.js";

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
 * Generate client token for Braintree Drop-in UI
 */
export async function generateClientToken(customerId?: string) {
	try {
		const response = await gateway.clientToken.generate(
			customerId ? { customerId } : {},
		);
		return response.clientToken;
	} catch (error: any) {
		throw new Error(`Failed to generate client token: ${error.message}`);
	}
}

/**
 * Create or get Braintree customer
 */
export async function createOrGetCustomer(userId: string, customerData: any) {
	try {
		// Try to find existing customer
		const customerId = `user_${userId}`;

		try {
			const customer = await gateway.customer.find(customerId);
			return customer;
		} catch (findError: any) {
			// Customer doesn't exist, create new one
			if (findError.type === "notFoundError") {
				const result = await gateway.customer.create({
					id: customerId,
					firstName: customerData.firstName,
					lastName: customerData.lastName,
					email: customerData.email,
					phone: customerData.phone,
				});

				if (!result.success) {
					throw new Error(`Failed to create customer: ${result.message}`);
				}

				return result.customer;
			}
			throw findError;
		}
	} catch (error: any) {
		throw new Error(`Customer operation failed: ${error.message}`);
	}
}

/**
 * Authorize payment (hold funds without capturing)
 * Use case: Ride-hailing - authorize when ride starts, capture when completed
 * Use case: Car rental - hold security deposit
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
	} = params;

	return db.transaction(async (tx) => {
		// Check idempotency
		const existing = await tx.query.paymentAuthorization.findFirst({
			where: eq(paymentAuthorization.idempotencyKey, idempotencyKey),
		});

		if (existing) {
			return existing;
		}

		// Authorize with Braintree
		const result = await gateway.transaction.sale({
			amount: amount.toString(),
			paymentMethodNonce,
			options: {
				submitForSettlement: false, // Authorization only
			},
		});

		if (!result.success) {
			throw new Error(`Braintree authorization failed: ${result.message}`);
		}

		const btTransaction = result.transaction;
		const platformRef = `PAY-${nanoid()}`;

		// Create authorization record
		const [auth] = await tx
			.insert(paymentAuthorization)
			.values({
				gatewayTransactionId: btTransaction.id,
				gatewayAuthorizationId: btTransaction.processorAuthorizationCode,
				paymentMethod: "credit_card",
				userId,
				authorizedAmount: amount.toString(),
				capturedAmount: "0",
				remainingAmount: amount.toString(),
				currency: normalizeCurrency(currency),
				status: "authorized",
				expiresAt: btTransaction.updatedAt
					? new Date(
							btTransaction.updatedAt.getTime() + 7 * 24 * 60 * 60 * 1000,
						)
					: null, // 7 days expiry
				productType,
				sourceEntityType,
				sourceEntityId,
				platformRef,
				idempotencyKey,
				description: description || `Authorization for ${sourceEntityType}`,
			})
			.returning();

		return auth;
	});
}

/**
 * Capture previously authorized payment (full or partial)
 * Use case: Ride-hailing - capture actual fare after ride completion
 * Use case: Car rental - capture damage amount from security deposit
 */
export async function capturePayment(params: {
	authorizationId: string;
	amount?: number; // Optional for partial capture
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

		// Submit for settlement with Braintree
		const result = await gateway.transaction.submitForSettlement(
			auth.gatewayTransactionId,
			captureAmount.toString(),
		);

		if (!result.success) {
			throw new Error(`Braintree capture failed: ${result.message}`);
		}

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
		const fee = "0"; // Platform fee can be calculated here
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
 * Use case: Car rental - release security deposit when booking is cancelled or completed without damage
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

		// Void with Braintree
		const result = await gateway.transaction.void(auth.gatewayTransactionId);

		if (!result.success) {
			throw new Error(`Braintree void failed: ${result.message}`);
		}

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
 * Use case: Car rental - charge rental fee upfront
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
	} = params;

	return db.transaction(async (tx) => {
		// Check idempotency
		const existingAuth = await tx.query.paymentAuthorization.findFirst({
			where: eq(paymentAuthorization.idempotencyKey, idempotencyKey),
		});

		if (existingAuth) {
			// Return existing transaction
			const existingTxn = await tx.query.transaction.findFirst({
				where: eq(transaction.platformRef, existingAuth.platformRef),
			});
			return { authorization: existingAuth, transaction: existingTxn };
		}

		// Charge with Braintree (authorize + capture)
		const result = await gateway.transaction.sale({
			amount: amount.toString(),
			paymentMethodNonce,
			options: {
				submitForSettlement: true, // Immediate capture
			},
		});

		if (!result.success) {
			throw new Error(`Braintree charge failed: ${result.message}`);
		}

		const btTransaction = result.transaction;
		const platformRef = `CHG-${nanoid()}`;

		// Create authorization record (captured state)
		const [auth] = await tx
			.insert(paymentAuthorization)
			.values({
				gatewayTransactionId: btTransaction.id,
				gatewayAuthorizationId: btTransaction.processorAuthorizationCode,
				paymentMethod: "credit_card",
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
 * Use case: Car rental - refund based on cancellation policy
 */
export async function refundPayment(params: {
	authorizationId: string;
	amount?: number; // Optional for partial refund
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

		// Process refund with Braintree
		const result = await gateway.transaction.refund(
			auth.gatewayTransactionId,
			refundAmount.toString(),
		);

		if (!result.success) {
			throw new Error(`Braintree refund failed: ${result.message}`);
		}

		const btRefund = result.transaction;
		const platformRef = `REF-${nanoid()}`;

		// Get original transaction
		const originalTxn = await tx.query.transaction.findFirst({
			where: eq(transaction.platformRef, auth.platformRef),
		});

		// Create refund record
		const [refundRecord] = await tx
			.insert(refund)
			.values({
				gatewayRefundId: btRefund.id,
				originalGatewayTransactionId: auth.gatewayTransactionId,
				originalTransactionId: originalTxn?.id,
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
