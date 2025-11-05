import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import adminRoutes from "./modules/admin/routes.js";
import kycRoutes from "./modules/kyc/routes.js";
import { ProcessorFactory } from "./modules/payment/processors/factory.js";
import paymentRoutes from "./modules/payment/routes.js";
import webhookRoutes from "./modules/payment/webhook.js";
import walletRoutes from "./modules/wallet/routes.js";

// Initialize payment processors
ProcessorFactory.initialize();

const app = new Hono();

app.use(
	"/*",
	cors({
		origin: [
			"http://localhost:3000",
			"http://localhost:5173",
			"https://hyperpocket.com",
			"https://aipaygo.com",
		],
		allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
		exposeHeaders: ["Content-Type", "Authorization"],
		credentials: true,
	}),
);

app.get("/health", (c) => {
	return c.json({ status: "ok" });
});

app.get("/", (c) => {
	return c.text("Hello Hono!");
});

app.route("/admin", adminRoutes);
app.route("/kyc", kycRoutes);
app.route("/wallets", walletRoutes);
app.route("/payments", paymentRoutes);
app.route("/webhooks", webhookRoutes);

serve(
	{
		fetch: app.fetch,
		port: 3000,
	},
	(info) => {
		console.log(`Server is running on http://localhost:${info.port}`);
	},
);
