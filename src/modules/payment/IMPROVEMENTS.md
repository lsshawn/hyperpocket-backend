# Payment Module Improvements

## Issues Found

### 1. Multi-Currency Support (Partial)
- ✅ Schema supports multiple currencies
- ❌ Currency NOT passed to Braintree API calls
- ❌ No merchant account mapping for different currencies

### 2. Multiple Payment Processors (Not Supported)
- ❌ Everything hardcoded to Braintree
- ❌ No abstraction for other processors (Stripe, Adyen, etc.)
- ❌ No processor routing logic

---

## Required Changes for Multi-Currency

### 1. Update Braintree API Calls

**File: `src/modules/payment/services.ts`**

```typescript
// CURRENT (Wrong - defaults to merchant's base currency)
const result = await gateway.transaction.sale({
  amount: amount.toString(),
  paymentMethodNonce,
  options: {
    submitForSettlement: false,
  },
});

// CORRECT (Pass currency explicitly)
const result = await gateway.transaction.sale({
  amount: amount.toString(),
  paymentMethodNonce,
  currencyIsoCode: normalizeCurrency(currency), // ADD THIS
  options: {
    submitForSettlement: false,
  },
});
```

Apply this fix to:
- `authorizePayment()` - Line 154
- `chargePayment()` - Line 400

### 2. Add Merchant Account Mapping

Braintree requires different merchant accounts for different currencies.

**File: `src/config.ts`**

```typescript
export const config = {
  apiSettings: {
    paginationLimit: 100,
  },
  braintree: {
    merchantId: env.BRAINTREE_MERCHANT_ID,
    publicKey: env.BRAINTREE_PUBLIC_KEY,
    privateKey: env.BRAINTREE_PRIVATE_KEY,
    environment: env.BRAINTREE_ENVIRONMENT,
    // ADD: Merchant account mapping per currency
    merchantAccounts: {
      USD: env.BRAINTREE_MERCHANT_ACCOUNT_USD || 'default',
      THB: env.BRAINTREE_MERCHANT_ACCOUNT_THB,
      MYR: env.BRAINTREE_MERCHANT_ACCOUNT_MYR,
      SGD: env.BRAINTREE_MERCHANT_ACCOUNT_SGD,
      EUR: env.BRAINTREE_MERCHANT_ACCOUNT_EUR,
      GBP: env.BRAINTREE_MERCHANT_ACCOUNT_GBP,
    }
  },
};
```

**File: `.env.example`**

```bash
# Braintree Merchant Accounts (per currency)
BRAINTREE_MERCHANT_ACCOUNT_USD=your_usd_account
BRAINTREE_MERCHANT_ACCOUNT_THB=your_thb_account
BRAINTREE_MERCHANT_ACCOUNT_MYR=your_myr_account
```

**File: `src/modules/payment/services.ts`**

```typescript
import { config } from "../../config.js";

// Add helper function
function getMerchantAccountId(currency: string): string | undefined {
  const normalized = normalizeCurrency(currency);
  return config.braintree.merchantAccounts[normalized];
}

// Update API calls
const result = await gateway.transaction.sale({
  amount: amount.toString(),
  paymentMethodNonce,
  currencyIsoCode: normalizeCurrency(currency),
  merchantAccountId: getMerchantAccountId(currency), // ADD THIS
  options: {
    submitForSettlement: false,
  },
});
```

---

## Architecture for Multiple Payment Processors

To support multiple processors (Braintree, Stripe, Adyen, etc.), we need:

### 1. Processor Abstraction Layer

**File: `src/modules/payment/processors/base.ts`**

```typescript
export interface PaymentProcessor {
  name: string;

  authorize(params: AuthorizeParams): Promise<AuthorizeResult>;
  capture(params: CaptureParams): Promise<CaptureResult>;
  void(params: VoidParams): Promise<VoidResult>;
  refund(params: RefundParams): Promise<RefundResult>;
  charge(params: ChargeParams): Promise<ChargeResult>;

  generateClientToken(customerId?: string): Promise<string>;
  createCustomer(data: CustomerData): Promise<any>;
}

export interface AuthorizeParams {
  amount: number;
  currency: string;
  paymentMethodToken: string;
  metadata?: Record<string, any>;
}

export interface AuthorizeResult {
  processorTransactionId: string;
  processorAuthorizationId?: string;
  status: string;
  expiresAt?: Date;
}

// ... other interfaces
```

### 2. Braintree Adapter

**File: `src/modules/payment/processors/braintree.ts`**

