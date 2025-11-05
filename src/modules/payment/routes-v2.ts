/**
 * Payment Routes (Multi-Processor Version)
 *
 * Routes that support multiple payment processors with automatic routing
 */

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { ApiResponse } from "../../types.js";
import {
	authorizePayment,
	capturePayment,
	chargePayment,
	createOrGetCustomer,
	generateClientToken,
	getAuthorization,
	getAuthorizationsBySourceEntity,
	refundPayment,
	voidAuthorization,
} from "./services-v2.js";

const paymentRoutes = new Hono();

// Validation schemas
const productTypeSchema = z.enum(["ride_hailing", "car_rental", "delivery"]);
const processorTypeSchema = z
	.enum(["braintree", "stripe", "adyen", "razorpay"])
	.optional();

const customerSchema = z.object({
	userId: z.string().uuid(),
	firstName: z.string().min(1),
	lastName: z.string().min(1),
	email: z.string().email(),
	phone: z.string().optional(),
	processorType: processorTypeSchema, // Optional: specify processor
});

const authorizeSchema = z.object({
	userId: z.string().uuid(),
	amount: z.number().positive("Amount must be positive"),
	currency: z
		.string()
		.length(3, "Currency must be 3 characters")
		.regex(/^[A-Z]{3}$/, "Currency must be uppercase"),
	paymentMethodNonce: z.string().min(1, "Payment method nonce is required"),
	productType: productTypeSchema,
	sourceEntityType: z.string().min(1, "Source entity type is required"),
	sourceEntityId: z.string().uuid("Source entity ID must be a valid UUID"),
	description: z.string().optional(),
	idempotencyKey: z.string().min(1, "Idempotency key is required"),
	// NEW: Processor routing fields
	country: z.string().length(2).optional(), // ISO country code (e.g., 'TH', 'US')
	processorType: processorTypeSchema, // Optional override
});

const chargeSchema = authorizeSchema; // Same validation as authorize

const captureSchema = z.object({
	authorizationId: z.string().uuid(),
	amount: z.number().positive().optional(), // Optional for partial capture
	userId: z.string().uuid(),
	currency: z
		.string()
		.length(3)
		.regex(/^[A-Z]{3}$/),
});

const voidSchema = z.object({
	authorizationId: z.string().uuid(),
	userId: z.string().uuid(),
});

const refundSchema = z.object({
	authorizationId: z.string().uuid(),
	amount: z.number().positive().optional(), // Optional for partial refund
	reason: z.string().optional(),
	userId: z.string().uuid(),
	currency: z
		.string()
		.length(3)
		.regex(/^[A-Z]{3}$/),
});

const sourceEntityQuerySchema = z.object({
	sourceEntityId: z.string().uuid(),
});

const clientTokenQuerySchema = z.object({
	customerId: z.string().optional(),
	processorType: processorTypeSchema,
});

/**
 * GET /payments/client-token
 * Generate client token for Drop-in UI
 */
paymentRoutes.get(
	"/client-token",
	zValidator("query", clientTokenQuerySchema),
	async (c) => {
		try {
			const { customerId, processorType } = c.req.valid("query");
			const clientToken = await generateClientToken(customerId, processorType);

			const response: ApiResponse = {
				data: { clientToken },
				message: "Client token generated successfully",
			};

			return c.json(response, 200);
		} catch (error: any) {
			return c.json(
				{ error: "Failed to generate client token", details: error.message },
				500,
			);
		}
	},
);

/**
 * POST /payments/customer
 * Create or get customer in processor's system
 */
paymentRoutes.post(
	"/customer",
	zValidator("json", customerSchema),
	async (c) => {
		try {
			const { userId, processorType, ...customerData } = c.req.valid("json");
			const customer = await createOrGetCustomer(
				userId,
				customerData,
				processorType,
			);

			const response: ApiResponse = {
				data: customer,
				message: "Customer retrieved successfully",
			};

			return c.json(response, 200);
		} catch (error: any) {
			return c.json(
				{ error: "Customer operation failed", details: error.message },
				500,
			);
		}
	},
);

/**
 * POST /payments/authorize
 * Authorize payment (hold funds without capturing)
 *
 * Processor selection (in order of priority):
 * 1. Explicit processorType parameter
 * 2. Automatic routing based on country/currency
 * 3. Default processor (Braintree)
 */
paymentRoutes.post(
	"/authorize",
	zValidator("json", authorizeSchema),
	async (c) => {
		try {
			const params = c.req.valid("json");
			const authorization = await authorizePayment(params);

			const response: ApiResponse = {
				data: authorization,
				message: "Payment authorized successfully. Funds are on hold.",
			};

			return c.json(response, 201);
		} catch (error: any) {
			if (error.message.includes("Idempotency")) {
				return c.json(
					{ error: "Authorization failed", details: error.message },
					409,
				);
			}
			return c.json(
				{ error: "Authorization failed", details: error.message },
				500,
			);
		}
	},
);

