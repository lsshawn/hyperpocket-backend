import type { BraintreeGateway } from "braintree";
import type {
	AuthorizeParams,
	AuthorizeResult,
	CaptureParams,
	CaptureResult,
	ChargeParams,
	ChargeResult,
	CustomerData,
	CustomerResult,
	PaymentProcessor,
	RefundParams,
	RefundResult,
	VoidParams,
	VoidResult,
} from "./base.js";
import { ProcessorError } from "./base.js";

/**
 * Braintree Payment Processor Adapter
 *
 * Implements the PaymentProcessor interface for Braintree gateway.
 * Handles all Braintree-specific API calls and error handling.
 */
export class BraintreeProcessor implements PaymentProcessor {
	readonly name = "braintree" as const;

	constructor(
		private readonly gateway: BraintreeGateway,
		private readonly merchantAccounts?: Record<string, string>,
	) {}

	async authorize(params: AuthorizeParams): Promise<AuthorizeResult> {
		try {
			const result = await this.gateway.transaction.sale({
				amount: params.amount.toString(),
				paymentMethodNonce: params.paymentMethodToken,
				currencyIsoCode: params.currency.toUpperCase(),
				merchantAccountId:
					params.merchantAccountId ||
					this.merchantAccounts?.[params.currency.toUpperCase()],
				options: {
					submitForSettlement: false, // Authorization only
				},
				customFields: params.metadata as any,
			});

			if (!result.success) {
				throw new ProcessorError(
					result.message || "Authorization failed",
					"braintree",
					result.transaction?.processorResponseCode,
					result,
				);
			}

			const transaction = result.transaction;

			return {
				processorTransactionId: transaction.id,
				processorAuthorizationId:
					transaction.processorAuthorizationCode || undefined,
				status: "authorized",
				expiresAt: transaction.updatedAt
					? new Date(transaction.updatedAt.getTime() + 7 * 24 * 60 * 60 * 1000)
					: undefined, // 7 days expiry
				metadata: {
					processorResponseCode: transaction.processorResponseCode,
					processorResponseText: transaction.processorResponseText,
					status: transaction.status,
				},
			};
		} catch (error) {
			if (error instanceof ProcessorError) {
				throw error;
			}
			throw new ProcessorError(
				`Braintree authorization failed: ${(error as Error).message}`,
				"braintree",
				undefined,
				error,
			);
		}
	}

	async charge(params: ChargeParams): Promise<ChargeResult> {
		try {
			const result = await this.gateway.transaction.sale({
				amount: params.amount.toString(),
				paymentMethodNonce: params.paymentMethodToken,
				currencyIsoCode: params.currency.toUpperCase(),
				merchantAccountId:
					params.merchantAccountId ||
					this.merchantAccounts?.[params.currency.toUpperCase()],
				options: {
					submitForSettlement: true, // Immediate capture
				},
				customFields: params.metadata as any,
			});

			if (!result.success) {
				throw new ProcessorError(
					result.message || "Charge failed",
					"braintree",
					result.transaction?.processorResponseCode,
					result,
				);
			}

			const transaction = result.transaction;

			return {
				processorTransactionId: transaction.id,
				processorAuthorizationId:
					transaction.processorAuthorizationCode || undefined,
				status: "captured",
				settledAt: transaction.disbursementDetails?.disbursementDate
					? new Date(transaction.disbursementDetails.disbursementDate)
					: undefined,
				metadata: {
					processorResponseCode: transaction.processorResponseCode,
					processorResponseText: transaction.processorResponseText,
					status: transaction.status,
				},
			};
		} catch (error) {
			if (error instanceof ProcessorError) {
				throw error;
			}
			throw new ProcessorError(
				`Braintree charge failed: ${(error as Error).message}`,
				"braintree",
				undefined,
				error,
			);
		}
	}

