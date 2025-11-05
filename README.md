# Hyperpocket Wallet Backend

A **Wallet Microservice** implementing financial ledger logic for multi-product platforms (ride-hailing, car rentals, deliveries, etc.). Built with Hono, TypeScript, Drizzle ORM, and PostgreSQL.

## Implementation Status

### ✅ Implemented Features

#### Payment Gateway Integration
- ✅ **POST /payments/authorize** - Pre-authorize payment (hold funds without capturing)
- ✅ **POST /payments/charge** - Charge payment immediately (authorize + capture)
- ✅ **POST /payments/capture** - Capture previously authorized payment (supports partial capture)
- ✅ **POST /payments/void** - Release authorization without capturing
- ✅ **POST /payments/refund** - Refund completed payment (supports partial refund)
- ✅ **GET /payments/client-token** - Generate Braintree Drop-in UI token
- ✅ **POST /payments/customer** - Create or get customer in payment processor
- ✅ **GET /payments/:id** - Get authorization details
- ✅ **GET /payments/source/:sourceEntityId** - Get authorizations by booking/order ID

#### Wallet Management
- ✅ **POST /wallets/** - Create wallet for user
- ✅ **POST /wallets/account** - Create currency account
- ✅ **GET /wallets/** - Get wallet account balance (query: userId, currency)
- ✅ **POST /wallets/deposit** - Simple deposit (for testing/internal use)
- ✅ **POST /wallets/deposit/payment** - Deposit with payment processor (credit card, bank transfer)
- ✅ **POST /wallets/withdraw** - Withdraw funds
- ✅ **POST /wallets/transfer** - Transfer between users
- ✅ **GET /wallets/deposit** - Get deposit history
- ✅ **GET /wallets/withdraw** - Get withdrawal history
- ✅ **POST /wallets/deposit/validate** - Simulate settlement (dev only)

#### Admin Dashboard
- ✅ **GET /admin/transactions** - List all transactions with filtering & pagination
- ✅ **GET /admin/fees/summary** - Aggregated fee totals by type/currency/processor
- ✅ **GET /admin/fees/processor-breakdown** - Compare processor costs and efficiency

#### Multi-Product Support
- ✅ SOA fields in transactions: `productType`, `sourceEntityType`, `sourceEntityId`, `platformRef`
- ✅ Payment processor tracking: `processor`, `processorTransactionId`
- ✅ Multi-currency support with automatic processor selection
- ✅ Idempotency support for all payment operations

### ⚠️ Not Yet Implemented

- ❌ **Invoice system** - Weekly invoicing CRON job for platform fees
- ❌ **Invoice table schema** - Database table for tracking invoices
- ❌ **Invoice-based debits** - Automatic debit of wallet accounts to clear invoices
- ❌ **Authentication middleware** - Admin routes are currently unprotected
- ❌ **Webhooks for Stripe/Adyen** - Currently only Braintree webhooks implemented

---

## Handling Delayed Payouts

This is a core concept of financial ledger design: handling funds that are in-flight.

For a scenario with delayed payouts from a payment gateway like Stripe, it is best practice to credit the user's wallet immediately but distinguish between funds that are pending and funds that are available to spend. This gives the user immediate feedback that their deposit was successful, while protecting your system from letting them spend money you haven't actually received yet.

To achieve this, we use an `availableBalance` in the `walletAccount`. Here's how it works:

1. **Ledger Balance vs. Available Balance**: The `balance` column acts as the ledger balance, which includes all funds (pending + available). The `availableBalance` column tracks funds that have been settled and are spendable.

2. **Deposit Flow**: When a user deposits money via Stripe, a transaction is created with a `pending` status. The deposited amount is added to their `walletAccount.balance`, but NOT to their `availableBalance`.

3. **Settlement Flow**: When Stripe pays out the funds to you (e.g., 5 days later), you'll update the original transaction status to `completed` and add the amount to the user's `walletAccount.availableBalance`.

This way, the funds are always associated with the user's wallet. You don't need a separate "master wallet" table in your schema; this accounting model handles it cleanly.

---

## 1. Architectural Strategy: Wallet Microservice

The core strategy is **Service-Oriented Architecture (SOA)**, positioning the **Wallet Service** as the **Single Source of Truth** for all monetary logic.

| Component | Responsibility | Interaction |
| :--- | :--- | :--- |
| **Core App (Ride/Rental)** | Bookings, Vehicle management, Driver dispatch, User authentication. | Initiates requests (e.g., "Charge Customer," "Pay Host") to the Wallet API. **Does NOT access the Wallet DB.** |
| **Wallet Service** | **Balances**, Financial Transactions, Payment Gateways, Payouts, Invoicing, Settlements. | Exposes a secure API (REST) to the Core App. Uses **non-blocking asynchronous processing** for money movement. |

### Key Data References

* **User ID:** The `user.id` (UUID) must be globally consistent across both the Core App's `users` table and the Wallet Service's `wallet` and `transactions` tables.
* **Decoupling:** All links from Core App entities (like `bookings`) to Wallet entities (like `transactions`, `payments`) must use **non-foreign key UUIDs** (e.g., `depositTransactionId: uuid('...')` in the `bookings` table) managed by the Wallet Service.

---

## 2. API & Transaction Scenarios

The Wallet Service exposes clear, single-purpose endpoints. All charge and credit operations support **idempotency** using a unique request key (e.g., the Booking ID).

### Scenario A: Credit Card Upfront Payment + Deposit Pre-Auth

**Objective:** Capture rental price immediately (T+2 settlement) and place a hold for the security deposit.

| Step | Initiator | API Call to Wallet Service | Wallet DB Action (`payment_authorizations` table) |
| :--- | :--- | :--- | :--- |
| **1. Charge Rental** | Core App (Booking) | `POST /payments/charge`<br/>Body: `userId`, `amount`, `currency`, `paymentMethodNonce`, `productType`, `sourceEntityType`, `sourceEntityId`, `idempotencyKey` | **Auth 1 (Rental):** `status='captured'`, `capturedAmount=$97`, `settledAt=T+2` |
| **2. Pre-Authorize Deposit** | Core App (Booking) | `POST /payments/authorize`<br/>Body: `userId`, `amount`, `currency`, `paymentMethodNonce`, `productType`, `sourceEntityType`, `sourceEntityId`, `idempotencyKey` | **Auth 2 (Deposit Hold):** `status='authorized'`, `authorizedAmount=$50`, `capturedAmount=$0` |
| **3. Booking Complete (No Damage)** | Core App (Checkout) | `POST /payments/void`<br/>Body: `authorizationId` (Auth 2 ID), `userId` | **Auth 2 Update:** `status='voided'` |
| **3B. OR Claim Damage** | Core App (Checkout) | `POST /payments/capture`<br/>Body: `authorizationId` (Auth 2 ID), `amount: $20`, `userId`, `currency` | **Auth 2 Update:** `status='partially_captured'`, `capturedAmount=$20`, `remainingAmount=$30` |

**Example Request for Step 1 (Charge Rental):**
```bash
POST /payments/charge
Content-Type: application/json

{
  "userId": "user-uuid",
  "amount": 100.00,
  "currency": "USD",
  "paymentMethodNonce": "fake-valid-nonce",
  "productType": "car_rental",
  "sourceEntityType": "rental_booking",
  "sourceEntityId": "booking-uuid",
  "idempotencyKey": "booking-uuid-payment",
  "description": "Car rental payment"
}
```

**Example Request for Step 2 (Pre-Authorize Deposit):**
```bash
POST /payments/authorize
Content-Type: application/json

{
  "userId": "user-uuid",
  "amount": 50.00,
  "currency": "USD",
  "paymentMethodNonce": "fake-valid-nonce",
  "productType": "car_rental",
  "sourceEntityType": "rental_booking",
  "sourceEntityId": "booking-uuid",
  "idempotencyKey": "booking-uuid-deposit",
  "description": "Security deposit hold"
}
```

---

### Scenario B: Cash/Bank Transfer to Host + Weekly Settlement

**Objective:** Platform receives no money upfront. Invoice Host weekly for the platform fee, then debit their Wallet Account to clear the invoice.

| Step | Initiator | API Call/System Action | Wallet DB Action |
| :--- | :--- | :--- | :--- |
| **1. Booking Complete** | Core App (Booking) | **No API Call.** Host receives cash. Core App records `paymentMethod='cash'`. | **No Transaction.** |
| **2. Weekly Invoicing** | Wallet Service (CRON) | **Internal:** Creates `invoice` entity linked to fee-owing bookings. | **Invoice Table:** New row for platform fees due. ⚠️ **Not yet implemented** |
| **3. Debit Host** | Wallet Service (CRON) | **Internal:** Finds Host's `walletAccount` and executes internal debit via `POST /wallets/withdraw` | **Transaction:** `type='fee'`, `direction='debit'`, `status='completed'` |

⚠️ **Note**: The invoice system (table, CRON job, invoice-based debits) is not yet implemented. Currently, you can manually debit wallet accounts using the withdraw endpoint.

---

## 3. Mandatory Multi-Product Schema Enhancements

To support multiple products sharing the same Wallet, the following fields have been added to the **`transactions` table**:

| Column Name | Data Type & Example | Rationale |
| :--- | :--- | :--- |
| **`product_type`** | `pgEnum('ride_hailing', 'car_rental', 'delivery')` | Identifies the top-level business context for accounting and filtering. |
| **`source_entity_type`** | `text` (e.g., 'rental_booking', 'food_order') | Identifies the table in the originating product's database. |
| **`source_entity_id`** | `uuid` | The foreign key (UUID) of the entity in the originating product's database (e.g., `bookings.id` from the Core App). |
| **`platform_ref`** | `text` (Unique Index) | A system-generated, globally unique reference for all high-value events for support and audit logs. |
| **`processor`** | `pgEnum('braintree', 'stripe', 'adyen', 'razorpay')` | Which payment processor handled this transaction. |
| **`processor_transaction_id`** | `text` | Transaction ID from the payment processor for reconciliation. |

---

## 4. Wallet Balance Retrieval

Any Core App component (e.g., a dashboard, a driver app) needing a balance check must use the dedicated API endpoint:

| Action | Initiator | API Call to Wallet Service | Response |
| :--- | :--- | :--- | :--- |
| **Get User Balance** | Core App (Driver UI) | `GET /wallets/?userId={userId}&currency=USD` | Returns `walletAccount` object with `balance` and `availableBalance` |

**Example Request:**
```bash
GET /wallets/?userId=user-uuid-123&currency=USD

Response:
{
  "data": {
    "id": "account-uuid",
    "walletId": "wallet-uuid",
    "currency": "USD",
    "balance": "1000.0000",
    "availableBalance": "950.0000",
    "createdAt": "2024-01-01T00:00:00Z",
    "updatedAt": "2024-01-15T10:30:00Z"
  },
  "message": "Wallet account fetched successfully"
}
```

---

## 5. Wallet Deposit for Frontend Developers

### Deposit with Payment Processor

**Endpoint:** `POST /wallets/deposit/payment`

This endpoint allows users to deposit funds into their wallet using credit cards, bank transfers, or other payment methods.

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
  "sourceEntityType": "wallet_topup",
  "sourceEntityId": "topup-uuid",
  "description": "Top up wallet for rides"
}
```

**Response:**
```json
{
  "data": {
    "id": "transaction-uuid",
    "type": "deposit",
    "direction": "credit",
    "status": "pending",
    "grossAmount": "100.0000",
    "fee": "3.2000",
    "netAmount": "96.8000",
    "currency": "THB",
    "processor": "braintree",
    "processorTransactionId": "braintree-txn-id",
    "reference": "DEP-xyz123",
    "platformRef": "WDEP-abc456",
    "createdAt": "2024-01-15T10:30:00Z"
  },
  "message": "Deposit processed successfully. Funds will be available after settlement."
}
```

**Features:**
- Automatic processor selection based on country/currency
- Idempotency support for safe retries
- Fee calculation and tracking
- Pending status until settlement (T+2 pattern)
- Platform reference tracking for audit trails

**Frontend Integration:**
1. Use `GET /payments/client-token` to get Braintree Drop-in token
2. Initialize Braintree Drop-in UI in your frontend
3. User enters payment details
4. Get `paymentMethodNonce` from Braintree
5. Call `POST /wallets/deposit/payment` with the nonce
6. Show success message to user
7. Funds appear in balance immediately, available after settlement

See `FRONTEND-PAYMENT-INTEGRATION-GUIDE.md` for complete Svelte implementation examples.

---

## 6. Wallet Transfers for Frontend Developers

### Transfer Between Users

**Endpoint:** `POST /wallets/transfer`

Transfer funds from one user to another within the same currency.

**Request Body:**
```json
{
  "from": "sender-user-uuid",
  "to": "recipient-user-uuid",
  "amount": 50.00,
  "currency": "USD"
}
```

**Response:**
```json
{
  "data": {
    "fromAccountTransaction": {
      "id": "transaction-uuid-1",
      "type": "transfer",
      "direction": "debit",
      "status": "completed",
      "amount": "50.0000",
      "currency": "USD"
    },
    "toAccountTransaction": {
      "id": "transaction-uuid-2",
      "type": "transfer",
      "direction": "credit",
      "status": "completed",
      "amount": "50.0000",
      "currency": "USD"
    }
  },
  "message": "Transfer successful."
}
```

**Features:**
- Atomic transactions (both succeed or both fail)
- Checks `availableBalance` before transfer
- Prevents self-transfers
- Instant settlement (no pending status)
- Creates linked transaction records

---

## 7. Admin Dashboard for Business Teams

### Transaction Monitoring

**Endpoint:** `GET /admin/transactions`

List all transactions with filtering and pagination for monitoring and analysis.

**Query Parameters:**
- `page` (number, default: 1): Page number
- `limit` (number, default: 50, max: 100): Items per page
- `userId` (UUID, optional): Filter by user
- `type` (enum, optional): Filter by type (deposit, withdrawal, transfer, payment, fee, refund)
- `currency` (string, optional): Filter by currency (3-letter code)
- `processor` (enum, optional): Filter by processor (braintree, stripe, adyen, razorpay)
- `startDate` (date, optional): Filter from date
- `endDate` (date, optional): Filter to date

**Example Request:**
```bash
GET /admin/transactions?type=deposit&currency=USD&processor=braintree&startDate=2024-01-01&page=1&limit=50
```

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
        "processorTransactionId": "braintree-abc123",
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

**Endpoint:** `GET /admin/fees/summary`

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

**Endpoint:** `GET /admin/fees/processor-breakdown`

Get detailed breakdown of fees by payment processor to compare costs.

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

---

## 8. Fee Configuration

The wallet service tracks two types of fees:

1. **Processor Fees** (stored in `transaction.fee` field): Fees charged by payment processors (Braintree, Stripe, etc.). This is our cost.
2. **Platform Fees** (future enhancement): Fees charged to users for using the service. This is our revenue.

**Current Implementation**:
- Processor fees are calculated and stored in the `fee` field
- Currently using an absorb model: we pay processor fees, users deposit full amount
- Example: User deposits $100 → Processor charges $3 → User receives $97 in wallet

**Recommended Configuration Approach**: Hybrid App-Level + User-Level

See `FEE-CONFIGURATION-GUIDE.md` for comprehensive documentation on:
- Fee models (absorb, pass-through, markup, flat fee)
- Configuration hierarchy (global → product → user tier → individual)
- Database schema for fee configuration
- Fee calculation logic
- Best practices and examples

**Quick Start:**
1. Begin with global (app-level) fee configuration for simplicity
2. Add user-level overrides for VIP/enterprise customers
3. Store configuration in database for runtime changes
4. Use Admin API to monitor fee performance

---

## 9. Additional Documentation

- **CLAUDE.md** - Complete architecture guide for developers
- **FEE-CONFIGURATION-GUIDE.md** - Comprehensive fee configuration strategy
- **FRONTEND-PAYMENT-INTEGRATION-GUIDE.md** - Frontend implementation guide with Svelte examples

---

## 10. Development Commands

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

---

## 11. Environment Variables

Required in `.env`:
```bash
DATABASE_URL=postgresql://user:password@localhost:5432/hyperpocket

# Braintree Payment Gateway
BRAINTREE_MERCHANT_ID=your_merchant_id
BRAINTREE_PUBLIC_KEY=your_public_key
BRAINTREE_PRIVATE_KEY=your_private_key
BRAINTREE_ENVIRONMENT=sandbox

# Multi-Currency Support (Optional)
BRAINTREE_MERCHANT_ACCOUNT_USD=
BRAINTREE_MERCHANT_ACCOUNT_THB=
BRAINTREE_MERCHANT_ACCOUNT_MYR=
BRAINTREE_MERCHANT_ACCOUNT_SGD=
```

---

## API Base URL

**Development:** `http://localhost:3000`
**Production:** `https://api.hyperpocket.com` (update in your .env)

---

## Support

For questions or issues:
1. Check CLAUDE.md for architecture details
2. Review FEE-CONFIGURATION-GUIDE.md for fee setup
3. See FRONTEND-PAYMENT-INTEGRATION-GUIDE.md for frontend integration
4. Contact the backend team
