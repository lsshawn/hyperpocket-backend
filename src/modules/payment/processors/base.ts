/**
 * Base Payment Processor Interface
 *
 * This abstraction allows supporting multiple payment processors
 * (Braintree, Stripe, Adyen, etc.) with a unified interface.
 */

export type ProcessorType = "braintree" | "stripe" | "adyen" | "razorpay";

export interface PaymentProcessor {
	/** Processor identifier */
	readonly name: ProcessorType;

	/** Authorize payment (hold funds without capturing) */
	authorize(params: AuthorizeParams): Promise<AuthorizeResult>;

	/** Charge payment immediately (authorize + capture) */
	charge(params: ChargeParams): Promise<ChargeResult>;

	/** Capture previously authorized payment */
	capture(params: CaptureParams): Promise<CaptureResult>;

	/** Void/release authorization without capturing */
	void(params: VoidParams): Promise<VoidResult>;

	/** Refund a completed payment */
	refund(params: RefundParams): Promise<RefundResult>;

	/** Generate client token for Drop-in UI */
	generateClientToken(customerId?: string): Promise<string>;

	/** Create or get customer in processor's system */
	createCustomer(data: CustomerData): Promise<CustomerResult>;
}

// Request Parameters
export interface AuthorizeParams {
	amount: number;
	currency: string;
	paymentMethodToken: string;
	description?: string;
	metadata?: Record<string, any>;
	merchantAccountId?: string; // For multi-currency support
}

export interface ChargeParams extends AuthorizeParams {
	// Same as authorize but will be captured immediately
}

export interface CaptureParams {
	transactionId: string;
	amount?: number; // Optional for partial capture
	metadata?: Record<string, any>;
}

export interface VoidParams {
	transactionId: string;
	metadata?: Record<string, any>;
}

export interface RefundParams {
	transactionId: string;
	amount?: number; // Optional for partial refund
	reason?: string;
	metadata?: Record<string, any>;
}

export interface CustomerData {
	userId: string;
	firstName?: string;
	lastName?: string;
	email?: string;
	phone?: string;
	metadata?: Record<string, any>;
}

// Response Results
export interface AuthorizeResult {
	processorTransactionId: string;
	processorAuthorizationId?: string;
	status: "authorized" | "pending";
	expiresAt?: Date;
	metadata?: Record<string, any>;
}

export interface ChargeResult {
	processorTransactionId: string;
	processorAuthorizationId?: string;
	status: "captured" | "settling" | "settled";
	settledAt?: Date;
	metadata?: Record<string, any>;
}

export interface CaptureResult {
	processorTransactionId: string;
	status: "captured" | "settling" | "settled";
	capturedAmount: number;
	settledAt?: Date;
	metadata?: Record<string, any>;
}

export interface VoidResult {
	processorTransactionId: string;
	status: "voided";
	voidedAt: Date;
	metadata?: Record<string, any>;
}

export interface RefundResult {
	processorRefundId: string;
	processorTransactionId: string;
	status: "refunded" | "pending";
	refundedAmount: number;
	refundedAt?: Date;
	metadata?: Record<string, any>;
}

export interface CustomerResult {
	processorCustomerId: string;
	email?: string;
	metadata?: Record<string, any>;
}

/**
 * Base error class for processor-specific errors
 */
export class ProcessorError extends Error {
	constructor(
		message: string,
		public readonly processor: ProcessorType,
		public readonly code?: string,
		public readonly details?: any,
	) {
		super(message);
		this.name = "ProcessorError";
	}
}
