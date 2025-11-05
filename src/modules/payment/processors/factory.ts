import { config } from "../../../config.js";
import { gateway } from "../braintree-client.js";
import type { PaymentProcessor, ProcessorType } from "./base.js";
import { BraintreeProcessor } from "./braintree-adapter.js";

/**
 * Payment Processor Factory
 *
 * Manages initialization and retrieval of payment processors.
 * Supports multiple processors (Braintree, Stripe, Adyen, etc.)
 */
export class ProcessorFactory {
	private static processors: Map<ProcessorType, PaymentProcessor> = new Map();
	private static initialized = false;

	/**
	 * Initialize all configured payment processors
	 * Should be called once at application startup
	 */
	static initialize() {
		if (ProcessorFactory.initialized) {
			return;
		}

		// Initialize Braintree (always available)
		const braintreeAdapter = new BraintreeProcessor(
			gateway,
			config.braintree.merchantAccounts,
		);
		ProcessorFactory.processors.set("braintree", braintreeAdapter);

		// Initialize Stripe if configured
		// if (config.stripe?.apiKey) {
		//   const stripeAdapter = new StripeProcessor(config.stripe.apiKey);
		//   this.processors.set('stripe', stripeAdapter);
		// }

		// Initialize Adyen if configured
		// if (config.adyen?.apiKey) {
		//   const adyenAdapter = new AdyenProcessor(config.adyen);
		//   this.processors.set('adyen', adyenAdapter);
		// }

		ProcessorFactory.initialized = true;
		console.log(
			`[ProcessorFactory] Initialized processors: ${Array.from(ProcessorFactory.processors.keys()).join(", ")}`,
		);
	}

	/**
	 * Get a specific payment processor by type
	 */
	static getProcessor(type: ProcessorType): PaymentProcessor {
		if (!ProcessorFactory.initialized) {
			ProcessorFactory.initialize();
		}

		const processor = ProcessorFactory.processors.get(type);
		if (!processor) {
			throw new Error(
				`Payment processor '${type}' is not configured or initialized`,
			);
		}

		return processor;
	}

	/**
	 * Check if a processor is available
	 */
	static isAvailable(type: ProcessorType): boolean {
		if (!ProcessorFactory.initialized) {
			ProcessorFactory.initialize();
		}
		return ProcessorFactory.processors.has(type);
	}

	/**
	 * Get all available processor types
	 */
	static getAvailableProcessors(): ProcessorType[] {
		if (!ProcessorFactory.initialized) {
			ProcessorFactory.initialize();
		}
		return Array.from(ProcessorFactory.processors.keys());
	}
}

/**
 * Routing Parameters for processor selection
 */
export interface RoutingParams {
	country?: string;
	currency?: string;
	paymentMethod?: string;
	amount?: number;
	userId?: string;
}

/**
 * Select the best payment processor based on business rules
 *
 * This function implements the routing logic to determine which
 * processor should handle a transaction based on various factors.
 *
 * @example
 * // Route by country
 * selectProcessor({ country: 'TH' }) // => 'braintree'
 *
 * // Route by currency
 * selectProcessor({ currency: 'EUR' }) // => 'stripe'
 *
 * // Route by payment method
 * selectProcessor({ paymentMethod: 'alipay' }) // => 'adyen'
 */
export function selectProcessor(params: RoutingParams): ProcessorType {
	const { country, currency, paymentMethod } = params;

	// Rule 1: Payment method specific routing
	if (paymentMethod) {
		// Braintree for PayPal and Venmo
		if (["paypal", "venmo"].includes(paymentMethod.toLowerCase())) {
			if (ProcessorFactory.isAvailable("braintree")) {
				return "braintree";
			}
		}

		// Adyen for local payment methods (Alipay, WeChat Pay, etc.)
		if (
			["alipay", "wechat_pay", "ideal", "sofort"].includes(
				paymentMethod.toLowerCase(),
			)
		) {
			if (ProcessorFactory.isAvailable("adyen")) {
				return "adyen";
			}
		}
	}

	// Rule 2: Geographic routing by country
	if (country) {
		const countryUpper = country.toUpperCase();

		// Southeast Asia → Braintree (better local payment methods)
		if (["TH", "MY", "SG", "ID", "VN", "PH"].includes(countryUpper)) {
			if (ProcessorFactory.isAvailable("braintree")) {
				return "braintree";
			}
		}

		// Europe → Stripe (better SEPA support)
		if (
			["GB", "FR", "DE", "IT", "ES", "NL", "BE", "CH", "AT", "PT"].includes(
				countryUpper,
			)
		) {
			if (ProcessorFactory.isAvailable("stripe")) {
				return "stripe";
			}
		}

		// India → Razorpay (local payment methods)
		if (countryUpper === "IN") {
			if (ProcessorFactory.isAvailable("razorpay")) {
				return "razorpay";
			}
		}

		// US, Canada, Australia → Stripe or Braintree
		if (["US", "CA", "AU", "NZ"].includes(countryUpper)) {
			if (ProcessorFactory.isAvailable("stripe")) {
				return "stripe";
			}
			if (ProcessorFactory.isAvailable("braintree")) {
				return "braintree";
			}
		}
	}

	// Rule 3: Currency-based routing
	if (currency) {
		const currencyUpper = currency.toUpperCase();

		// Southeast Asian currencies → Braintree
		if (["THB", "MYR", "SGD", "IDR", "VND", "PHP"].includes(currencyUpper)) {
			if (ProcessorFactory.isAvailable("braintree")) {
				return "braintree";
			}
		}

		// European currencies → Stripe
		if (["EUR", "GBP", "CHF", "SEK", "NOK", "DKK"].includes(currencyUpper)) {
			if (ProcessorFactory.isAvailable("stripe")) {
				return "stripe";
			}
		}

		// Indian Rupee → Razorpay
		if (currencyUpper === "INR") {
			if (ProcessorFactory.isAvailable("razorpay")) {
				return "razorpay";
			}
		}
	}

	// Rule 4: Default fallback
	// Prefer Braintree as default, then Stripe, then others
	const availableProcessors = ProcessorFactory.getAvailableProcessors();

	if (availableProcessors.includes("braintree")) {
		return "braintree";
	}

	if (availableProcessors.includes("stripe")) {
		return "stripe";
	}

	if (availableProcessors.length > 0) {
		return availableProcessors[0];
	}

	throw new Error("No payment processors are configured");
}

/**
 * Get processor routing information for debugging/logging
 */
export function getRoutingInfo(params: RoutingParams): {
	selectedProcessor: ProcessorType;
	reason: string;
	availableProcessors: ProcessorType[];
} {
	const selectedProcessor = selectProcessor(params);
	const availableProcessors = ProcessorFactory.getAvailableProcessors();

	let reason = "Default processor";

	if (params.paymentMethod) {
		reason = `Payment method: ${params.paymentMethod}`;
	} else if (params.country) {
		reason = `Country: ${params.country}`;
	} else if (params.currency) {
		reason = `Currency: ${params.currency}`;
	}

	return {
		selectedProcessor,
		reason,
		availableProcessors,
	};
}
