import { z } from "zod";

const envSchema = z.object({
	DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
	BRAINTREE_MERCHANT_ID: z.string().min(1, "BRAINTREE_MERCHANT_ID is required"),
	BRAINTREE_PUBLIC_KEY: z.string().min(1, "BRAINTREE_PUBLIC_KEY is required"),
	BRAINTREE_PRIVATE_KEY: z.string().min(1, "BRAINTREE_PRIVATE_KEY is required"),
	BRAINTREE_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),
});

function validateEnv() {
	try {
		return envSchema.parse(process.env);
	} catch (error) {
		throw error;
	}
}

export const env = validateEnv();

export const config = {
	apiSettings: {
		paginationLimit: 100,
	},
	braintree: {
		merchantId: env.BRAINTREE_MERCHANT_ID,
		publicKey: env.BRAINTREE_PUBLIC_KEY,
		privateKey: env.BRAINTREE_PRIVATE_KEY,
		environment: env.BRAINTREE_ENVIRONMENT,
	},
};