```typescript
import { PaymentProcessor, AuthorizeParams, AuthorizeResult } from './base.js';
import { gateway } from '../braintree-client.js';
import { config } from '../../../config.js';

export class BraintreeProcessor implements PaymentProcessor {
  name = 'braintree';

  async authorize(params: AuthorizeParams): Promise<AuthorizeResult> {
    const merchantAccountId = config.braintree.merchantAccounts[params.currency];

    const result = await gateway.transaction.sale({
      amount: params.amount.toString(),
      paymentMethodNonce: params.paymentMethodToken,
      currencyIsoCode: params.currency,
      merchantAccountId,
      options: {
        submitForSettlement: false,
      },
    });

    if (!result.success) {
      throw new Error(`Braintree authorization failed: ${result.message}`);
    }

    return {
      processorTransactionId: result.transaction.id,
      processorAuthorizationId: result.transaction.processorAuthorizationCode,
      status: 'authorized',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    };
  }

  async charge(params: AuthorizeParams): Promise<AuthorizeResult> {
    // Similar implementation with submitForSettlement: true
  }

  async capture(params: CaptureParams): Promise<CaptureResult> {
    // Existing submitForSettlement logic
  }

  async void(params: VoidParams): Promise<VoidResult> {
    // Existing void logic
  }

  async refund(params: RefundParams): Promise<RefundResult> {
    // Existing refund logic
  }

  async generateClientToken(customerId?: string): Promise<string> {
    const response = await gateway.clientToken.generate(
      customerId ? { customerId } : {}
    );
    return response.clientToken;
  }

  async createCustomer(data: any): Promise<any> {
    // Existing customer logic
  }
}
```

### 3. Stripe Adapter (Example)

**File: `src/modules/payment/processors/stripe.ts`**

```typescript
import Stripe from 'stripe';
import { PaymentProcessor, AuthorizeParams, AuthorizeResult } from './base.js';

export class StripeProcessor implements PaymentProcessor {
  name = 'stripe';
  private stripe: Stripe;

  constructor(apiKey: string) {
    this.stripe = new Stripe(apiKey, { apiVersion: '2023-10-16' });
  }

  async authorize(params: AuthorizeParams): Promise<AuthorizeResult> {
    const paymentIntent = await this.stripe.paymentIntents.create({
      amount: Math.round(params.amount * 100), // Stripe uses cents
      currency: params.currency.toLowerCase(),
      payment_method: params.paymentMethodToken,
      capture_method: 'manual', // Authorization only
      confirm: true,
    });

    return {
      processorTransactionId: paymentIntent.id,
      processorAuthorizationId: paymentIntent.charges.data[0]?.id,
      status: 'authorized',
    };
  }

  async charge(params: AuthorizeParams): Promise<AuthorizeResult> {
    const paymentIntent = await this.stripe.paymentIntents.create({
      amount: Math.round(params.amount * 100),
      currency: params.currency.toLowerCase(),
      payment_method: params.paymentMethodToken,
      capture_method: 'automatic', // Immediate capture
      confirm: true,
    });

    return {
      processorTransactionId: paymentIntent.id,
      status: 'captured',
    };
  }

  // ... implement other methods
}
```

### 4. Processor Factory & Router

**File: `src/modules/payment/processors/factory.ts`**

```typescript
import { PaymentProcessor } from './base.js';
import { BraintreeProcessor } from './braintree.js';
import { StripeProcessor } from './stripe.js';
import { config } from '../../../config.js';

export type ProcessorType = 'braintree' | 'stripe' | 'adyen';

export class ProcessorFactory {
  private static processors: Map<ProcessorType, PaymentProcessor> = new Map();

  static initialize() {
    // Initialize Braintree
    this.processors.set('braintree', new BraintreeProcessor());

    // Initialize Stripe if configured
    if (config.stripe?.apiKey) {
      this.processors.set('stripe', new StripeProcessor(config.stripe.apiKey));
    }

    // Initialize Adyen if configured
    // if (config.adyen) { ... }
  }

  static getProcessor(type: ProcessorType): PaymentProcessor {
    const processor = this.processors.get(type);
    if (!processor) {
      throw new Error(`Payment processor ${type} not configured`);
    }
    return processor;
  }
}

// Routing logic based on business rules
export function selectProcessor(params: {
  country?: string;
  currency?: string;
  paymentMethod?: string;
}): ProcessorType {
  // Example routing logic:

  // Southeast Asia → Braintree (better local payment methods)
  if (['TH', 'MY', 'SG', 'ID', 'VN'].includes(params.country || '')) {
    return 'braintree';
  }

  // Europe → Stripe (better SEPA support)
  if (['GB', 'FR', 'DE', 'IT', 'ES'].includes(params.country || '')) {
    return 'stripe';
  }

  // Wallet payments → Braintree
  if (params.paymentMethod === 'wallet') {
    return 'braintree';
  }

  // Default
  return 'braintree';
}
```

### 5. Updated Services Layer

**File: `src/modules/payment/services.ts`**

