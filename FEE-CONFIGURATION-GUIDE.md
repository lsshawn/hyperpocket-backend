# Fee Configuration Guide

## Overview

This document explains the fee model for the Hyperpocket Wallet Service and provides guidance on configuring fees.

## Fee Types

### 1. Processor Fees (Cost to Us)
Fees charged by payment processors (Braintree, Stripe, Adyen, Razorpay) for processing transactions.

**Examples:**
- **Braintree**: 2.9% + $0.30 per card transaction (US)
- **Stripe**: 2.9% + $0.30 per card transaction (US), 3.4% + THB 11 (Thailand)
- **Adyen**: Interchange++ model (varies by card type and region)

**Characteristics:**
- Set by payment processor contracts
- Varies by currency, card type, and region
- Cannot be changed by us (negotiated rates)
- Must be tracked accurately for profitability analysis

### 2. Platform Fees (Revenue to Us)
Fees charged to users for using the wallet service.

**Business Models:**

#### A. Absorb Model (Growth Strategy)
```
User pays: $100
Processor charges us: $3 (2.9% + $0.30)
Platform fee: $0
User receives in wallet: $100
Our cost: -$3
```
**Use case**: Encourage wallet adoption, charge fees elsewhere (withdrawal, transfer)

#### B. Pass-Through Model (Break-Even)
```
User pays: $103
Processor charges us: $3
Platform fee: $0
User receives in wallet: $100
Our cost: $0
```
**Use case**: No revenue from deposits, make money from other services

#### C. Markup Model (Profitable)
```
User pays: $105
Processor charges us: $3
Platform fee: $2
User receives in wallet: $100
Our revenue: $2
```
**Use case**: Generate revenue from transactions

#### D. Flat Fee Model
```
User pays: $100 + $5 flat fee
Processor charges us: $3
Platform fee: $5
User receives in wallet: $100
Our revenue: $2
```
**Use case**: Predictable fees for users, easier to communicate

## Recommended Configuration Strategy

### ⭐ Recommended: Hybrid App-Level + User-Level Configuration

**Why this approach?**
- Start simple with global defaults
- Add flexibility for special cases (VIP, enterprise, promotions)
- Easy to manage and scale
- Supports different fee strategies per product/use-case

### Configuration Hierarchy
```
1. Global Default (App-Level)
   ↓
2. Product-Specific Override (e.g., ride_hailing vs car_rental)
   ↓
3. User Tier Override (e.g., VIP, Enterprise)
   ↓
4. Individual User Override (e.g., special contracts)
```

## Implementation: Fee Configuration Schema

### Database Schema

```typescript
// Fee configuration table
export const feeConfig = pgTable("fee_config", {
  id: uuid().defaultRandom().primaryKey(),

  // Scope: global, product, user_tier, user
  scope: feeConfigScopeEnum("scope").notNull(),
  scopeValue: text("scope_value"), // e.g., "ride_hailing", "tier_vip", userId

  // Transaction type this fee applies to
  transactionType: transactionTypeEnum("transaction_type").notNull(),
  paymentMethod: paymentMethodEnum("payment_method"), // Optional: specific to payment method

  // Fee structure
  feeType: feeTypeEnum("fee_type").notNull(), // percentage, flat, hybrid
  percentageFee: numeric("percentage_fee", { precision: 5, scale: 4 }), // e.g., 0.0290 for 2.9%
  flatFee: numeric("flat_fee", { precision: 19, scale: 4 }), // e.g., 0.30
  minFee: numeric("min_fee", { precision: 19, scale: 4 }), // Minimum fee
  maxFee: numeric("max_fee", { precision: 19, scale: 4 }), // Maximum fee (cap)

  // Currency
  currency: char("currency", { length: 3 }).notNull(),

  // Fee behavior
  chargeModel: feeChargeModelEnum("charge_model").notNull(), // absorb, pass_through, markup

  // Active status
  isActive: boolean("is_active").default(true),
  startDate: timestamp("start_date"),
  endDate: timestamp("end_date"), // For promotional periods

  // Metadata
  description: text("description"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Enums
export const feeConfigScopeEnum = pgEnum("fee_config_scope", [
  "global",
  "product",
  "user_tier",
  "user",
]);

export const feeTypeEnum = pgEnum("fee_type", [
  "percentage",
  "flat",
  "hybrid", // percentage + flat (e.g., 2.9% + $0.30)
]);

export const feeChargeModelEnum = pgEnum("fee_charge_model", [
  "absorb",      // We pay processor fees
  "pass_through", // User pays exact processor fees
  "markup",      // User pays processor fees + platform fee
]);

// User tier table (for tier-based pricing)
export const userTier = pgTable("user_tiers", {
  id: uuid().defaultRandom().primaryKey(),
  userId: uuid("user_id").references(() => user.id),
  tier: userTierEnum("tier").notNull(), // standard, premium, vip, enterprise
  startDate: timestamp("start_date").notNull(),
  endDate: timestamp("end_date"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const userTierEnum = pgEnum("user_tier", [
  "standard",
  "premium",
  "vip",
  "enterprise",
]);
```

