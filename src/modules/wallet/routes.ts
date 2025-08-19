import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import type { ApiResponse } from '../../types';
import { deposit, withdraw } from './services';

const walletRoutes = new Hono();

const amountSchema = z.object({
	amount: z.number().positive('Amount must be a positive number')
});

walletRoutes.post('/deposit', zValidator('json', amountSchema), async c => {
	try {
		const { amount } = c.req.valid('json');
		const newTransaction = await deposit(amount);
		const response: ApiResponse = {
			data: newTransaction,
			message: 'Deposit initiated successfully. Funds will be available after settlement.'
		};
		return c.json(response, 201);
	} catch (error: any) {
		return c.json({ error: 'Deposit failed', details: error.message }, 500);
	}
});

walletRoutes.post('/withdraw', zValidator('json', amountSchema), async c => {
	try {
		const { amount } = c.req.valid('json');
		const newTransaction = await withdraw(amount);
		const response: ApiResponse = {
			data: newTransaction,
			message: 'Withdrawal successful.'
		};
		return c.json(response, 200);
	} catch (error: any) {
		if (error.message === 'Insufficient available balance') {
			return c.json({ error: 'Withdrawal failed', details: error.message }, 400);
		}
		return c.json({ error: 'Withdrawal failed', details: error.message }, 500);
	}
});

export default walletRoutes;
