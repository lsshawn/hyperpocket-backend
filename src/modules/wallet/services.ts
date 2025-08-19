import { and, eq, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../../db';
import { transaction, wallet, walletAccount } from '../../db/schema';

// This is a placeholder for an authenticated user's ID.
// In a real application, this would come from the user's session or token.
const HARDCODED_USER_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'; // A sample UUID

/**
 * Retrieves or creates a wallet account for a given user and currency.
 * @param userId - The ID of the user.
 * @param currency - The currency code (e.g., 'USD').
 * @returns The user's wallet account.
 * @throws If the user's main wallet is not found.
 */
async function getWalletAccount(userId: string, currency: string) {
	const userWallet = await db.query.wallet.findFirst({
		where: eq(wallet.userId, userId)
	});

	if (!userWallet) {
		// For this example, we assume the user and wallet must exist.
		throw new Error('Wallet not found for user');
	}

	let account = await db.query.walletAccount.findFirst({
		where: and(eq(walletAccount.walletId, userWallet.id), eq(walletAccount.currency, currency))
	});

	if (!account) {
		// If the user doesn't have an account for this currency, create one.
		[account] = await db
			.insert(walletAccount)
			.values({
				walletId: userWallet.id,
				currency: currency,
				balance: '0',
				availableBalance: '0'
			})
			.returning();
	}

	return account;
}

export async function deposit(amount: number) {
	const currency = 'USD';

	if (amount <= 0) {
		throw new Error('Deposit amount must be positive');
	}

	return db.transaction(async tx => {
		const account = await getWalletAccount(HARDCODED_USER_ID, currency);

		const grossAmount = amount.toString();
		const fee = '0'; // Assuming no fee for deposit
		const netAmount = grossAmount;

		// 1. Create a pending deposit transaction
		const [newTransaction] = await tx
			.insert(transaction)
			.values({
				walletAccountId: account.id,
				type: 'deposit',
				status: 'pending', // Funds are not available until settled
				grossAmount,
				fee,
				netAmount,
				description: `Deposit of ${grossAmount} ${currency}`,
				reference: `DEP-${nanoid()}`
			})
			.returning();

		// 2. Update the ledger balance (but not the available balance)
		await tx
			.update(walletAccount)
			.set({
				balance: sql`${walletAccount.balance} + ${netAmount}`
			})
			.where(eq(walletAccount.id, account.id));

		return newTransaction;
	});
}

export async function withdraw(amount: number) {
	const currency = 'USD';

	if (amount <= 0) {
		throw new Error('Withdrawal amount must be positive');
	}

	return db.transaction(async tx => {
		const account = await getWalletAccount(HARDCODED_USER_ID, currency);

		// Check for sufficient available balance
		if (Number(account.availableBalance) < amount) {
			throw new Error('Insufficient available balance');
		}

		const grossAmount = amount.toString();
		const fee = '0'; // Assuming no withdrawal fee for now
		const netAmount = grossAmount;

		// 1. Create a withdrawal transaction
		const [newTransaction] = await tx
			.insert(transaction)
			.values({
				walletAccountId: account.id,
				type: 'withdrawal',
				status: 'completed', // Withdrawals are typically immediate from available funds
				grossAmount,
				fee,
				netAmount,
				description: `Withdrawal of ${grossAmount} ${currency}`,
				reference: `WDR-${nanoid()}`
			})
			.returning();

		// 2. Decrement both ledger and available balances
		await tx
			.update(walletAccount)
			.set({
				balance: sql`${walletAccount.balance} - ${grossAmount}`,
				availableBalance: sql`${walletAccount.availableBalance} - ${grossAmount}`
			})
			.where(eq(walletAccount.id, account.id));

		return newTransaction;
	});
}
