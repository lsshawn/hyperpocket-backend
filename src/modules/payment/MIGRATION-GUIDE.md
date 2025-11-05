# Migration Guide: Multi-Processor Architecture

This guide explains how to migrate from the original single-processor implementation to the new multi-processor architecture.

## Overview

The new architecture supports multiple payment processors (Braintree, Stripe, Adyen, Razorpay) with:
- Automatic processor routing based on country/currency
- Explicit processor selection
- Unified interface for all processors
- Database tracking of which processor handled each transaction

## What Changed

### 1. File Structure

**New Files:**
```
src/modules/payment/
├── processors/
│   ├── base.ts              # Processor interface and types
│   ├── braintree-adapter.ts # Braintree implementation
│   ├── factory.ts           # Processor factory and routing
│   └── index.ts            # Exports
├── services-v2.ts          # New multi-processor services
└── routes-v2.ts            # New multi-processor routes
```

**Original Files (still present):**
```
├── services.ts             # Original Braintree-only services
└── routes.ts               # Original routes
```

### 2. Database Schema Changes

**Added to `payment_authorizations` table:**
```typescript
processor: paymentProcessorEnum('processor')
  .default('braintree')
  .notNull() // Tracks which processor was used
```

**Added to `refunds` table:**
```typescript
processor: paymentProcessorEnum('processor')
  .default('braintree')
  .notNull()
```

**New enum:**
```typescript
export const paymentProcessorEnum = pgEnum('payment_processor', [
  'braintree',
  'stripe',
  'adyen',
  'razorpay',
]);
```

### 3. Configuration Changes

**Added to `config.ts`:**
```typescript
braintree: {
  // ... existing config
  merchantAccounts: {
    USD: env.BRAINTREE_MERCHANT_ACCOUNT_USD,
    THB: env.BRAINTREE_MERCHANT_ACCOUNT_THB,
    MYR: env.BRAINTREE_MERCHANT_ACCOUNT_MYR,
    SGD: env.BRAINTREE_MERCHANT_ACCOUNT_SGD,
    EUR: env.BRAINTREE_MERCHANT_ACCOUNT_EUR,
    GBP: env.BRAINTREE_MERCHANT_ACCOUNT_GBP,
  }
}
```

## Migration Options

### Option 1: Keep Using Original Implementation (Recommended for Now)

If you don't need multiple processors yet, you can continue using the original files:

**Current setup:**
```typescript
// src/index.ts
import paymentRoutes from "./modules/payment/routes.js";
import webhookRoutes from "./modules/payment/webhook.js";

app.route("/payments", paymentRoutes);
app.route("/webhooks", webhookRoutes);
```

**No changes needed** - Everything works as before!

### Option 2: Migrate to Multi-Processor (Future-Proof)

If you want to prepare for multiple processors:

#### Step 1: Update imports in `src/index.ts`

**From:**
```typescript
import paymentRoutes from "./modules/payment/routes.js";
```

**To:**
```typescript
import { ProcessorFactory } from "./modules/payment/processors/factory.js";
import paymentRoutes from "./modules/payment/routes-v2.js";

// Initialize processors
ProcessorFactory.initialize();
```

#### Step 2: Run database migration

```bash
# Push schema changes
pnpm db:push

# Or create migration
pnpm db:migrate
```

#### Step 3: (Optional) Configure merchant accounts

Add to `.env`:
```bash
BRAINTREE_MERCHANT_ACCOUNT_USD=your_usd_account
BRAINTREE_MERCHANT_ACCOUNT_THB=your_thb_account
# ... etc
```

#### Step 4: Test the migration

```bash
# Test authorize with automatic routing
curl -X POST http://localhost:3000/payments/authorize \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user-uuid",
    "amount": 1000,
    "currency": "THB",
    "paymentMethodNonce": "fake-valid-nonce",
    "productType": "ride_hailing",
    "sourceEntityType": "ride_request",
    "sourceEntityId": "ride-uuid",
    "idempotencyKey": "test-1",
    "country": "TH"
  }'

# Test with explicit processor selection
curl -X POST http://localhost:3000/payments/charge \
  -H "Content-Type: application/json" \
  -d '{
    ...
    "processorType": "braintree"
  }'
```

## API Changes

### New Optional Parameters

All payment endpoints now accept:

```typescript
{
  // ... existing params
  country?: string,        // ISO 2-letter code (e.g., 'TH', 'US')
  processorType?: string,  // 'braintree' | 'stripe' | 'adyen' | 'razorpay'
}
```

### Processor Selection Priority

