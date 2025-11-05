import { z } from "zod";

const envSchema = z.object({
	DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
	BRAINTREE_MERCHANT_ID: z.string().min(1, "BRAINTREE_MERCHANT_ID is required"),
	BRAINTREE_PUBLIC_KEY: z.string().min(1, "BRAINTREE_PUBLIC_KEY is required"),
	BRAINTREE_PRIVATE_KEY: z.string().min(1, "BRAINTREE_PRIVATE_KEY is required"),
	BRAINTREE_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),
	// Optional: Merchant accounts per currency
	BRAINTREE_MERCHANT_ACCOUNT_USD: z.string().optional(),
	BRAINTREE_MERCHANT_ACCOUNT_THB: z.string().optional(),
	BRAINTREE_MERCHANT_ACCOUNT_MYR: z.string().optional(),
	BRAINTREE_MERCHANT_ACCOUNT_SGD: z.string().optional(),
	BRAINTREE_MERCHANT_ACCOUNT_EUR: z.string().optional(),
	BRAINTREE_MERCHANT_ACCOUNT_GBP: z.string().optional(),
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
		// Merchant account mapping per currency
		// This allows different merchant accounts for different currencies
		merchantAccounts: {
			USD: env.BRAINTREE_MERCHANT_ACCOUNT_USD,
			THB: env.BRAINTREE_MERCHANT_ACCOUNT_THB,
			MYR: env.BRAINTREE_MERCHANT_ACCOUNT_MYR,
			SGD: env.BRAINTREE_MERCHANT_ACCOUNT_SGD,
			EUR: env.BRAINTREE_MERCHANT_ACCOUNT_EUR,
			GBP: env.BRAINTREE_MERCHANT_ACCOUNT_GBP,
		} as Record<string, string | undefined>,
	},
};
