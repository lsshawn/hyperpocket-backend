
## Handling Delayed Payouts

This is a core concept of financial ledger design: handling funds that are in-flight.

For a scenario with delayed payouts from a payment gateway like Stripe, it is best practice to credit the user's wallet immediately but distinguish between funds that are pending and funds that are available to spend. This gives the user immediate feedback that their deposit was successful, while protecting your system from letting them spend money you haven't actually received yet.

To achieve this, we can introduce an `availableBalance` to the `walletAccount`. Here's how it would work:

 1 Ledger Balance vs. Available Balance: The existing balance column will act as the ledger balance, which includes all funds (pending + available). We'll add a new availableBalance column for funds that have been settled and are spendable.
 2 Deposit Flow: When a user deposits money via Stripe, a transaction is created with a pending status. The deposited amount is added to their `walletAccount.balance`, but not to their `availableBalance`.
 3 Settlement Flow: When Stripe pays out the funds to you (e.g., 5 days later), you'll update the original transaction status to completed and add the amount to the user's `walletAccount.availableBalance`.

This way, the funds are always associated with the user's wallet, answering your question.

You don't need a separate "master wallet" table in your schema; this accounting model handles it cleanly.


I've summarized the architectural plan and provided clear scenarios with the corresponding API calls and ledger transactions for your backend developer.

---

## 1. Architectural Strategy: Wallet Microservice

The core strategy is **Service-Oriented Architecture (SOA)**, positioning the **Wallet Service** as the **Single Source of Truth** for all monetary logic.

| Component | Responsibility | Interaction |
| :--- | :--- | :--- |
| **Core App (Ride/Rental)** | Bookings, Vehicle management, Driver dispatch, User authentication. | Initiates requests (e.g., "Charge Customer," "Pay Host") to the Wallet API. **Does NOT access the Wallet DB.** |
| **Wallet Service** | **Balances**, Financial Transactions, Payment Gateways, Payouts, Invoicing, Settlements. | Exposes a secure API (REST/gRPC) to the Core App. Uses **non-blocking asynchronous processing** for money movement. |

### Key Data References

* **User ID:** The `user.id` (UUID) must be globally consistent across both the Core App's `users` table and the Wallet Service's `wallet` and `transactions` tables.
* **Decoupling:** All links from Core App entities (like `bookings`) to Wallet entities (like `transactions`, `payments`) must use **non-foreign key UUIDs** (e.g., `depositTransactionId: uuid('...')` in the `bookings` table) managed by the Wallet Service.

---

## 2. API & Transaction Scenarios

The Wallet Service will expose clear, single-purpose endpoints. The developer must ensure **idempotency** for all charge and credit operations using a unique request key (e.g., the Booking ID).

### Scenario A: Credit Card Upfront Payment + Deposit Pre-Auth

**Objective:** Capture rental price immediately (T+2 settlement) and place a hold for the security deposit.

| Step | Initiator | API Call to Wallet Service | Wallet DB Action (`transactions` table) |
| :--- | :--- | :--- | :--- |
| **1. Charge Rental** | Core App (Booking) | `POST /payments/capture` (Body: `userId`, `amount`, `paymentMethodId`, **`bookingId`**) | **Txn 1 (Rental):** `type='payment'`, `direction='credit'`, `status='completed'`, `netAmount=$97`, `settledAt=T+2` |
| **2. Pre-Authorize Deposit** | Core App (Booking) | `POST /payments/preauthorize` (Body: `userId`, `amount`, `paymentMethodId`, **`bookingId`**) | **Txn 2 (Deposit Hold):** `type='deposit'`, `direction='credit'`, `status='pending'`, `netAmount=$50` |
| **3. Booking Complete** | Core App (Checkout) | `POST /payments/release` (Body: **`transactionId: Txn 2 ID`**) | **Txn 2 Update:** `status='cancelled'` |
| **3B. OR Claim Damage** | Core App (Checkout) | `POST /payments/capturePartial` (Body: **`transactionId: Txn 2 ID`**, `claimAmount: $20`) | **Txn 3 (Claim):** `type='payment'`, `direction='credit'`, `status='completed'`, `netAmount=$20`, `settledAt=T+2` (Updates original Txn 2 based on gateway response). |

---

### Scenario B: Cash/Bank Transfer to Host + Weekly Settlement

**Objective:** Platform receives no money upfront. Invoice Host weekly for the platform fee, then debit their Wallet Account to clear the invoice.

| Step | Initiator | API Call/System Action | Wallet DB Action (`transactions` table) |
| :--- | :--- | :--- | :--- |
| **1. Booking Complete** | Core App (Booking) | **No API Call.** Host receives cash. Core App records `paymentMethod='cash'`. | **No Transaction.** |
| **2. Weekly Invoicing** | Wallet Service (CRON) | **Internal:** Creates `invoice` entity linked to fee-owing bookings. | **Invoice Table:** New row for platform fees due. |
| **3. Debit Host** | Wallet Service (CRON) | **Internal:** Finds Host's `walletAccount` and executes an internal transfer/debit. | **Txn 4 (Fee Debit):** `type='fee'`, `direction='debit'`, `status='completed'`, `netAmount=$50` (Total fees owed). |

---

## 3. Mandatory Multi-Product Schema Enhancements

To support multiple products sharing the same Wallet, add the following fields to the Wallet Service's **`transactions` table**:

| Column Name | Data Type & Example | Rationale |
| :--- | :--- | :--- |
| **`product_type`** | `pgEnum('ride_hailing', 'rental', 'delivery')` | Identifies the top-level business context for accounting and filtering. |
| **`source_entity_type`** | `text` (e.g., 'rental\_booking', 'food\_order') | Identifies the table in the originating product's database. |
| **`source_entity_id`** | `uuid` | The foreign key (UUID) of the entity in the originating product's database (e.g., `bookings.id` from the Core App). |
| **`platform_ref`** | `text` or `uuid` (Unique Index) | A system-generated, globally unique reference for all high-value events for support and audit logs. |

---

## 4. Wallet Balance Retrieval

Any Core App component (e.g., a dashboard, a driver app) needing a balance check must use a dedicated API endpoint:

| Action | Initiator | API Call to Wallet Service | Core App Display |
| :--- | :--- | :--- | :--- |
| **Get Host Balance** | Core App (Driver UI) | `GET /wallets/accounts/{userId}` | **Available Balance:** Sum of `availableBalance` from all currency accounts. |

---