## Configuration Examples

### Example 1: Global Absorb Model (Encourage Deposits)
```typescript
// For all users: We absorb processor fees for deposits
{
  scope: "global",
  scopeValue: null,
  transactionType: "deposit",
  paymentMethod: "credit_card",
  feeType: "hybrid",
  percentageFee: 0.0000, // No fee to user
  flatFee: 0.0000,
  currency: "USD",
  chargeModel: "absorb", // We pay the processor fee
  isActive: true
}
```

### Example 2: Withdrawal Fee (Revenue)
```typescript
// Charge flat fee for withdrawals
{
  scope: "global",
  scopeValue: null,
  transactionType: "withdrawal",
  feeType: "flat",
  flatFee: 2.00, // $2 withdrawal fee
  currency: "USD",
  chargeModel: "markup", // This is pure revenue
  isActive: true
}
```

### Example 3: VIP User Discount
```typescript
// VIP users pay no withdrawal fees
{
  scope: "user_tier",
  scopeValue: "vip",
  transactionType: "withdrawal",
  feeType: "flat",
  flatFee: 0.00, // No fee for VIP
  currency: "USD",
  chargeModel: "absorb",
  isActive: true
}
```

### Example 4: Product-Specific Fees
```typescript
// Ride-hailing deposits have lower fees to encourage usage
{
  scope: "product",
  scopeValue: "ride_hailing",
  transactionType: "deposit",
  paymentMethod: "credit_card",
  feeType: "percentage",
  percentageFee: 0.01, // 1% fee (vs 2.9% processor cost = we subsidize)
  currency: "USD",
  chargeModel: "markup",
  isActive: true
}
```

### Example 5: Promotional Period
```typescript
// Free deposits for December (holiday promotion)
{
  scope: "global",
  transactionType: "deposit",
  feeType: "flat",
  flatFee: 0.00,
  currency: "USD",
  chargeModel: "absorb",
  isActive: true,
  startDate: new Date("2024-12-01"),
  endDate: new Date("2024-12-31"),
  description: "Holiday promotion: Free deposits!"
}
```

## Fee Calculation Logic

### Priority Order (Highest to Lowest)
1. **User-specific** configuration
2. **User tier** configuration
3. **Product-specific** configuration
4. **Global** configuration
5. **Default fallback** (absorb model, $0 fee)

### Fee Calculation Service

```typescript
export async function calculateFee(params: {
  userId: string;
  amount: number;
  currency: string;
  transactionType: "deposit" | "withdrawal" | "transfer";
  paymentMethod?: "credit_card" | "bank_transfer";
  productType?: string;
}): Promise<{
  processorFee: number;
  platformFee: number;
  totalFee: number;
  chargeModel: "absorb" | "pass_through" | "markup";
}> {
  // 1. Get processor fee (from processor contracts)
  const processorFee = await getProcessorFee(params);

  // 2. Get applicable fee config (respects hierarchy)
  const feeConfig = await getApplicableFeeConfig(params);

  // 3. Calculate platform fee based on config
  let platformFee = 0;

  if (feeConfig.feeType === "percentage") {
    platformFee = params.amount * feeConfig.percentageFee;
  } else if (feeConfig.feeType === "flat") {
    platformFee = feeConfig.flatFee;
  } else if (feeConfig.feeType === "hybrid") {
    platformFee = (params.amount * feeConfig.percentageFee) + feeConfig.flatFee;
  }

  // Apply min/max caps
  if (feeConfig.minFee && platformFee < feeConfig.minFee) {
    platformFee = feeConfig.minFee;
  }
  if (feeConfig.maxFee && platformFee > feeConfig.maxFee) {
    platformFee = feeConfig.maxFee;
  }

  // 4. Determine what user pays based on charge model
  let totalFee = 0;

  switch (feeConfig.chargeModel) {
    case "absorb":
      totalFee = platformFee; // User pays only platform fee, we absorb processor
      break;
    case "pass_through":
      totalFee = processorFee + platformFee; // User pays both
      break;
    case "markup":
      totalFee = platformFee; // Platform fee includes markup on processor cost
      break;
  }

  return {
    processorFee,
    platformFee,
    totalFee,
    chargeModel: feeConfig.chargeModel,
  };
}
```