1. **Explicit**: If `processorType` is specified, use that processor
2. **Automatic**: Route based on `country` or `currency`
3. **Default**: Use Braintree

### Routing Rules (Automatic Selection)

**By Country:**
- Southeast Asia (TH, MY, SG, ID, VN, PH) → Braintree
- Europe (GB, FR, DE, IT, ES, etc.) → Stripe (if available)
- India (IN) → Razorpay (if available)
- US, CA, AU, NZ → Stripe or Braintree

**By Currency:**
- THB, MYR, SGD, IDR, VND, PHP → Braintree
- EUR, GBP, CHF, SEK, NOK, DKK → Stripe (if available)
- INR → Razorpay (if available)

**By Payment Method:**
- PayPal, Venmo → Braintree
- Alipay, WeChat Pay, iDEAL → Adyen (if available)

## Backward Compatibility

### All existing code continues to work!

The original `services.ts` and `routes.ts` files are unchanged and fully functional.

### Database compatibility

- New `processor` fields have `default('braintree')`
- Existing records will automatically get `processor='braintree'`
- No data migration needed

### API compatibility

- New optional parameters don't affect existing API calls
- Responses include same data structure
- All existing integrations continue to work

## Testing Both Versions

You can test both implementations side by side:

```typescript
// src/index.ts
import paymentRoutesV1 from "./modules/payment/routes.js";
import paymentRoutesV2 from "./modules/payment/routes-v2.js";

app.route("/payments/v1", paymentRoutesV1);  // Original
app.route("/payments/v2", paymentRoutesV2);  // New multi-processor
app.route("/payments", paymentRoutesV2);     // Default to new
```

## Adding New Processors

### Example: Adding Stripe

#### 1. Install Stripe SDK
```bash
pnpm add stripe
```

#### 2. Create Stripe adapter

**File: `src/modules/payment/processors/stripe-adapter.ts`**

```typescript
import Stripe from 'stripe';
import type { PaymentProcessor, AuthorizeParams, AuthorizeResult } from './base.js';

export class StripeProcessor implements PaymentProcessor {
  readonly name = 'stripe' as const;
  private stripe: Stripe;

  constructor(apiKey: string) {
    this.stripe = new Stripe(apiKey, { apiVersion: '2023-10-16' });
  }

  async authorize(params: AuthorizeParams): Promise<AuthorizeResult> {
    const paymentIntent = await this.stripe.paymentIntents.create({
      amount: Math.round(params.amount * 100), // cents
      currency: params.currency.toLowerCase(),
      payment_method: params.paymentMethodToken,
      capture_method: 'manual',
      confirm: true,
    });

    return {
      processorTransactionId: paymentIntent.id,
      status: 'authorized',
    };
  }

  // ... implement other methods
}
```

#### 3. Update factory

**File: `src/modules/payment/processors/factory.ts`**

```typescript
import { StripeProcessor } from './stripe-adapter.js';

static initialize() {
  // ... existing Braintree init

  // Add Stripe
  if (config.stripe?.apiKey) {
    const stripeAdapter = new StripeProcessor(config.stripe.apiKey);
    this.processors.set('stripe', stripeAdapter);
  }
}
```

#### 4. Add config

**File: `src/config.ts`**

```typescript
const envSchema = z.object({
  // ... existing
  STRIPE_API_KEY: z.string().optional(),
});

export const config = {
  // ... existing
  stripe: env.STRIPE_API_KEY ? {
    apiKey: env.STRIPE_API_KEY,
  } : undefined,
};
```

#### 5. Test

```bash
# Set env var
export STRIPE_API_KEY=sk_test_...

# Restart server - Stripe will auto-initialize
pnpm dev

# Test Stripe
curl -X POST http://localhost:3000/payments/charge \
  -d '{"processorType": "stripe", ...}'
```

## Rollback Plan

If you need to rollback to the original implementation:

### 1. Revert routes

```typescript
// src/index.ts
import paymentRoutes from "./modules/payment/routes.js"; // Original
```

### 2. (Optional) Revert database

```sql
-- Remove processor column if needed
ALTER TABLE payment_authorizations DROP COLUMN IF EXISTS processor;
ALTER TABLE refunds DROP COLUMN IF EXISTS processor;
DROP TYPE IF EXISTS payment_processor;
```

### 3. Remove processor files

```bash
rm -rf src/modules/payment/processors/
rm src/modules/payment/services-v2.ts
rm src/modules/payment/routes-v2.ts
```

## Support

The original implementation remains fully supported. You can:
- Continue using `services.ts` and `routes.ts`
- Mix both implementations
- Migrate at your own pace

No breaking changes to existing functionality!
