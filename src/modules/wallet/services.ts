import { and, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import {
	transaction,
	transfer,
	wallet,
	walletAccount,
} from "../../db/schema.js";

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
