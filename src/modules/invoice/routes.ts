import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { adminAuth } from "../../middleware/auth.js";
import type { ApiResponse } from "../../types.js";
import {
	cancelInvoice,
	createInvoice,
	getAllInvoices,
	getInvoiceById,
	getInvoicesByUser,
	markInvoiceAsPaid,
} from "./services.js";

const invoiceRoutes = new Hono();

// Apply admin authentication to all invoice routes
invoiceRoutes.use("/*", adminAuth);

// Validation schemas
const createInvoiceSchema = z.object({
	userId: z.string().uuid(),
	currency: z
		.string()
		.length(3)
		.regex(/^[A-Z]{3}$/),
	productType: z.enum(["ride_hailing", "car_rental", "delivery"]).optional(),
	periodStart: z.coerce.date(),
	periodEnd: z.coerce.date(),
	dueDate: z.coerce.date(),
	lineItems: z.array(
		z.object({
			description: z.string().min(1),
			quantity: z.number().positive(),
			unitPrice: z.number().positive(),
			sourceEntityType: z.string().optional(),
			sourceEntityId: z.string().uuid().optional(),
		}),
	),
	description: z.string().optional(),
	notes: z.string().optional(),
});

const getInvoicesQuerySchema = z.object({
	status: z
		.enum(["draft", "pending", "paid", "cancelled", "overdue"])
		.optional(),
	productType: z.enum(["ride_hailing", "car_rental", "delivery"]).optional(),
	startDate: z.coerce.date().optional(),
	endDate: z.coerce.date().optional(),
	page: z.coerce.number().int().positive().default(1),
	limit: z.coerce.number().int().positive().max(100).default(50),
});

const getUserInvoicesQuerySchema = z.object({
	userId: z.string().uuid(),
	status: z
		.enum(["draft", "pending", "paid", "cancelled", "overdue"])
		.optional(),
	page: z.coerce.number().int().positive().default(1),
	limit: z.coerce.number().int().positive().max(100).default(50),
});

const markAsPaidSchema = z.object({
	invoiceId: z.string().uuid(),
	debitFromWallet: z.boolean().default(true),
});

/**
 * POST /invoices
 * Create a new invoice
 */
invoiceRoutes.post(
	"/",
	zValidator("json", createInvoiceSchema),
	async (c) => {
		try {
			const params = c.req.valid("json");
			const newInvoice = await createInvoice(params);

			const response: ApiResponse = {
				data: newInvoice,
				message: "Invoice created successfully",
			};

			return c.json(response, 201);
		} catch (error: any) {
			return c.json(
				{
					error: "Failed to create invoice",
					details: error.message,
				},
				500,
			);
		}
	},
);

/**
 * GET /invoices
 * Get all invoices (admin)
 */
invoiceRoutes.get(
	"/",
	zValidator("query", getInvoicesQuerySchema),
	async (c) => {
		try {
			const params = c.req.valid("query");
			const result = await getAllInvoices(params);

			const response: ApiResponse = {
				data: result,
				message: "Invoices fetched successfully",
			};

			return c.json(response, 200);
		} catch (error: any) {
			return c.json(
				{
					error: "Failed to fetch invoices",
					details: error.message,
				},
				500,
			);
		}
	},
);

/**
 * GET /invoices/user
 * Get invoices for a specific user
 */
invoiceRoutes.get(
	"/user",
	zValidator("query", getUserInvoicesQuerySchema),
	async (c) => {
		try {
			const params = c.req.valid("query");
			const result = await getInvoicesByUser(params);

			const response: ApiResponse = {
				data: result,
				message: "User invoices fetched successfully",
			};

			return c.json(response, 200);
		} catch (error: any) {
			return c.json(
				{
					error: "Failed to fetch user invoices",
					details: error.message,
				},
				500,
			);
		}
	},
);

/**
 * GET /invoices/:id
 * Get invoice by ID
 */
invoiceRoutes.get("/:id", async (c) => {
	try {
		const invoiceId = c.req.param("id");
		const invoice = await getInvoiceById(invoiceId);

		const response: ApiResponse = {
			data: invoice,
			message: "Invoice fetched successfully",
		};

		return c.json(response, 200);
	} catch (error: any) {
		if (error.message === "Invoice not found") {
			return c.json(
				{
					error: "Invoice not found",
					details: error.message,
				},
				404,
			);
		}
		return c.json(
			{
				error: "Failed to fetch invoice",
				details: error.message,
			},
			500,
		);
	}
});

/**
 * POST /invoices/pay
 * Mark invoice as paid (and optionally debit user's wallet)
 */
invoiceRoutes.post(
	"/pay",
	zValidator("json", markAsPaidSchema),
	async (c) => {
		try {
			const params = c.req.valid("json");
			const updatedInvoice = await markInvoiceAsPaid(params);

			const response: ApiResponse = {
				data: updatedInvoice,
				message: "Invoice marked as paid successfully",
			};

			return c.json(response, 200);
		} catch (error: any) {
			if (
				error.message === "Invoice not found" ||
				error.message === "Invoice already paid"
			) {
				return c.json(
					{
						error: "Invalid invoice",
						details: error.message,
					},
					400,
				);
			}
			if (error.message === "Insufficient available balance to pay invoice") {
				return c.json(
					{
						error: "Payment failed",
						details: error.message,
					},
					400,
				);
			}
			return c.json(
				{
					error: "Failed to mark invoice as paid",
					details: error.message,
				},
				500,
			);
		}
	},
);

/**
 * POST /invoices/:id/cancel
 * Cancel an invoice
 */
invoiceRoutes.post("/:id/cancel", async (c) => {
	try {
		const invoiceId = c.req.param("id");
		const updatedInvoice = await cancelInvoice(invoiceId);

		const response: ApiResponse = {
			data: updatedInvoice,
			message: "Invoice cancelled successfully",
		};

		return c.json(response, 200);
	} catch (error: any) {
		if (error.message === "Invoice not found") {
			return c.json(
				{
					error: "Invoice not found",
					details: error.message,
				},
				404,
			);
		}
		return c.json(
			{
				error: "Failed to cancel invoice",
				details: error.message,
			},
			500,
		);
	}
});

export default invoiceRoutes;
