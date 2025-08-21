import { and, eq, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../../db/index.js';
import { transaction, wallet, walletAccount, transfer } from '../../db/schema.js';

/**
 * Retrieves or creates a wallet account for a given user and currency.
 * @param userId - The ID of the user.
 * @param currency - The currency code (e.g., 'USD').
 * @returns The user's wallet account.
 * @throws If the user's main wallet is not found.
 */
export async function getWalletAccount(userId: string, currency: string) {
  let userWallet = await db.query.wallet.findFirst({
    where: eq(wallet.userId, userId),
  });

  if (!userWallet) {
    // For this example, we assume the user and wallet must exist.
    // throw new Error('Wallet not found for user');
    // Just create wallet if not exist
    await createWallet(userId)
    userWallet = await db.query.wallet.findFirst({
      where: eq(wallet.userId, userId),
    });
  }

  let account = await db.query.walletAccount.findFirst({
    where: and(eq(walletAccount.walletId, userWallet!.id), eq(walletAccount.currency, currency)),
  });

  if (!account) {
    // If the user doesn't have an account for this currency, create one.
    [account] = await db
      .insert(walletAccount)
      .values({
        walletId: userWallet!.id,
        currency: currency,
        balance: '0',
        availableBalance: '0',
      })
      .returning();
  }

  return account;
}

export async function createWallet(userId: string){
  return db.insert(wallet).values({userId}).returning();
}

export async function createWalletAccount(walletId: string, currency: string){
  return db
      .insert(walletAccount)
      .values({
        walletId: walletId,
        currency: currency,
        balance: '0',
        availableBalance: '0',
      }).returning();
}

export async function getDeposit(userId: string, currency: string) {
  const userWallet = await db.query.wallet.findFirst({
    where: eq(wallet.userId, userId),
  });

  if (!userWallet) {
    // For this example, we assume the user and wallet must exist.
    throw new Error('Wallet not found for user');
  }

  let account = await db.query.walletAccount.findFirst({
    where: and(eq(walletAccount.walletId, userWallet.id), eq(walletAccount.currency, currency)),
  });

  if (account) {
    let deposits = await db.query.transaction.findMany({
      where: and(
        eq(transaction.walletAccountId, account.id), // column first, value second
        eq(transaction.type, 'deposit')
      ),
    });
    return deposits;
  }
}

export async function getWithdrawal(userId: string, currency: string) {
  const userWallet = await db.query.wallet.findFirst({
    where: eq(wallet.userId, userId),
  });

  if (!userWallet) {
    // For this example, we assume the user and wallet must exist.
    throw new Error('Wallet not found for user');
  }

  let account = await db.query.walletAccount.findFirst({
    where: and(eq(walletAccount.walletId, userWallet.id), eq(walletAccount.currency, currency)),
  });

  if (account) {
    let withdrawal = await db.query.transaction.findMany({
      where: and(
        eq(transaction.walletAccountId, account.id), // column first, value second
        eq(transaction.type, 'withdrawal')
      ),
    });
    return withdrawal;
  }
}

export async function deposit(userId: string, amount: number, currency: string) {
  if (amount <= 0) {
    throw new Error('Deposit amount must be positive');
  }

  return db.transaction(async (tx) => {
    const account = await getWalletAccount(userId, currency);

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
        direction: 'credit',
        currency: currency,
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

export async function withdraw(userId: string, amount: number, currency: string) {
  if (amount <= 0) {
    throw new Error('Withdrawal amount must be positive');
  }

  return db.transaction(async (tx) => {
    const account = await getWalletAccount(userId, currency);

    // Check for sufficient available balance
    if (Number(account.availableBalance) < amount) {
      throw new Error('Insufficient available balance');
    }

    const grossAmount = amount.toString();
    const fee = '0'; // Assuming no withdrawal fee for now
    const netAmount = grossAmount;

    const [newTransaction] = await tx
      .insert(transaction)
      .values({
        walletAccountId: account.id,
        type: 'withdrawal',
        status: 'completed', //
        direction: 'debit',
        currency: currency,
        grossAmount,
        fee,
        netAmount,
        description: `Withdrawal of ${grossAmount} ${currency}`,
        reference: `WDR-${nanoid()}`,
      })
      .returning();

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

export async function transferFunds(from: string, to: string, amount: number, currency: string) {
  if (amount <= 0) {
    throw new Error('Transfer amount must be positive');
  }

  return db.transaction(async (tx) => {
    const fromAccount = await getWalletAccount(from, currency);
    const toAccount = await getWalletAccount(to, currency);
    
    // Check for sufficient available balance
    if (Number(fromAccount.availableBalance) < amount) {
      throw new Error('Insufficient available balance');
    }

    const grossAmount = amount.toString();
    const fee = '0'; // Assuming no withdrawal fee for now
    const netAmount = grossAmount;

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
        type: 'transfer',
        status: 'completed', 
        direction: 'debit',
        grossAmount,
        fee,
        netAmount,
        transferId: newTransfer.id,
        description: `Transfer of ${grossAmount} ${currency}`,
        reference: `TRF-${nanoid()}`,
      })
      .returning();

    const [toAccountTransaction] = await tx
      .insert(transaction)
      .values({
        walletAccountId: toAccount.id,
        type: 'transfer',
        status: 'completed', 
        direction: 'credit',
        grossAmount,
        fee,
        netAmount,
        transferId: newTransfer.id,
        description: `Transfer of ${grossAmount} ${currency}`,
        reference: `TRF-${nanoid()}`,
      })
      .returning();

    await tx
      .update(walletAccount)
      .set({
        availableBalance: sql`${walletAccount.availableBalance} - ${grossAmount}`,
        balance: sql`${walletAccount.balance} - ${grossAmount}`,
      })
      .where(eq(walletAccount.id, fromAccount.id));

    await tx
      .update(walletAccount)
      .set({
        availableBalance: sql`${walletAccount.availableBalance} + ${grossAmount}`,
        balance: sql`${walletAccount.balance} + ${grossAmount}`,
      })
      .where(eq(walletAccount.id, toAccount.id));

    return {fromAccountTransaction, toAccountTransaction}
  });
}

// Dev only
export async function validateDeposit(transactionId: string) {
  return db.transaction(async (tx) => {
    const [newTransaction] = await tx.update(transaction).set({
      status: "completed",
      settledAt: new Date()
    }).where(eq(transaction.id, transactionId)).returning()

    await tx.update(walletAccount).set({
      availableBalance: sql`${walletAccount.availableBalance} + ${newTransaction.netAmount}`,
    })

    return newTransaction
  })
}
