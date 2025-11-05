import braintree from "braintree";
import { config } from "../../config.js";

// Initialize Braintree gateway
const gateway = new braintree.BraintreeGateway({
	environment:
		config.braintree.environment === "production"
			? braintree.Environment.Production
			: braintree.Environment.Sandbox,
	merchantId: config.braintree.merchantId,
	publicKey: config.braintree.publicKey,
	privateKey: config.braintree.privateKey,
});

export { gateway };
