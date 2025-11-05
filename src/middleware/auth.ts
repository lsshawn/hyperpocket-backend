import type { Context, Next } from "hono";
import { config } from "../config.js";

/**
 * Authentication middleware for admin routes
 * Uses API key-based authentication for simplicity and security
 *
 * Usage:
 * - Add ADMIN_API_KEY to your .env file
 * - Include "Authorization: Bearer YOUR_API_KEY" header in requests
 */
export async function adminAuth(c: Context, next: Next) {
	const authHeader = c.req.header("Authorization");

	if (!authHeader) {
		return c.json(
			{
				error: "Unauthorized",
				message: "Missing Authorization header",
			},
			401,
		);
	}

	// Expected format: "Bearer YOUR_API_KEY"
	const [scheme, token] = authHeader.split(" ");

	if (scheme !== "Bearer" || !token) {
		return c.json(
			{
				error: "Unauthorized",
				message: "Invalid Authorization header format. Expected: Bearer YOUR_API_KEY",
			},
			401,
		);
	}

	// Validate API key
	const adminApiKey = config.adminApiKey;

	if (!adminApiKey) {
		console.error("ADMIN_API_KEY not configured in environment variables");
		return c.json(
			{
				error: "Internal Server Error",
				message: "Admin authentication not configured",
			},
			500,
		);
	}

	if (token !== adminApiKey) {
		return c.json(
			{
				error: "Unauthorized",
				message: "Invalid API key",
			},
			403,
		);
	}

	// Authentication successful, proceed to next middleware/handler
	await next();
}

/**
 * Optional authentication middleware
 * Allows public access but sets user context if authenticated
 */
export async function optionalAuth(c: Context, next: Next) {
	const authHeader = c.req.header("Authorization");

	if (authHeader) {
		const [scheme, token] = authHeader.split(" ");

		if (scheme === "Bearer" && token === config.adminApiKey) {
			// Set authenticated flag in context
			c.set("isAuthenticated", true);
			c.set("isAdmin", true);
		}
	}

	await next();
}
