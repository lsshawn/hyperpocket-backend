import { and, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import {
	transaction,
	transfer,
	wallet,
	walletAccount,
} from "../../db/schema.js";
import {
	ProcessorFactory,
	selectProcessor,
} from "../payment/processors/factory.js";
import type { ProcessorType } from "../payment/processors/base.js";

// Helpers
function normalizeCurrency(currency: string): string {
	return currency.trim().toUpperCase();
}

async function getOrCreateWalletTx(tx: any, userId: string) {
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
	return userWallet;
}

async function getOrCreateWalletAccountTx(
	tx: any,
	userId: string,
	currency: string,
) {
	const normalizedCurrency = normalizeCurrency(currency);
	const userWallet = await getOrCreateWalletTx(tx, userId);

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

export async function getWalletAccount(userId: string, currency: string) {
	const normalizedCurrency = normalizeCurrency(currency);
	return db.transaction(async (tx) => {
		const account = await getOrCreateWalletAccountTx(
			tx,
			userId,
			normalizedCurrency,
		);
		return account;
	});
}

export async function createWallet(userId: string) {
	return db.insert(wallet).values({ userId }).returning();
}

export async function createWalletAccount(walletId: string, currency: string) {
	const normalizedCurrency = normalizeCurrency(currency);
	return db
		.insert(walletAccount)
		.values({
			walletId: walletId,
			currency: normalizedCurrency,
			balance: "0",
			availableBalance: "0",
		})
		.onConflictDoNothing({
			target: [walletAccount.walletId, walletAccount.currency],
		})
		.returning();
}

export async function getDeposit(userId: string, currency: string) {
	const userWallet = await db.query.wallet.findFirst({
		where: eq(wallet.userId, userId),
	});

	if (!userWallet) {
		// For this example, we assume the user and wallet must exist.
		throw new Error("Wallet not found for user");
	}

	const account = await db.query.walletAccount.findFirst({
		where: and(
			eq(walletAccount.walletId, userWallet.id),
			eq(walletAccount.currency, normalizeCurrency(currency)),
		),
	});

	if (account) {
		const deposits = await db.query.transaction.findMany({
			where: and(
				eq(transaction.walletAccountId, account.id), // column first, value second
				eq(transaction.type, "deposit"),
			),
		});
		return deposits;
	}
	return [];
}

export async function getWithdrawal(userId: string, currency: string) {
	const userWallet = await db.query.wallet.findFirst({
		where: eq(wallet.userId, userId),
	});

	if (!userWallet) {
		// For this example, we assume the user and wallet must exist.
		throw new Error("Wallet not found for user");
	}

	const account = await db.query.walletAccount.findFirst({
		where: and(
			eq(walletAccount.walletId, userWallet.id),
			eq(walletAccount.currency, normalizeCurrency(currency)),
		),
	});

	if (account) {
		const withdrawal = await db.query.transaction.findMany({
			where: and(
				eq(transaction.walletAccountId, account.id), // column first, value second
				eq(transaction.type, "withdrawal"),
			),
		});
		return withdrawal;
	}
	return [];
}

export async function deposit(
	userId: string,
	amount: number,
	currency: string,
) {
	if (amount <= 0) {
		throw new Error("Deposit amount must be positive");
	}

	return db.transaction(async (tx) => {
		const account = await getOrCreateWalletAccountTx(tx, userId, currency);

		const grossAmount = amount.toString();
		const fee = "0"; // Assuming no fee for deposit
		const netAmount = grossAmount;

		// 1. Create a pending deposit transaction
		const [newTransaction] = await tx
			.insert(transaction)
			.values({
				walletAccountId: account.id,
				type: "deposit",
				status: "pending", // Funds are not available until settled
				direction: "credit",
				currency: normalizeCurrency(currency),
				grossAmount,
				fee,
				netAmount,
				description: `Deposit of ${grossAmount} ${currency}`,
				reference: `DEP-${nanoid()}`,
			})
			.returning();

		// 2. Update the ledger balance (but not the available balance)
		await tx
			.update(walletAccount)
			.set({
				balance: sql`${walletAccount.balance} + ${netAmount}`,
			})
			.where(eq(walletAccount.id, account.id));

		return newTransaction;
	});
}

/**
 * Deposit funds into wallet using payment processor
 * Supports credit card, bank transfer, and other payment methods
 */
export async function depositWithPayment(params: {
	userId: string;
	amount: number;
	currency: string;
	paymentMethod: "credit_card" | "bank_transfer" | "wallet";
	paymentMethodNonce?: string; // Required for credit_card
	idempotencyKey?: string;
	country?: string;
	processorType?: ProcessorType;
	productType?: string;
	sourceEntityType?: string;
	sourceEntityId?: string;
	description?: string;
}) {
	const {
		userId,
		amount,
		currency,
		paymentMethod,
		paymentMethodNonce,
		idempotencyKey,
		country,
		processorType,
		productType,
		sourceEntityType,
		sourceEntityId,
		description,
	} = params;

	if (amount <= 0) {
		throw new Error("Deposit amount must be positive");
	}

	// Check for duplicate using idempotency key
	if (idempotencyKey) {
		const existing = await db.query.transaction.findFirst({
			where: eq(transaction.reference, idempotencyKey),
		});
		if (existing) {
			return existing;
		}
	}

	const normalizedCurrency = normalizeCurrency(currency);
	let processorTransactionId: string | undefined;
	let selectedProcessor: ProcessorType | undefined;
	let fee = "0";

	// Handle external payment methods (credit card, bank transfer)
	if (paymentMethod === "credit_card" || paymentMethod === "bank_transfer") {
		if (!paymentMethodNonce) {
			throw new Error("Payment method nonce is required for external payments");
		}

		// Select processor based on country/currency or use override
		selectedProcessor =
			processorType || selectProcessor({ country, currency: normalizedCurrency });
		const processor = ProcessorFactory.getProcessor(selectedProcessor);

		// Charge immediately for wallet deposits
		const result = await processor.charge({
			amount,
			currency: normalizedCurrency,
			paymentMethodToken: paymentMethodNonce,
			description:
				description || `Wallet deposit: ${amount} ${normalizedCurrency}`,
			metadata: {
				userId,
				productType,
				sourceEntityType,
				sourceEntityId,
			},
		});

		processorTransactionId = result.processorTransactionId;

		// Calculate processor fee (simplified - in production, get from processor)
		// For now, assume 2.9% + $0.30 for credit cards
		if (paymentMethod === "credit_card") {
			const feeAmount = amount * 0.029 + 0.3;
			fee = Math.max(0, feeAmount).toFixed(4);
		}
	}

	// Create transaction and update wallet in atomic operation
	return db.transaction(async (tx) => {
		const account = await getOrCreateWalletAccountTx(
			tx,
			userId,
			normalizedCurrency,
		);

		const grossAmount = amount.toString();
		const netAmount = (amount - Number.parseFloat(fee)).toFixed(4);

		// Generate unique reference using idempotency key or new nanoid
		const reference = idempotencyKey || `DEP-${nanoid()}`;

		// Create deposit transaction
		const [newTransaction] = await tx
			.insert(transaction)
			.values({
				walletAccountId: account.id,
				type: "deposit",
				status: paymentMethod === "credit_card" ? "pending" : "pending", // All deposits start as pending
				direction: "credit",
				currency: normalizedCurrency,
				grossAmount,
				fee,
				netAmount,
				description:
					description ||
					`${paymentMethod === "credit_card" ? "Card" : paymentMethod === "bank_transfer" ? "Bank" : "Wallet"} deposit of ${grossAmount} ${normalizedCurrency}`,
				reference,
				processor: selectedProcessor,
				processorTransactionId,
				productType: productType as any,
				sourceEntityType,
				sourceEntityId,
				platformRef: `WDEP-${nanoid()}`, // Globally unique platform reference
			})
			.returning();

		// Update wallet balance (but not availableBalance - wait for settlement)
		await tx
			.update(walletAccount)
			.set({
				balance: sql`${walletAccount.balance} + ${netAmount}`,
			})
			.where(eq(walletAccount.id, account.id));

		return newTransaction;
	});
}

export async function withdraw(
	userId: string,
	amount: number,
	currency: string,
) {
	if (amount <= 0) {
		throw new Error("Withdrawal amount must be positive");
	}

	return db.transaction(async (tx) => {
		const account = await getOrCreateWalletAccountTx(tx, userId, currency);

		const grossAmount = amount.toString();
		const fee = "0"; // Assuming no withdrawal fee for now
		const netAmount = grossAmount;

		const updated = await tx
			.update(walletAccount)
			.set({
				balance: sql`${walletAccount.balance} - ${grossAmount}`,
				availableBalance: sql`${walletAccount.availableBalance} - ${grossAmount}`,
			})
			.where(
				and(
					eq(walletAccount.id, account.id),
					sql`${walletAccount.availableBalance} >= ${grossAmount}`,
				),
			)
			.returning();

		if (updated.length === 0) {
			throw new Error("Insufficient available balance");
		}

		const [newTransaction] = await tx
			.insert(transaction)
			.values({
				walletAccountId: account.id,
				type: "withdrawal",
				status: "completed", //
				direction: "debit",
				currency: normalizeCurrency(currency),
				grossAmount,
				fee,
				netAmount,
				description: `Withdrawal of ${grossAmount} ${normalizeCurrency(currency)}`,
				reference: `WDR-${nanoid()}`,
			})
			.returning();

		return newTransaction;
	});
}

export async function transferFunds(
	from: string,
	to: string,
	amount: number,
	currency: string,
) {
	if (amount <= 0) {
		throw new Error("Transfer amount must be positive");
	}
	if (from === to) {
		throw new Error("Cannot transfer to the same user");
	}

	return db.transaction(async (tx) => {
		const fromAccount = await getOrCreateWalletAccountTx(tx, from, currency);
		const toAccount = await getOrCreateWalletAccountTx(tx, to, currency);

		const grossAmount = amount.toString();
		const fee = "0"; // Assuming no withdrawal fee for now
		const netAmount = grossAmount;
		const normalizedCurrency = normalizeCurrency(currency);

		// Debit source account atomically if sufficient funds
		const debited = await tx
			.update(walletAccount)
			.set({
				availableBalance: sql`${walletAccount.availableBalance} - ${grossAmount}`,
				balance: sql`${walletAccount.balance} - ${grossAmount}`,
			})
			.where(
				and(
					eq(walletAccount.id, fromAccount.id),
					sql`${walletAccount.availableBalance} >= ${grossAmount}`,
				),
			)
			.returning();
		if (debited.length === 0) {
			throw new Error("Insufficient available balance");
		}

		// Credit destination account
		await tx
			.update(walletAccount)
			.set({
				availableBalance: sql`${walletAccount.availableBalance} + ${grossAmount}`,
				balance: sql`${walletAccount.balance} + ${grossAmount}`,
			})
			.where(eq(walletAccount.id, toAccount.id));

		const [newTransfer] = await tx
			.insert(transfer)
			.values({
				reference: `TRF-${nanoid()}`,
			})
			.returning();

		const [fromAccountTransaction] = await tx
			.insert(transaction)
			.values({
				walletAccountId: fromAccount.id,
				type: "transfer",
				status: "completed",
				direction: "debit",
				grossAmount,
				fee,
				netAmount,
				transferId: newTransfer.id,
				currency: normalizedCurrency,
				description: `Transfer of ${grossAmount} ${normalizedCurrency}`,
				reference: `TRF-${nanoid()}`,
			})
			.returning();

		const [toAccountTransaction] = await tx
			.insert(transaction)
			.values({
				walletAccountId: toAccount.id,
				type: "transfer",
				status: "completed",
				direction: "credit",
				grossAmount,
				fee,
				netAmount,
				transferId: newTransfer.id,
				currency: normalizedCurrency,
				description: `Transfer of ${grossAmount} ${normalizedCurrency}`,
				reference: `TRF-${nanoid()}`,
			})
			.returning();

		return { fromAccountTransaction, toAccountTransaction };
	});
}

// Dev only
export async function validateDeposit(transactionId: string) {
	return db.transaction(async (tx) => {
		const trx = await tx.query.transaction.findFirst({
			where: eq(transaction.id, transactionId),
		});
		if (!trx) throw new Error("Transaction not found");
		if (trx.type !== "deposit")
			throw new Error("Only deposits can be validated");
		if (trx.status !== "pending")
			throw new Error("Transaction already settled or invalid state");

		const [updatedTransaction] = await tx
			.update(transaction)
			.set({
				status: "completed",
				settledAt: new Date(),
			})
			.where(eq(transaction.id, transactionId))
			.returning();

		await tx
			.update(walletAccount)
			.set({
				availableBalance: sql`${walletAccount.availableBalance} + ${updatedTransaction.netAmount}`,
			})
			.where(eq(walletAccount.id, updatedTransaction.walletAccountId));

		return updatedTransaction;
	});
}