	async capture(params: CaptureParams): Promise<CaptureResult> {
		try {
			const amount = params.amount?.toString();

			const result = await this.gateway.transaction.submitForSettlement(
				params.transactionId,
				amount,
			);

			if (!result.success) {
				throw new ProcessorError(
					result.message || "Capture failed",
					"braintree",
					result.transaction?.processorResponseCode,
					result,
				);
			}

			const transaction = result.transaction;
			const capturedAmount = Number.parseFloat(transaction.amount);

			return {
				processorTransactionId: transaction.id,
				status: "captured",
				capturedAmount,
				settledAt: transaction.disbursementDetails?.disbursementDate
					? new Date(transaction.disbursementDetails.disbursementDate)
					: undefined,
				metadata: {
					processorResponseCode: transaction.processorResponseCode,
					processorResponseText: transaction.processorResponseText,
					status: transaction.status,
				},
			};
		} catch (error) {
			if (error instanceof ProcessorError) {
				throw error;
			}
			throw new ProcessorError(
				`Braintree capture failed: ${(error as Error).message}`,
				"braintree",
				undefined,
				error,
			);
		}
	}

	async void(params: VoidParams): Promise<VoidResult> {
		try {
			const result = await this.gateway.transaction.void(params.transactionId);

			if (!result.success) {
				throw new ProcessorError(
					result.message || "Void failed",
					"braintree",
					result.transaction?.processorResponseCode,
					result,
				);
			}

			return {
				processorTransactionId: result.transaction.id,
				status: "voided",
				voidedAt: new Date(),
				metadata: {
					status: result.transaction.status,
				},
			};
		} catch (error) {
			if (error instanceof ProcessorError) {
				throw error;
			}
			throw new ProcessorError(
				`Braintree void failed: ${(error as Error).message}`,
				"braintree",
				undefined,
				error,
			);
		}
	}

	async refund(params: RefundParams): Promise<RefundResult> {
		try {
			const amount = params.amount?.toString();

			const result = await this.gateway.transaction.refund(
				params.transactionId,
				amount,
			);

			if (!result.success) {
				throw new ProcessorError(
					result.message || "Refund failed",
					"braintree",
					result.transaction?.processorResponseCode,
					result,
				);
			}

			const transaction = result.transaction;
			const refundedAmount = Number.parseFloat(transaction.amount);

			return {
				processorRefundId: transaction.id,
				processorTransactionId: params.transactionId,
				status: "refunded",
				refundedAmount,
				refundedAt: new Date(),
				metadata: {
					processorResponseCode: transaction.processorResponseCode,
					processorResponseText: transaction.processorResponseText,
					status: transaction.status,
				},
			};
		} catch (error) {
			if (error instanceof ProcessorError) {
				throw error;
			}
			throw new ProcessorError(
				`Braintree refund failed: ${(error as Error).message}`,
				"braintree",
				undefined,
				error,
			);
		}
	}

	async generateClientToken(customerId?: string): Promise<string> {
		try {
			const response = await this.gateway.clientToken.generate(
				customerId ? { customerId } : {},
			);
			return response.clientToken;
		} catch (error) {
			throw new ProcessorError(
				`Failed to generate client token: ${(error as Error).message}`,
				"braintree",
				undefined,
				error,
			);
		}
	}

	async createCustomer(data: CustomerData): Promise<CustomerResult> {
		try {
			const customerId = `user_${data.userId}`;

			// Try to find existing customer
			try {
				const customer = await this.gateway.customer.find(customerId);
				return {
					processorCustomerId: customer.id,
					email: customer.email,
					metadata: {
						firstName: customer.firstName,
						lastName: customer.lastName,
						phone: customer.phone,
					},
				};
			} catch (findError: any) {
				// Customer doesn't exist, create new one
				if (findError.type === "notFoundError") {
					const result = await this.gateway.customer.create({
						id: customerId,
						firstName: data.firstName,
						lastName: data.lastName,
						email: data.email,
						phone: data.phone,
					});

					if (!result.success) {
						throw new ProcessorError(
							`Failed to create customer: ${result.message}`,
							"braintree",
							undefined,
							result,
						);
					}

					return {
						processorCustomerId: result.customer.id,
						email: result.customer.email,
						metadata: {
							firstName: result.customer.firstName,
							lastName: result.customer.lastName,
							phone: result.customer.phone,
						},
					};
				}
				throw findError;
			}
		} catch (error) {
			if (error instanceof ProcessorError) {
				throw error;
			}
			throw new ProcessorError(
				`Customer operation failed: ${(error as Error).message}`,
				"braintree",
				undefined,
				error,
			);
		}
	}
}