## Recommendations by Use Case

### For New Platforms (Growth Phase)
```typescript
// Absorb all fees for deposits, charge for withdrawals
Deposits: chargeModel = "absorb", platformFee = 0
Withdrawals: chargeModel = "markup", platformFee = $2-5
Transfers: chargeModel = "absorb", platformFee = 0 (encourage wallet usage)
```

### For Established Platforms (Revenue Phase)
```typescript
// Small markup on deposits, maintain withdrawal fees
Deposits: chargeModel = "markup", platformFee = 1% or $1
Withdrawals: chargeModel = "markup", platformFee = $2-5
Transfers: chargeModel = "markup", platformFee = 0.5% or $0.50
```

### For Enterprise/B2B
```typescript
// Negotiated rates stored per user
scope = "user"
scopeValue = userId
Custom fee structure based on volume commitments
```

## Admin Configuration API

### Create Fee Configuration
```http
POST /admin/fees/config
{
  "scope": "global",
  "transactionType": "deposit",
  "paymentMethod": "credit_card",
  "feeType": "hybrid",
  "percentageFee": 0.029,
  "flatFee": 0.30,
  "currency": "USD",
  "chargeModel": "markup"
}
```

### Update Fee Configuration
```http
PUT /admin/fees/config/:id
{
  "platformFee": 0.01,
  "chargeModel": "absorb"
}
```

### List Fee Configurations
```http
GET /admin/fees/config?scope=global&currency=USD
```

## Monitoring & Analytics

### Key Metrics to Track
1. **Total Processor Fees Paid**: What we're spending
2. **Total Platform Fees Collected**: Our revenue
3. **Net Fee Income**: Platform fees - Processor fees
4. **Fee Revenue by Product**: Which products are profitable
5. **Average Fee per Transaction**: Efficiency metric
6. **Fee Percentage of Transaction Volume**: Profitability ratio

### Use the Admin Dashboard
```http
GET /admin/fees/summary?startDate=2024-01-01&endDate=2024-12-31
GET /admin/fees/processor-breakdown?startDate=2024-01-01
GET /admin/transactions?type=deposit&processor=braintree
```

## Migration Path

### Phase 1: Start Simple (Current Implementation)
- Hard-coded fees in code
- Global absorb model for deposits
- Fixed withdrawal fees

### Phase 2: Database Configuration (Recommended)
- Implement fee_config table
- Admin UI for fee management
- Support global and product-level fees

### Phase 3: Advanced Features
- User tier system
- Volume-based discounts
- Promotional campaigns
- A/B testing different fee structures

## Best Practices

1. **Be Transparent**: Show fee breakdown to users before they confirm
2. **Start Conservative**: Begin with absorb model to encourage adoption
3. **Monitor Closely**: Track net fee income weekly
4. **Test Pricing**: A/B test different fee structures with user segments
5. **Regional Optimization**: Different fees for different markets
6. **Communicate Changes**: Give users advance notice of fee changes
7. **Provide Value**: Higher fees justified by better service

## Answer to Your Question

**"What's the best way to configure fees: by app or user?"**

### Recommended Approach: **Hybrid Model**

**Start with app-level (global) configuration:**
- Simpler to implement and manage
- Consistent user experience
- Easier to communicate pricing
- Good for MVP/early stage

**Add user-level overrides for:**
- VIP/Enterprise customers (negotiated rates)
- High-volume users (volume discounts)
- Promotional campaigns (temporary fee waivers)
- Special partnerships (affiliate deals)

**Implementation:**
```
Global Default → Product Override → User Tier → Individual User
```

This gives you:
- ✅ Simplicity for 95% of users (global config)
- ✅ Flexibility for special cases (5% need custom rates)
- ✅ Easy to manage and scale
- ✅ Clear audit trail of fee changes
- ✅ Runtime configuration (no code deploys)

**Start simple, add complexity as needed.**