/**
 * POST /payments/charge
 * Immediate charge (authorize + capture in one step)
 */
paymentRoutes.post("/charge", zValidator("json", chargeSchema), async (c) => {
	try {
		const params = c.req.valid("json");
		const result = await chargePayment(params);

		const response: ApiResponse = {
			data: result,
			message: "Payment charged successfully",
		};

		return c.json(response, 201);
	} catch (error: any) {
		if (error.message.includes("Idempotency")) {
			return c.json({ error: "Charge failed", details: error.message }, 409);
		}
		return c.json({ error: "Charge failed", details: error.message }, 500);
	}
});

/**
 * POST /payments/capture
 * Capture previously authorized payment (full or partial)
 */
paymentRoutes.post("/capture", zValidator("json", captureSchema), async (c) => {
	try {
		const params = c.req.valid("json");
		const result = await capturePayment(params);

		const response: ApiResponse = {
			data: result,
			message: "Payment captured successfully",
		};

		return c.json(response, 200);
	} catch (error: any) {
		const knownErrors = [
			"Authorization not found",
			"Unauthorized: User ID mismatch",
			"Cannot capture authorization",
			"Capture amount exceeds",
		];

		if (knownErrors.some((errMsg) => error.message.includes(errMsg))) {
			return c.json({ error: "Capture failed", details: error.message }, 400);
		}

		return c.json({ error: "Capture failed", details: error.message }, 500);
	}
});

/**
 * POST /payments/void
 * Void/Release authorization without capturing
 */
paymentRoutes.post("/void", zValidator("json", voidSchema), async (c) => {
	try {
		const params = c.req.valid("json");
		const authorization = await voidAuthorization(params);

		const response: ApiResponse = {
			data: authorization,
			message: "Authorization voided successfully. Funds released.",
		};

		return c.json(response, 200);
	} catch (error: any) {
		const knownErrors = [
			"Authorization not found",
			"Unauthorized: User ID mismatch",
			"Cannot void authorization",
		];

		if (knownErrors.some((errMsg) => error.message.includes(errMsg))) {
			return c.json({ error: "Void failed", details: error.message }, 400);
		}

		return c.json({ error: "Void failed", details: error.message }, 500);
	}
});

/**
 * POST /payments/refund
 * Refund a completed payment (full or partial)
 */
paymentRoutes.post("/refund", zValidator("json", refundSchema), async (c) => {
	try {
		const params = c.req.valid("json");
		const result = await refundPayment(params);

		const response: ApiResponse = {
			data: result,
			message: "Payment refunded successfully",
		};

		return c.json(response, 200);
	} catch (error: any) {
		const knownErrors = [
			"Authorization not found",
			"Unauthorized: User ID mismatch",
			"Cannot refund authorization",
			"Refund amount exceeds",
		];

		if (knownErrors.some((errMsg) => error.message.includes(errMsg))) {
			return c.json({ error: "Refund failed", details: error.message }, 400);
		}

		return c.json({ error: "Refund failed", details: error.message }, 500);
	}
});

/**
 * GET /payments/:id
 * Get authorization details by ID
 */
paymentRoutes.get("/:id", async (c) => {
	try {
		const authorizationId = c.req.param("id");

		if (!authorizationId) {
			return c.json({ error: "Authorization ID is required" }, 400);
		}

		const authorization = await getAuthorization(authorizationId);

		const response: ApiResponse = {
			data: authorization,
			message: "Authorization retrieved successfully",
		};

		return c.json(response, 200);
	} catch (error: any) {
		if (error.message === "Authorization not found") {
			return c.json({ error: "Authorization not found" }, 404);
		}

		return c.json(
			{
				error: "Failed to retrieve authorization",
				details: error.message,
			},
			500,
		);
	}
});

/**
 * GET /payments/by-source
 * Get authorizations by source entity (e.g., booking ID)
 */
paymentRoutes.get(
	"/by-source",
	zValidator("query", sourceEntityQuerySchema),
	async (c) => {
		try {
			const { sourceEntityId } = c.req.valid("query");
			const authorizations =
				await getAuthorizationsBySourceEntity(sourceEntityId);

			const response: ApiResponse = {
				data: authorizations,
				message: "Authorizations retrieved successfully",
			};

			return c.json(response, 200);
		} catch (error: any) {
			return c.json(
				{
					error: "Failed to retrieve authorizations",
					details: error.message,
				},
				500,
			);
		}
	},
);

export default paymentRoutes;
