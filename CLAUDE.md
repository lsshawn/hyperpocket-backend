# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Hyperpocket Backend is a **Wallet Microservice** implementing financial ledger logic for multi-product platforms (ride-hailing, rentals, deliveries, etc.). Built with Hono, TypeScript, Drizzle ORM, and PostgreSQL.

## Service-Oriented Architecture (SOA)

This is a **microservice** positioned as the **Single Source of Truth** for all monetary logic across multiple products.

### Architectural Boundaries

| Component | Responsibility | Interaction |
| :--- | :--- | :--- |
| **Core App (Ride/Rental/Delivery)** | Bookings, Vehicle management, Driver dispatch, User authentication | Initiates requests (e.g., "Charge Customer," "Pay Host") to the Wallet API. **Does NOT access the Wallet DB.** |
| **Wallet Service (This Repo)** | Balances, Financial Transactions, Payment Gateways, Payouts, Invoicing, Settlements | Exposes a secure REST API to Core Apps. Uses **non-blocking asynchronous processing** for money movement. |

### Key Integration Principles

1. **User ID Consistency**: The `user.id` (UUID) must be globally consistent across both the Core App's `users` table and the Wallet Service's `wallet` and `transactions` tables.

2. **Decoupling via UUIDs**: All links from Core App entities (like `bookings`) to Wallet entities (like `transactions`, `payments`) must use **non-foreign key UUIDs** (e.g., `depositTransactionId: uuid('...')` in the `bookings` table) managed by the Wallet Service.

3. **API-Only Access**: External applications **MUST** interact with the wallet only through REST API endpoints. Direct database access is prohibited.

4. **Idempotency**: All charge and credit operations must accept a unique request key (e.g., `bookingId`) to ensure idempotent operations.

## Development Commands

```bash
# Development (hot reload)
pnpm dev

# Build TypeScript
pnpm build

# Production
pnpm prod  # builds and starts with PM2

# Database operations
pnpm db:push      # Push schema changes to DB
pnpm db:migrate   # Run migrations
pnpm db:studio    # Open Drizzle Studio GUI

# Linting/Formatting
biome check       # Check code quality
biome check --write  # Fix automatically
```

## Core Architecture

### Financial Ledger Model

The system implements **double-entry accounting** with a critical distinction:

- **`balance`** (Ledger Balance): Total funds including pending and available
- **`availableBalance`** (Spendable Balance): Only settled funds that can be withdrawn/transferred

**Key constraint**: `availableBalance <= balance` (enforced at DB level)

### Transaction Flow

1. **Deposits**:
   - Status starts as `pending`
   - Adds to `balance` immediately (user sees funds)
   - Does NOT add to `availableBalance` until settlement
   - Settlement: Call `validateDeposit()` to complete and add to `availableBalance`
   - This handles delayed payouts (e.g., Stripe T+2 settlement)

2. **Withdrawals & Transfers**:
   - Check `availableBalance` atomically using SQL `WHERE availableBalance >= amount`
   - Debit both `balance` and `availableBalance` simultaneously
   - Status is `completed` immediately

3. **Transfers**:
   - Create a `transfer` record to link two transactions
   - Atomically debit sender and credit receiver
   - Both transactions share the same `transferId`

### Data Model Hierarchy

```
user (global ID across all products)
  └── wallet (one per user)
       └── walletAccount[] (one per currency: USD, NGN, etc.)
            └── transaction[] (all money movements)
```

### Idempotency

All transactions use unique references (e.g., `DEP-{nanoid}`, `WDR-{nanoid}`, `TRF-{nanoid}`). For external operations, accept an idempotency key from the caller (e.g., bookingId).

### Transaction Anatomy

Every transaction records:
- `type`: deposit, withdrawal, transfer, payment, fee
- `direction`: credit or debit
- `status`: pending, completed, failed, cancelled, reversed
- `grossAmount`, `fee`, `netAmount` (constraint: `grossAmount = netAmount + fee`)
- `reference`: unique identifier
- `settledAt`: timestamp when funds became available

### Module Structure

```
src/
  ├── modules/
  │   ├── wallet/       # Core wallet logic
  │   │   ├── routes.ts    # Hono routes with Zod validation
  │   │   └── services.ts  # Business logic, DB transactions
  │   └── kyc/          # Placeholder for future KYC logic
  ├── db/
  │   ├── schema.ts     # Drizzle schema definitions
  │   └── index.ts      # DB connection
  ├── types.ts          # API response types
  ├── config.ts         # Environment validation
  └── index.ts          # App entry, CORS, routes
```