```typescript
import { ProcessorFactory, selectProcessor } from './processors/factory.js';

// Initialize processors on startup
ProcessorFactory.initialize();

export async function authorizePayment(params: {
  userId: string;
  amount: number;
  currency: string;
  paymentMethodNonce: string;
  productType: "ride_hailing" | "car_rental" | "delivery";
  sourceEntityType: string;
  sourceEntityId: string;
  description?: string;
  idempotencyKey: string;
  country?: string; // NEW: for processor routing
  processorType?: 'braintree' | 'stripe'; // NEW: optional override
}) {
  return db.transaction(async (tx) => {
    // Check idempotency
    const existing = await tx.query.paymentAuthorization.findFirst({
      where: eq(paymentAuthorization.idempotencyKey, params.idempotencyKey),
    });

    if (existing) {
      return existing;
    }

    // Select processor based on routing rules
    const processorType = params.processorType || selectProcessor({
      country: params.country,
      currency: params.currency,
    });

    const processor = ProcessorFactory.getProcessor(processorType);

    // Authorize with selected processor
    const result = await processor.authorize({
      amount: params.amount,
      currency: params.currency,
      paymentMethodToken: params.paymentMethodNonce,
      metadata: {
        productType: params.productType,
        sourceEntityType: params.sourceEntityType,
        sourceEntityId: params.sourceEntityId,
      },
    });

    const platformRef = `PAY-${nanoid()}`;

    // Create authorization record
    const [auth] = await tx
      .insert(paymentAuthorization)
      .values({
        gatewayTransactionId: result.processorTransactionId,
        gatewayAuthorizationId: result.processorAuthorizationId,
        paymentMethod: 'credit_card',
        userId: params.userId,
        authorizedAmount: params.amount.toString(),
        capturedAmount: '0',
        remainingAmount: params.amount.toString(),
        currency: normalizeCurrency(params.currency),
        status: 'authorized',
        expiresAt: result.expiresAt,
        productType: params.productType,
        sourceEntityType: params.sourceEntityType,
        sourceEntityId: params.sourceEntityId,
        platformRef,
        idempotencyKey: params.idempotencyKey,
        description: params.description || `Authorization for ${params.sourceEntityType}`,
        metadata: {
          processor: processorType, // Store which processor was used
        },
      })
      .returning();

    return auth;
  });
}
```

### 6. Update Schema to Track Processor

**File: `src/db/schema.ts`**

```typescript
export const paymentProcessorEnum = pgEnum('payment_processor', [
  'braintree',
  'stripe',
  'adyen',
  'razorpay',
  'paypal',
]);

export const paymentAuthorization = pgTable(
  'payment_authorizations',
  {
    // ... existing fields

    // ADD: Track which processor was used
    processor: paymentProcessorEnum('processor').default('braintree').notNull(),

    // ... rest of fields
  }
);
```

---

## Implementation Priority

### Phase 1: Fix Multi-Currency (Quick Win)
1. ✅ Add `currencyIsoCode` to Braintree API calls
2. ✅ Add merchant account mapping
3. ✅ Update environment variables

**Effort:** 1-2 hours
**Impact:** HIGH - Critical for multi-market operation

### Phase 2: Multiple Processors (Long-term)
1. ⏳ Create processor abstraction layer
2. ⏳ Implement Braintree adapter
3. ⏳ Add processor routing logic
4. ⏳ Update schema with processor field
5. ⏳ Implement additional processors as needed

**Effort:** 1-2 weeks
**Impact:** MEDIUM - Enables geographic expansion and payment method diversity

---

## Testing Considerations

### Multi-Currency Testing

```bash
# Test THB payment
curl -X POST http://localhost:3000/payments/charge \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user-uuid",
    "amount": 1000,
    "currency": "THB",
    "paymentMethodNonce": "fake-valid-nonce",
    "productType": "ride_hailing",
    "sourceEntityType": "ride_request",
    "sourceEntityId": "ride-uuid",
    "idempotencyKey": "ride-thb-test"
  }'

# Test MYR payment
curl -X POST http://localhost:3000/payments/charge \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user-uuid",
    "amount": 50,
    "currency": "MYR",
    ...
  }'
```

### Multi-Processor Testing

```bash
# Test with specific processor
curl -X POST http://localhost:3000/payments/authorize \
  -d '{
    ...
    "processorType": "stripe",
    "country": "GB"
  }'
```

---

## Migration Path

### For Existing Deployments

1. **Add currency support without breaking changes:**
   ```sql
   -- No schema changes needed, just update services
   ```

2. **Add processor field with default:**
   ```sql
   ALTER TABLE payment_authorizations
   ADD COLUMN processor text DEFAULT 'braintree';

   CREATE TYPE payment_processor AS ENUM ('braintree', 'stripe', 'adyen');

   ALTER TABLE payment_authorizations
   ALTER COLUMN processor TYPE payment_processor
   USING processor::payment_processor;
   ```

3. **Backfill existing records:**
   ```sql
   UPDATE payment_authorizations
   SET processor = 'braintree'
   WHERE processor IS NULL;
   ```
