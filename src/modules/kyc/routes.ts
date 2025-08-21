import { Hono } from "hono";
// TODO: when services is ready
// import {  } from './services'
// import { authenticate } from '../auth/middleware'
import type { ApiResponse } from "../../types.js";

export const kycRoutes = new Hono<{ Variables: { userId: string } }>();

// TODO: when authenticate middleware is ready
// kyc.use('/*', authenticate())

// kyc.get("/", async (c) => {
// 	try {
// 		return c.json({ statuss: "GET kyc" });
// 	} catch (error) {
// 		console.error("Error retrieving kycs:", error);
// 		return c.json({ error: "Error retrieving kycs" }, 500);
// 	}
// });

export default kycRoutes;