## Key Implementation Patterns

### Atomic Operations with Drizzle

Always wrap money operations in `db.transaction()`:

```typescript
return db.transaction(async (tx) => {
  // All operations succeed or all fail
  const account = await getOrCreateWalletAccountTx(tx, userId, currency);

  // Atomic balance check and update
  const updated = await tx
    .update(walletAccount)
    .set({ availableBalance: sql`${walletAccount.availableBalance} - ${amount}` })
    .where(and(
      eq(walletAccount.id, account.id),
      sql`${walletAccount.availableBalance} >= ${amount}`
    ))
    .returning();

  if (updated.length === 0) {
    throw new Error('Insufficient available balance');
  }
  // ... create transaction record
});
```

### Service Helpers

- `normalizeCurrency()`: Always uppercase currency codes
- `getOrCreateWalletTx()`: Ensures user has a wallet (upsert pattern)
- `getOrCreateWalletAccountTx()`: Ensures currency account exists

### Route Patterns

- Use `@hono/zod-validator` for all inputs
- Return consistent `ApiResponse<T>` format with `data`, `message`
- Differentiate 400 (client error) vs 500 (server error)
- Currency validation: exactly 3 uppercase letters

## Multi-Product Support

### Mandatory Schema Enhancements

To support multiple products sharing the same Wallet Service, the following fields **MUST** be added to the `transactions` table:

| Column Name | Data Type & Example | Rationale |
| :--- | :--- | :--- |
| **`product_type`** | `pgEnum('ride_hailing', 'rental', 'delivery')` | Identifies the top-level business context for accounting and filtering. |
| **`source_entity_type`** | `text` (e.g., 'rental_booking', 'food_order') | Identifies the table in the originating product's database. |
| **`source_entity_id`** | `uuid` | The foreign key (UUID) of the entity in the originating product's database (e.g., `bookings.id` from the Core App). |
| **`platform_ref`** | `text` or `uuid` (Unique Index) | A system-generated, globally unique reference for all high-value events for support and audit logs. |

**Implementation Note**: When adding these fields, update the `transaction` table schema in `src/db/schema.ts` and run `pnpm db:push` to apply changes.

## API Integration Scenarios

### Scenario A: Credit Card Upfront Payment + Deposit Pre-Auth

**Objective**: Capture rental price immediately (T+2 settlement) and place a hold for the security deposit.

| Step | Initiator | API Call to Wallet Service | Wallet DB Action (`transactions` table) |
| :--- | :--- | :--- | :--- |
| **1. Charge Rental** | Core App (Booking) | `POST /payments/capture`<br>Body: `userId`, `amount`, `paymentMethodId`, `bookingId` | **Txn 1 (Rental):** `type='payment'`, `direction='credit'`, `status='completed'`, `netAmount=$97`, `settledAt=T+2` |
| **2. Pre-Authorize Deposit** | Core App (Booking) | `POST /payments/preauthorize`<br>Body: `userId`, `amount`, `paymentMethodId`, `bookingId` | **Txn 2 (Deposit Hold):** `type='deposit'`, `direction='credit'`, `status='pending'`, `netAmount=$50` |
| **3. Booking Complete** | Core App (Checkout) | `POST /payments/release`<br>Body: `transactionId: Txn 2 ID` | **Txn 2 Update:** `status='cancelled'` |
| **3B. OR Claim Damage** | Core App (Checkout) | `POST /payments/capturePartial`<br>Body: `transactionId: Txn 2 ID`, `claimAmount: $20` | **Txn 3 (Claim):** `type='payment'`, `direction='credit'`, `status='completed'`, `netAmount=$20`, `settledAt=T+2` (Updates original Txn 2 based on gateway response). |

### Scenario B: Cash/Bank Transfer to Host + Weekly Settlement

**Objective**: Platform receives no money upfront. Invoice Host weekly for the platform fee, then debit their Wallet Account to clear the invoice.

