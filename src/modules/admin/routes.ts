import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { ApiResponse } from "../../types.js";
import {
	getFeeSummary,
	getProcessorFeeBreakdown,
	getTransactionList,
} from "./services.js";

const adminRoutes = new Hono();

// TODO: Add authentication middleware
// adminRoutes.use('*', authMiddleware)

// Query schema for transaction list
const transactionListQuerySchema = z.object({
	page: z.coerce.number().int().positive().default(1),
	limit: z.coerce.number().int().positive().max(100).default(50),
	userId: z.string().uuid().optional(),
	type: z
		.enum(["deposit", "withdrawal", "transfer", "payment", "fee", "refund"])
		.optional(),
	currency: z
		.string()
		.length(3)
		.regex(/^[A-Z]{3}$/)
		.optional(),
	processor: z.enum(["braintree", "stripe", "adyen", "razorpay"]).optional(),
	startDate: z.coerce.date().optional(),
	endDate: z.coerce.date().optional(),
});

/**
 * GET /admin/transactions
 * List all transactions with filtering and pagination
 */
adminRoutes.get(
	"/transactions",
	zValidator("query", transactionListQuerySchema),
	async (c) => {
		try {
			const params = c.req.valid("query");
			const result = await getTransactionList(params);

			const response: ApiResponse = {
				data: result,
				message: "Transactions fetched successfully",
			};

			return c.json(response, 200);
		} catch (error: any) {
			return c.json(
				{
					error: "Failed to fetch transactions",
					details: error.message,
				},
				500,
			);
		}
	},
);

// Query schema for fee summary
const feeSummaryQuerySchema = z.object({
	currency: z
		.string()
		.length(3)
		.regex(/^[A-Z]{3}$/)
		.optional(),
	startDate: z.coerce.date().optional(),
	endDate: z.coerce.date().optional(),
	processor: z.enum(["braintree", "stripe", "adyen", "razorpay"]).optional(),
});

/**
 * GET /admin/fees/summary
 * Get fee totals and breakdown
 */
adminRoutes.get(
	"/fees/summary",
	zValidator("query", feeSummaryQuerySchema),
	async (c) => {
		try {
			const params = c.req.valid("query");
			const result = await getFeeSummary(params);

			const response: ApiResponse = {
				data: result,
				message: "Fee summary fetched successfully",
			};

			return c.json(response, 200);
		} catch (error: any) {
			return c.json(
				{
					error: "Failed to fetch fee summary",
					details: error.message,
				},
				500,
			);
		}
	},
);

// Query schema for processor breakdown
const processorBreakdownQuerySchema = z.object({
	startDate: z.coerce.date().optional(),
	endDate: z.coerce.date().optional(),
});

/**
 * GET /admin/fees/processor-breakdown
 * Get fee breakdown by payment processor
 * Shows total volume, fees paid, and average fee percentage per processor
 */
adminRoutes.get(
	"/fees/processor-breakdown",
	zValidator("query", processorBreakdownQuerySchema),
	async (c) => {
		try {
			const params = c.req.valid("query");
			const result = await getProcessorFeeBreakdown(params);

			const response: ApiResponse = {
				data: result,
				message: "Processor fee breakdown fetched successfully",
			};

			return c.json(response, 200);
		} catch (error: any) {
			return c.json(
				{
					error: "Failed to fetch processor breakdown",
					details: error.message,
				},
				500,
			);
		}
	},
);

export default adminRoutes;
