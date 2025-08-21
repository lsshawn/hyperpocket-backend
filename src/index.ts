import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import kycRoutes from "./modules/kyc/routes.js";
import walletRoutes from "./modules/wallet/routes.js";

const app = new Hono();

app.use(
	"/*",
	cors({
		origin: ["*"],
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

app.route("/kyc", kycRoutes);
app.route("/wallets", walletRoutes);

serve(
	{
		fetch: app.fetch,
		port: 3000,
	},
	(info) => {
		console.log(`Server is running on http://localhost:${info.port}`);
	},
);