| Step | Initiator | API Call/System Action | Wallet DB Action (`transactions` table) |
| :--- | :--- | :--- | :--- |
| **1. Booking Complete** | Core App (Booking) | **No API Call.** Host receives cash. Core App records `paymentMethod='cash'`. | **No Transaction.** |
| **2. Weekly Invoicing** | Wallet Service (CRON) | **Internal:** Creates `invoice` entity linked to fee-owing bookings. | **Invoice Table:** New row for platform fees due. |
| **3. Debit Host** | Wallet Service (CRON) | **Internal:** Finds Host's `walletAccount` and executes an internal transfer/debit. | **Txn 4 (Fee Debit):** `type='fee'`, `direction='debit'`, `status='completed'`, `netAmount=$50` (Total fees owed). |

### Wallet Balance Retrieval

Any Core App component (e.g., a dashboard, a driver app) needing a balance check must use a dedicated API endpoint:

| Action | Initiator | API Call to Wallet Service | Core App Display |
| :--- | :--- | :--- | :--- |
| **Get Host Balance** | Core App (Driver UI) | `GET /wallets/accounts/{userId}` | **Available Balance:** Sum of `availableBalance` from all currency accounts. |

## Database Schema Notes

- Uses PostgreSQL with Drizzle ORM
- Schema is code-first (TypeScript in `src/db/schema.ts`)
- Numeric precision: `numeric(19, 4)` for all money amounts
- Foreign keys have `onDelete: 'cascade'` (wallet) or `'restrict'` (transactions)
- Indexes on `walletAccountId + createdAt`, `reference`, `transferId`

## Code Style

- **Formatter**: Biome with tab indentation, double quotes
- **Module system**: ESNext with `.js` extensions in imports
- **Type safety**: Strict TypeScript with `verbatimModuleSyntax`
- **Validation**: Zod schemas for all external inputs

## Environment Variables

Required in `.env`:
- `DATABASE_URL`: PostgreSQL connection string (validated via Zod in `config.ts`)

## Important Conventions

1. **Never bypass atomic checks**: Always use `WHERE availableBalance >= amount` in the UPDATE statement
2. **Currency normalization**: Call `normalizeCurrency()` before any DB operation
3. **Transaction references**: Use nanoid for unique, collision-resistant IDs
4. **Error messages**: Match exact strings in route error handling (see `walletRoutes` for examples)
5. **Timestamps**: `createdAt` and `updatedAt` auto-managed; `settledAt` set manually on settlement

## Testing Notes

- Development endpoint: `POST /wallets/deposit/validate` simulates settlement (mark as production-only in future)
- Health check: `GET /health` returns `{ status: "ok" }`

## Admin API Endpoints

Admin endpoints for transaction monitoring, fee analysis, and system management.

**Authentication**: Admin routes should be protected with authentication middleware (TODO: implement).

### Transaction Management

#### `GET /admin/transactions`
List all transactions with filtering and pagination.

**Query Parameters:**
- `page` (number, default: 1): Page number
- `limit` (number, default: 50, max: 100): Items per page
- `userId` (UUID, optional): Filter by user
- `type` (enum, optional): Filter by type (deposit, withdrawal, transfer, payment, fee, refund)
- `currency` (string, optional): Filter by currency (3-letter code)
- `processor` (enum, optional): Filter by processor (braintree, stripe, adyen, razorpay)
- `startDate` (date, optional): Filter from date
- `endDate` (date, optional): Filter to date

**Response:**
```json
{
  "data": {
    "transactions": [
      {
        "id": "uuid",
        "type": "deposit",
        "direction": "credit",
        "status": "completed",
        "grossAmount": "100.0000",
        "fee": "3.2000",
        "netAmount": "96.8000",
        "currency": "USD",
        "processor": "braintree",
        "processorTransactionId": "abc123",
        "description": "Card deposit",
        "reference": "DEP-xyz",
        "createdAt": "2024-01-01T00:00:00Z",
        "settledAt": "2024-01-03T00:00:00Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 50,
      "total": 1234,
      "totalPages": 25
    }
  }
}
```

### Fee Analytics

#### `GET /admin/fees/summary`
Get aggregated fee totals and breakdown by transaction type.

**Query Parameters:**
- `currency` (string, optional): Filter by currency
- `startDate` (date, optional): Filter from date
- `endDate` (date, optional): Filter to date
- `processor` (enum, optional): Filter by processor

**Response:**
```json
{
  "data": {
    "summary": [
      {
        "type": "deposit",
        "currency": "USD",
        "processor": "braintree",
        "totalGrossAmount": "50000.0000",
        "totalFees": "1450.0000",
        "totalNetAmount": "48550.0000",
        "transactionCount": 250
      }
    ],
    "totals": {
      "totalGrossAmount": "50000.0000",
      "totalProcessorFees": "1450.0000",
      "totalNetAmount": "48550.0000",
      "transactionCount": 250
    }
  }
}
```

