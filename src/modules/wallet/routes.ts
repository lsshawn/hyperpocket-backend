import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import type { ApiResponse } from '../../types.js';
import { deposit, withdraw, getWalletAccount, getDeposit, getWithdrawal, validateDeposit, transferFunds, createWallet, createWalletAccount } from './services.js';

const walletRoutes = new Hono();

const amountSchema = z.object({
  userId: z.uuidv4(),
  amount: z.number().positive('Amount must be a positive number'),
  currency: z.string().length(3, "Currency must be exactly 3 characters").regex(/^[A-Z]{3}$/, "Currency must be uppercase letters")
});

const walletAccountSchema = z.object({
  walletId: z.uuidv4(),
  currency: z.string().length(3, "Currency must be exactly 3 characters").regex(/^[A-Z]{3}$/, "Currency must be uppercase letters")
});

const transferSchema = z.object({
  from: z.uuidv4(),
  to: z.uuidv4(),
  amount: z.number().positive('Amount must be a positive number'),
  currency: z.string().length(3, "Currency must be exactly 3 characters").regex(/^[A-Z]{3}$/, "Currency must be uppercase letters")
});

// Query validators
const userCurrencyQuerySchema = z.object({
  userId: z.uuidv4(),
  currency: z
    .string()
    .length(3, 'Currency must be exactly 3 characters')
    .regex(/^[A-Z]{3}$/, 'Currency must be uppercase letters')
    .default('USD')
});

walletRoutes.post('/', zValidator('json', z.object({userId: z.string().uuidv4()})), async (c) => {
  try {
    const { userId } = c.req.valid('json');
    const newTransaction = await createWallet(userId);
    const response: ApiResponse = {
      data: newTransaction,
      message: 'Wallet created successfully',
    };
    return c.json(response, 201);
  } catch (error: any) {
    return c.json({ error: 'Create wallet failed', details: error.message }, 500);
  }
});

walletRoutes.post('/account', zValidator('json', walletAccountSchema), async (c) => {
  try {
    const { walletId, currency } = c.req.valid('json');
    const newWalletAccount = await createWalletAccount(walletId, currency);
    const response: ApiResponse = {
      data: newWalletAccount,
      message: 'Wallet Account created successfully',
    };
    return c.json(response, 201);
  } catch (error: any) {
    return c.json({ error: 'Create wallet account failed', details: error.message }, 500);
  }
});

walletRoutes.get('/', zValidator('query', userCurrencyQuerySchema), async (c) => {
  try {
    const { userId, currency } = c.req.valid('query');
    const account = await getWalletAccount(userId, currency);

    const response: ApiResponse = {
      data: account,
      message: 'Wallet account fetched successfully',
    };

    return c.json(response, 200);
  } catch (error: any) {
    return c.json({ error: 'Failed to fetch wallet', details: error.message }, 500);
  }
});

walletRoutes.get('/deposit', zValidator('query', userCurrencyQuerySchema), async (c) => {
  try {
    const { userId, currency } = c.req.valid('query');
    const deposits = await getDeposit(userId, currency);

    const response: ApiResponse = {
      data: deposits,
      message: 'Deposits fetched successfully',
    };

    return c.json(response, 200);
  } catch (error: any) {
    return c.json({ error: 'Failed to fetch deposits', details: error.message }, 500);
  }
});

walletRoutes.post('/deposit', zValidator('json', amountSchema), async (c) => {
  try {
    const { userId, amount, currency } = c.req.valid('json');
    const newTransaction = await deposit(userId, amount, currency);
    const response: ApiResponse = {
      data: newTransaction,
      message: 'Deposit initiated successfully. Funds will be available after settlement.',
    };
    return c.json(response, 201);
  } catch (error: any) {
    return c.json({ error: 'Deposit failed', details: error.message }, 500);
  }
});

walletRoutes.post('/withdraw', zValidator('json', amountSchema), async (c) => {
  try {
    const { userId, amount, currency } = c.req.valid('json');
    const newTransaction = await withdraw(userId, amount, currency);
    const response: ApiResponse = {
      data: newTransaction,
      message: 'Withdrawal successful.',
    };
    return c.json(response, 200);
  } catch (error: any) {
    if (error.message === 'Insufficient available balance') {
      return c.json({ error: 'Withdrawal failed', details: error.message }, 400);
    }
    return c.json({ error: 'Withdrawal failed', details: error.message }, 500);
  }
});

walletRoutes.get('/withdraw', zValidator('query', userCurrencyQuerySchema), async (c) => {
  try {
    const { userId, currency } = c.req.valid('query');
    const withdrawals = await getWithdrawal(userId, currency);

    const response: ApiResponse = {
      data: withdrawals,
      message: 'Withdrawal fetched successfully',
    };

    return c.json(response, 200);
  } catch (error: any) {
    return c.json({ error: 'Failed to fetch withdrawals', details: error.message }, 500);
  }
});

walletRoutes.post('/transfer', zValidator('json', transferSchema), async (c) => {
  try {
    const { from, to, amount, currency } = c.req.valid('json');
    const newTransaction = await transferFunds(from, to, amount, currency);
    const response: ApiResponse = {
      data: newTransaction,
      message: 'Transfer successful.',
    };
    return c.json(response, 200);
  } catch (error: any) {
    if (error.message === 'Insufficient available balance') {
      return c.json({ error: 'Transfer failed', details: error.message }, 400);
    }
    if (error.message === 'Cannot transfer to the same user') {
      return c.json({ error: 'Transfer failed', details: error.message }, 400);
    }
    return c.json({ error: 'Transfer failed', details: error.message }, 500);
  }
});

//dev only
walletRoutes.post('/deposit/validate', zValidator('json', z.object({transactionId: z.string().uuidv4()})), async (c) => {
  try {
    const { transactionId } = c.req.valid('json');
    const newTransaction = await validateDeposit(transactionId);
    const response: ApiResponse = {
      data: newTransaction,
      message: 'Validate successful.',
    };
    return c.json(response, 200);
  } catch (error: any) {
    const knownMessages = [
      'Transaction not found',
      'Only deposits can be validated',
      'Transaction already settled or invalid state',
    ];
    if (knownMessages.includes(error.message)) {
      return c.json({ error: 'Validate failed', details: error.message }, 400);
    }
    return c.json({ error: 'Validate failed', details: error.message }, 500);
  }
});

export default walletRoutes;