**Use case**: Calculate total fees paid to payment processors and compare with transaction volume to determine profitability.

#### `GET /admin/fees/processor-breakdown`
Get detailed breakdown of fees by payment processor.

**Query Parameters:**
- `startDate` (date, optional): Filter from date
- `endDate` (date, optional): Filter to date

**Response:**
```json
{
  "data": [
    {
      "processor": "braintree",
      "currency": "USD",
      "totalTransactions": 250,
      "totalVolume": "50000.0000",
      "totalFeesPaid": "1450.0000",
      "avgFeePercentage": "2.9000"
    },
    {
      "processor": "stripe",
      "currency": "THB",
      "totalTransactions": 180,
      "totalVolume": "900000.0000",
      "totalFeesPaid": "30600.0000",
      "avgFeePercentage": "3.4000"
    }
  ]
}
```

**Use case**: Compare processor efficiency and costs across different regions and currencies to optimize routing decisions.

## Fee Configuration Strategy

The wallet service tracks two types of fees:

1. **Processor Fees** (in `transaction.fee` field): Fees charged by payment processors (Braintree, Stripe, etc.). This is our cost.
2. **Platform Fees** (future enhancement): Fees charged to users for using the service. This is our revenue.

**Current Implementation**:
- Processor fees are calculated and stored in the `fee` field
- Currently using an absorb model: we pay processor fees, users deposit full amount
- Example: User deposits $100 → Processor charges $3 → User receives $97 in wallet

**Recommended Configuration Approach**: Hybrid App-Level + User-Level

See `FEE-CONFIGURATION-GUIDE.md` for comprehensive documentation on:
- Fee models (absorb, pass-through, markup)
- Configuration hierarchy (global → product → user tier → individual)
- Database schema for fee configuration
- Fee calculation logic
- Best practices and examples

**Quick Start:**
1. Begin with global (app-level) fee configuration for simplicity
2. Add user-level overrides for VIP/enterprise customers
3. Store configuration in database for runtime changes
4. Use Admin API to monitor fee performance

**Key Metrics to Track:**
- Total processor fees paid (cost)
- Total platform fees collected (revenue)
- Net fee income (revenue - cost)
- Fee revenue by product/currency
- Average fee percentage

## Wallet Deposit API

### `POST /wallets/deposit/payment`
Deposit funds into wallet using external payment methods.

**Supports:**
- 💳 Credit card deposits via Braintree/Stripe/Adyen/Razorpay
- 🏦 Bank transfer (processor-agnostic)
- 💰 Internal wallet transfers
- 🌍 Multi-currency (USD, THB, MYR, SGD, EUR, GBP, etc.)

**Request Body:**
```json
{
  "userId": "user-uuid",
  "amount": 100.00,
  "currency": "THB",
  "paymentMethod": "credit_card",
  "paymentMethodNonce": "nonce_from_braintree_dropin",
  "country": "TH",
  "idempotencyKey": "unique-request-id",
  "processorType": "braintree",
  "productType": "ride_hailing",
  "sourceEntityType": "ride_request",
  "sourceEntityId": "booking-uuid",
  "description": "Top up wallet for ride"
}
```

**Features:**
- Automatic processor selection based on country/currency
- Idempotency support for safe retries
- Fee calculation and tracking
- Pending status until settlement (T+2 pattern)
- Platform reference tracking for audit trails
- SOA field integration for multi-product tracking

## Planned API Endpoints (Not Yet Implemented)

The following endpoints need to be implemented to support the SOA integration scenarios:

### Payment Gateway Endpoints
- `POST /payments/capture` - Capture payment immediately (for upfront rental payments)
- `POST /payments/preauthorize` - Place a hold on funds (for security deposits)
- `POST /payments/release` - Release a held authorization without capturing
- `POST /payments/capturePartial` - Capture a portion of a held authorization (for damage claims)

### Invoicing Endpoints
- Internal CRON job for weekly invoice generation
- Internal service to debit wallet accounts for outstanding invoices

### Additional Features
- Authentication middleware (referenced in `kyc/routes.ts`)
- Invoice table schema for periodic fee billing
- Stripe/payment gateway integration for pre-auth, captures, and releases
