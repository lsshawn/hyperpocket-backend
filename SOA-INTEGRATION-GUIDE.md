# Hyperpocket Wallet SOA - Integration Guide

**For:** Jayride, Drivemate, and other product apps integrating with Hyperpocket Wallet Service

**Version:** 1.0
**Last Updated:** 2025-11-07

---

## Table of Contents

1. [Overview](#overview)
2. [Quick Start](#quick-start)
3. [Authentication](#authentication)
4. [Core Integration Principles](#core-integration-principles)
5. [Integration Scenarios](#integration-scenarios)
   - [Ride-Hailing Flow](#scenario-1-ride-hailing-authorize-then-capture)
   - [Car Rental Flow](#scenario-2-car-rental-upfront-charge--deposit)
   - [Cash Transaction Flow](#scenario-3-cash-transactions)
   - [Driver/Host Settlement Flow](#scenario-4-driverhost-cash-collection--settlement)
6. [API Reference](#api-reference)
7. [Webhook Integration](#webhook-integration)
8. [Data Management Guidelines](#data-management-guidelines)
9. [Error Handling & Retries](#error-handling--retries)
10. [Testing](#testing)
11. [Support & FAQs](#support--faqs)

---

## Overview

Hyperpocket Wallet is a **Service-Oriented Architecture (SOA)** microservice that serves as the **Single Source of Truth** for all financial transactions across multiple product platforms (ride-hailing, car rentals, delivery, etc.).

### Key Benefits

- **Unified Financial Ledger**: One place for all money movements
- **Multi-Currency Support**: USD, THB, MYR, SGD, EUR, GBP, and more
- **Payment Gateway Agnostic**: Supports Braintree, Stripe, Adyen, Razorpay
- **Complex Payment Flows**: Authorization, capture, void, refund, partial capture
- **Settlement Tracking**: T+2 settlement with available balance management
- **Audit Trail**: Complete transaction history with platform references

---

## Quick Start

### Base URL

```
Production: https://wallet.hyperpocket.com
Staging: https://wallet-staging.hyperpocket.com
```

### Integration Checklist

- [ ] Obtain API credentials (API key will be provided)
- [ ] Set up webhook endpoint in your app
- [ ] Register webhook URL with Hyperpocket
- [ ] Implement idempotency key generation (use your booking IDs)
- [ ] Map your user IDs to Hyperpocket user IDs (must be consistent UUIDs)
- [ ] Test in sandbox environment
- [ ] Go live

---

## Authentication

**Current Status:** In development. For now, all endpoints are open (staging only).

**Future:** All requests will require an API key in the header:

```http
Authorization: Bearer YOUR_API_KEY
X-Product-Type: ride_hailing
```

---

## Core Integration Principles

### 1. API-Only Access ⚠️

**DO:**
- Call Wallet API endpoints for all payment operations
- Fetch wallet balances via API
- Store authorization IDs returned by our API

**DON'T:**
- Access Wallet database directly
- Store payment card details in your database
- Store transaction amounts or balances locally

### 2. User ID Consistency 🔑

The `userId` must be a **UUID** that is consistent across both your app's `users` table and Hyperpocket's `wallet` table.

**Example:**
```typescript
// Your database (JayRide)
users {
  id: "550e8400-e29b-41d4-a716-446655440000" // UUID
  name: "John Doe"
  email: "john@example.com"
}

// Hyperpocket Wallet (automatically created)
wallet {
  id: "auto-generated-uuid"
  userId: "550e8400-e29b-41d4-a716-446655440000" // SAME as your user.id
}
```

### 3. Idempotency Keys 🔁

Always include an `idempotencyKey` to prevent duplicate charges. Use your booking ID or a combination of booking ID + operation type.

**Example:**
```typescript
{
  "idempotencyKey": "booking-123-rental-fee",
  "idempotencyKey": "booking-123-deposit",
  "idempotencyKey": "ride-456-auth"
}
```

If you retry a request with the same idempotency key, you'll receive the same result without creating a duplicate transaction.

### 4. Multi-Product Tracking 🏷️

Always include these fields to track transactions back to your app:

```typescript
{
  "productType": "ride_hailing", // or "car_rental", "delivery"
  "sourceEntityType": "ride_request", // your database table name
  "sourceEntityId": "your-booking-uuid" // your booking ID
}
```

This enables:
- Cross-product transaction filtering
- Audit trails
- Support ticket resolution
- Accounting reports by product line

---

## Integration Scenarios

### Scenario 1: Ride-Hailing (Authorize Then Capture)

**Use Case:** Uber-style flow where you authorize payment when the ride starts, then capture the actual fare when the ride completes.

#### Flow Diagram

```
Passenger requests ride
    ↓
1. Authorize $50 (estimated max fare)
    ↓
Ride in progress...
    ↓
Ride completes (actual fare: $27.50)
    ↓
2. Capture $27.50 (actual fare)
    ↓
3. Release remaining $22.50 (automatically handled)
```

#### Implementation

**Step 1: Ride Starts - Authorize Payment**

```typescript
// When driver accepts ride and passenger gets in
const authResponse = await fetch('https://wallet.hyperpocket.com/payments/authorize', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    userId: ride.passengerId, // UUID from your users table
    amount: 50.00, // Estimated max fare
    currency: 'USD',
    paymentMethodNonce: ride.paymentMethodNonce, // From Braintree Drop-in UI
    productType: 'ride_hailing',
    sourceEntityType: 'ride_request',
    sourceEntityId: ride.id, // Your ride_requests.id
    description: 'Authorization for ride from Downtown to Airport',
    idempotencyKey: `${ride.id}-auth`
  })
});

const { data } = await authResponse.json();
// Store in your database
await db.rideRequests.update(ride.id, {
  paymentAuthorizationId: data.id, // Store this UUID
  authorizedAmount: data.authorizedAmount
});
```

**Step 2: Ride Completes - Capture Actual Fare**

```typescript
// When ride is marked complete
const captureResponse = await fetch('https://wallet.hyperpocket.com/payments/capture', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    authorizationId: ride.paymentAuthorizationId, // From Step 1
    amount: 27.50, // Actual fare calculated
    userId: ride.passengerId,
    currency: 'USD'
  })
});

const { data } = await captureResponse.json();
// Update your ride record
await db.rideRequests.update(ride.id, {
  status: 'completed',
  finalFare: 27.50,
  paymentStatus: 'captured'
});
```

**Step 3: Ride Cancelled - Void Authorization**

```typescript
// If ride is cancelled before completion
const voidResponse = await fetch('https://wallet.hyperpocket.com/payments/void', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    authorizationId: ride.paymentAuthorizationId,
    userId: ride.passengerId
  })
});

await db.rideRequests.update(ride.id, {
  status: 'cancelled',
  paymentStatus: 'voided'
});
```

#### What to Store in Your Database

```sql
-- In your ride_requests table
ALTER TABLE ride_requests ADD COLUMN payment_authorization_id UUID;
ALTER TABLE ride_requests ADD COLUMN payment_status VARCHAR(50);

-- DO NOT store: card details, actual transaction data, balances
-- ONLY store: authorization ID reference
```

---

### Scenario 2: Car Rental (Upfront Charge + Deposit)

**Use Case:** Hotel/rental-style flow where you charge the rental fee immediately and hold a security deposit that can be captured if there's damage.

#### Flow Diagram

```
Customer books car
    ↓
1. Charge $300 (3-day rental fee) - immediate
    ↓
2. Authorize $500 (security deposit) - hold only
    ↓
Rental period...
    ↓
Option A: Return without damage
    → 3A. Release $500 deposit
    ↓
Option B: Return with damage ($150 repair cost)
    → 3B. Capture $150 from deposit
    → 3C. Release remaining $350
```

#### Implementation

**Step 1: Booking Created - Charge Rental Fee**

```typescript
// When customer confirms booking
const chargeResponse = await fetch('https://wallet.hyperpocket.com/payments/charge', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    userId: booking.customerId,
    amount: 300.00, // 3-day rental fee
    currency: 'USD',
    paymentMethodNonce: booking.paymentMethodNonce,
    productType: 'car_rental',
    sourceEntityType: 'rental_booking',
    sourceEntityId: booking.id,
    description: '3-day rental: Toyota Camry',
    idempotencyKey: `${booking.id}-rental-fee`
  })
});

const chargeData = await chargeResponse.json();
// Store authorization ID
await db.rentalBookings.update(booking.id, {
  rentalFeeAuthId: chargeData.data.authorization.id
});
```

**Step 2: Booking Created - Hold Security Deposit**

```typescript
// Immediately after charging rental fee
const depositResponse = await fetch('https://wallet.hyperpocket.com/payments/authorize', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    userId: booking.customerId,
    amount: 500.00, // Security deposit
    currency: 'USD',
    paymentMethodNonce: booking.paymentMethodNonce,
    productType: 'car_rental',
    sourceEntityType: 'rental_deposit',
    sourceEntityId: booking.id,
    description: 'Security deposit for Toyota Camry',
    idempotencyKey: `${booking.id}-deposit`
  })
});

const depositData = await depositResponse.json();
// Store deposit authorization ID
await db.rentalBookings.update(booking.id, {
  depositAuthId: depositData.data.id
});
```

**Step 3A: Return Without Damage - Release Deposit**

```typescript
// When car is returned in good condition
const releaseResponse = await fetch('https://wallet.hyperpocket.com/payments/void', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    authorizationId: booking.depositAuthId,
    userId: booking.customerId
  })
});

await db.rentalBookings.update(booking.id, {
  status: 'completed',
  depositStatus: 'released'
});
```

**Step 3B: Return With Damage - Partial Capture**

```typescript
// When car has damage (e.g., scratch repair costs $150)
const damageResponse = await fetch('https://wallet.hyperpocket.com/payments/capture', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    authorizationId: booking.depositAuthId,
    amount: 150.00, // Actual damage cost
    userId: booking.customerId,
    currency: 'USD'
  })
});

// Remaining $350 is automatically released
await db.rentalBookings.update(booking.id, {
  status: 'completed',
  depositStatus: 'partially_captured',
  damageCharge: 150.00
});
```

**Step 4: Booking Cancelled - Refund + Release**

```typescript
// If customer cancels (50% refund per policy)
const refundResponse = await fetch('https://wallet.hyperpocket.com/payments/refund', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    authorizationId: booking.rentalFeeAuthId,
    amount: 150.00, // 50% of $300
    reason: 'Booking cancelled - 50% refund per cancellation policy',
    userId: booking.customerId,
    currency: 'USD'
  })
});

// Also release deposit
await fetch('https://wallet.hyperpocket.com/payments/void', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    authorizationId: booking.depositAuthId,
    userId: booking.customerId
  })
});

await db.rentalBookings.update(booking.id, {
  status: 'cancelled',
  refundAmount: 150.00
});
```

#### What to Store in Your Database

```sql
-- In your rental_bookings table
ALTER TABLE rental_bookings ADD COLUMN rental_fee_auth_id UUID;
ALTER TABLE rental_bookings ADD COLUMN deposit_auth_id UUID;
ALTER TABLE rental_bookings ADD COLUMN payment_status VARCHAR(50);
ALTER TABLE rental_bookings ADD COLUMN deposit_status VARCHAR(50);

-- DO NOT duplicate: transaction amounts, card details, balances
```

---

### Scenario 3: Cash Transactions

**Use Case:** Customer pays driver/host in cash. No money flows through payment gateways, but you still need to track it in the wallet for platform fee calculations.

#### When to Record Cash Transactions

**You SHOULD record cash in wallet when:**
- You need to calculate and collect platform fees from hosts/drivers
- You want unified reporting across cash and card transactions
- You need to track host/driver earnings for tax purposes

**You DON'T need to record cash when:**
- It's a pure peer-to-peer payment with zero platform involvement
- You're only tracking it in your own booking system

#### Implementation

**Option A: Track as Internal Record (Recommended)**

```typescript
// When ride/rental is completed with cash payment
await db.rideRequests.update(ride.id, {
  paymentMethod: 'cash',
  amount: 50.00,
  status: 'completed',
  platformFeeOwed: 7.50 // 15% of $50
});

// DO NOT call Wallet API
// Cash doesn't touch the wallet until settlement time
```

**Option B: Create Wallet Transaction for Audit Trail**

```typescript
// If you want full transaction history in wallet
const cashRecordResponse = await fetch('https://wallet.hyperpocket.com/admin/transactions/cash', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    userId: ride.driverId,
    amount: 50.00,
    currency: 'USD',
    productType: 'ride_hailing',
    sourceEntityType: 'ride_request',
    sourceEntityId: ride.id,
    description: 'Cash payment received from passenger',
    metadata: {
      cashCollected: true,
      platformFeeOwed: 7.50
    }
  })
});

// Note: This creates a record but does NOT affect driver's wallet balance
// The actual money is in driver's pocket
```

---

### Scenario 4: Driver/Host Cash Collection & Settlement

**Use Case:** Drivers/hosts collect cash from customers. They owe the platform a percentage. The platform needs to debit their wallet to collect platform fees.

#### Flow Diagram

```
Driver collects $1000 cash (20 rides x $50)
Platform fee: 15% = $150 owed
    ↓
Weekly Settlement Cycle
    ↓
1. Calculate total platform fees owed
    ↓
2. Create invoice in driver's account
    ↓
3. Debit driver's wallet for $150
    ↓
Option A: Driver has sufficient wallet balance
    → Debit successful, settlement complete
    ↓
Option B: Driver has insufficient balance
    → Send payment request or hold next card payment
```

#### Implementation

**Step 1: Calculate Weekly Fees Owed**

```typescript
// Run this weekly via cron job in YOUR app
const weekStart = new Date('2024-01-01');
const weekEnd = new Date('2024-01-07');

// Get all cash rides for this driver
const cashRides = await db.rideRequests.find({
  driverId: driver.id,
  paymentMethod: 'cash',
  completedAt: { between: [weekStart, weekEnd] },
  platformFeeCollected: false
});

const totalFees = cashRides.reduce((sum, ride) => sum + ride.platformFeeOwed, 0);
// Example: 20 rides x $7.50 fee = $150 owed
```

**Step 2: Debit Driver's Wallet**

```typescript
// Attempt to collect platform fees from driver's wallet
const debitResponse = await fetch('https://wallet.hyperpocket.com/wallets/withdraw', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    userId: driver.id,
    amount: totalFees, // $150
    currency: 'USD',
    productType: 'ride_hailing',
    sourceEntityType: 'platform_fee_settlement',
    sourceEntityId: generateSettlementId(), // Your settlement record ID
    description: `Weekly platform fees: ${weekStart} to ${weekEnd}`,
    idempotencyKey: `settlement-${driver.id}-${weekStart.toISOString()}`
  })
});

if (debitResponse.ok) {
  // Success - mark rides as settled
  await db.rideRequests.updateMany(
    cashRides.map(r => r.id),
    { platformFeeCollected: true }
  );
} else {
  // Insufficient balance - handle accordingly
  const error = await debitResponse.json();
  if (error.details === 'Insufficient available balance') {
    // Option 1: Create an invoice/debt record
    await db.driverDebts.create({
      driverId: driver.id,
      amountOwed: totalFees,
      dueDate: addDays(new Date(), 7)
    });

    // Option 2: Send payment request to driver
    await sendPaymentRequest(driver.id, totalFees);
  }
}
```

**Step 3: Alternative - Deduct from Next Card Payment**

```typescript
// When driver earns money from card payments
// You can automatically deduct outstanding fees

const cardRide = await db.rideRequests.findOne({ id: rideId });
const driverDebt = await db.driverDebts.findOne({ driverId: cardRide.driverId });

if (driverDebt && driverDebt.amountOwed > 0) {
  // Driver owes $150, this ride earns $50
  const driverEarnings = cardRide.amount * 0.85; // $42.50 after 15% fee
  const deductionAmount = Math.min(driverDebt.amountOwed, driverEarnings);

  // Transfer reduced amount to driver's wallet
  const transferResponse = await fetch('https://wallet.hyperpocket.com/wallets/transfer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: platformWalletId, // Your platform's wallet
      to: cardRide.driverId,
      amount: driverEarnings - deductionAmount, // Pay driver less
      currency: 'USD',
      description: `Ride earnings minus outstanding fees: $${deductionAmount}`
    })
  });

  // Update debt record
  await db.driverDebts.update(driverDebt.id, {
    amountOwed: driverDebt.amountOwed - deductionAmount
  });
}
```

#### Invoice System (Future Enhancement)

The wallet service will provide an invoice API for periodic billing:

```typescript
// Create invoice (future endpoint)
POST /admin/invoices
{
  "userId": "driver-uuid",
  "lineItems": [
    {
      "description": "Platform fee - Jan 1-7",
      "amount": 150.00,
      "sourceEntityType": "ride_request",
      "sourceEntityIds": ["ride-1", "ride-2", ...],
      "dueDate": "2024-01-14"
    }
  ]
}

// Auto-debit on due date via webhook
```

---

## API Reference

### Base URL

```
Production: https://wallet.hyperpocket.com
Staging: https://wallet-staging.hyperpocket.com
```

### Common Headers

```http
Content-Type: application/json
Authorization: Bearer YOUR_API_KEY (future)
X-Product-Type: ride_hailing
```

---

### Payment Operations

#### 1. Generate Client Token (for Drop-in UI)

Get a client token for Braintree/Stripe Drop-in UI to collect payment method.

```http
GET /payments/client-token?customerId={optional}
```

**Response:**
```json
{
  "data": {
    "clientToken": "eyJ2ZXJzaW9uIjoyLCJ..."
  },
  "message": "Client token generated successfully"
}
```

---

#### 2. Authorize Payment (Hold Funds)

Place a hold on customer's card. Use for ride-hailing or security deposits.

```http
POST /payments/authorize
```

**Request Body:**
```json
{
  "userId": "uuid",
  "amount": 50.00,
  "currency": "USD",
  "paymentMethodNonce": "nonce-from-drop-in-ui",
  "productType": "ride_hailing",
  "sourceEntityType": "ride_request",
  "sourceEntityId": "your-booking-uuid",
  "description": "Authorization for ride",
  "idempotencyKey": "booking-uuid-auth"
}
```

**Response:**
```json
{
  "data": {
    "id": "auth-uuid",
    "gatewayTransactionId": "bt-txn-id",
    "authorizedAmount": "50.00",
    "capturedAmount": "0.00",
    "remainingAmount": "50.00",
    "status": "authorized",
    "expiresAt": "2024-01-15T00:00:00Z"
  },
  "message": "Payment authorized successfully. Funds are on hold."
}
```

**Store:** `data.id` (authorization ID) in your booking record

---

#### 3. Charge Payment (Immediate Capture)

Immediately charge customer's card. Use for upfront rental fees.

```http
POST /payments/charge
```

**Request Body:**
```json
{
  "userId": "uuid",
  "amount": 300.00,
  "currency": "USD",
  "paymentMethodNonce": "nonce-from-drop-in-ui",
  "productType": "car_rental",
  "sourceEntityType": "rental_booking",
  "sourceEntityId": "your-booking-uuid",
  "description": "3-day rental: Toyota Camry",
  "idempotencyKey": "booking-uuid-rental-fee"
}
```

**Response:**
```json
{
  "data": {
    "authorization": {
      "id": "auth-uuid",
      "status": "captured",
      "capturedAmount": "300.00"
    },
    "transaction": {
      "id": "txn-uuid",
      "status": "pending"
    }
  },
  "message": "Payment charged successfully"
}
```

**Store:** `data.authorization.id` in your booking record

---

#### 4. Capture Payment (Full or Partial)

Capture funds from a previous authorization. Use after ride completes or for damage claims.

```http
POST /payments/capture
```

**Request Body:**
```json
{
  "authorizationId": "auth-uuid",
  "amount": 27.50,
  "userId": "uuid",
  "currency": "USD"
}
```

**Notes:**
- Omit `amount` for full capture
- Include `amount` for partial capture

**Response:**
```json
{
  "data": {
    "authorization": {
      "id": "auth-uuid",
      "capturedAmount": "27.50",
      "remainingAmount": "22.50",
      "status": "partially_captured"
    }
  },
  "message": "Payment captured successfully"
}
```

---

#### 5. Void Authorization (Release Hold)

Release funds held by an authorization. Use when ride is cancelled or rental ends without damage.

```http
POST /payments/void
```

**Request Body:**
```json
{
  "authorizationId": "auth-uuid",
  "userId": "uuid"
}
```

**Response:**
```json
{
  "data": {
    "authorization": {
      "id": "auth-uuid",
      "status": "voided"
    }
  },
  "message": "Authorization voided successfully"
}
```

---

#### 6. Refund Payment (Full or Partial)

Refund a captured payment. Use for cancellations.

```http
POST /payments/refund
```

**Request Body:**
```json
{
  "authorizationId": "auth-uuid",
  "amount": 150.00,
  "reason": "Booking cancelled - 50% refund per policy",
  "userId": "uuid",
  "currency": "USD"
}
```

**Notes:**
- Omit `amount` for full refund

**Response:**
```json
{
  "data": {
    "refund": {
      "id": "refund-uuid",
      "refundAmount": "150.00",
      "status": "completed"
    }
  },
  "message": "Refund processed successfully"
}
```

---

### Wallet Operations

#### 7. Get Wallet Balance

Retrieve user's wallet balance. Use for displaying available funds.

```http
GET /wallets?userId={uuid}&currency={USD}
```

**Response:**
```json
{
  "data": {
    "id": "account-uuid",
    "currency": "USD",
    "balance": "500.0000",
    "availableBalance": "450.0000"
  },
  "message": "Wallet account fetched successfully"
}
```

**Note:** `availableBalance` excludes pending/unsettled funds. Use this for withdrawal limits.

---

#### 8. Transfer Funds (Internal)

Transfer money between two users' wallets. Use for referral bonuses, tips, etc.

```http
POST /wallets/transfer
```

**Request Body:**
```json
{
  "from": "sender-user-uuid",
  "to": "receiver-user-uuid",
  "amount": 10.00,
  "currency": "USD"
}
```

**Response:**
```json
{
  "data": {
    "transfer": {
      "id": "transfer-uuid",
      "debitTransaction": { "id": "txn-1" },
      "creditTransaction": { "id": "txn-2" }
    }
  },
  "message": "Transfer successful"
}
```

---

#### 9. Withdraw Funds (Debit Wallet)

Debit a user's wallet. Use for platform fee collection.

```http
POST /wallets/withdraw
```

**Request Body:**
```json
{
  "userId": "uuid",
  "amount": 150.00,
  "currency": "USD"
}
```

**Response:**
```json
{
  "data": {
    "transaction": {
      "id": "txn-uuid",
      "type": "withdrawal",
      "netAmount": "150.00",
      "status": "completed"
    }
  },
  "message": "Withdrawal successful"
}
```

**Error (400):**
```json
{
  "error": "Withdrawal failed",
  "details": "Insufficient available balance"
}
```

---

#### 10. Deposit Funds (Credit Wallet)

Add funds to user's wallet via payment gateway.

```http
POST /wallets/deposit/payment
```

**Request Body:**
```json
{
  "userId": "uuid",
  "amount": 100.00,
  "currency": "USD",
  "paymentMethod": "credit_card",
  "paymentMethodNonce": "nonce-from-drop-in-ui",
  "country": "US",
  "processorType": "braintree",
  "productType": "ride_hailing",
  "sourceEntityType": "wallet_topup",
  "sourceEntityId": "topup-uuid",
  "description": "Wallet top-up",
  "idempotencyKey": "topup-uuid"
}
```

**Response:**
```json
{
  "data": {
    "transaction": {
      "id": "txn-uuid",
      "status": "pending",
      "netAmount": "96.80"
    }
  },
  "message": "Deposit processed successfully. Funds will be available after settlement."
}
```

---

#### 11. Get Authorization Details

Retrieve details of a specific payment authorization.

```http
GET /payments/{authorizationId}
```

**Response:**
```json
{
  "data": {
    "id": "auth-uuid",
    "userId": "user-uuid",
    "authorizedAmount": "50.00",
    "capturedAmount": "27.50",
    "remainingAmount": "22.50",
    "status": "partially_captured",
    "productType": "ride_hailing",
    "sourceEntityType": "ride_request",
    "sourceEntityId": "ride-uuid",
    "createdAt": "2024-01-01T10:00:00Z"
  }
}
```

---

#### 12. Get Authorizations by Booking

Get all payment authorizations for a specific booking.

```http
GET /payments/by-source?sourceEntityId={booking-uuid}
```

**Use Case:** Retrieve all payment records (rental fee + deposit) for a booking.

**Response:**
```json
{
  "data": [
    {
      "id": "auth-1",
      "sourceEntityType": "rental_booking",
      "authorizedAmount": "300.00",
      "description": "3-day rental fee"
    },
    {
      "id": "auth-2",
      "sourceEntityType": "rental_deposit",
      "authorizedAmount": "500.00",
      "description": "Security deposit"
    }
  ]
}
```

---

## Webhook Integration

Webhooks notify your app of asynchronous events like settlement completion, disputes, and refunds.

### Setup

1. **Create a webhook endpoint** in your app:
   ```
   https://your-app.com/webhooks/hyperpocket
   ```

2. **Register with Hyperpocket** (provide your URL to support)

3. **Implement webhook handler** (see below)

### Webhook Events

| Event | Description | Action Required |
|-------|-------------|-----------------|
| `transaction_settled` | Payment cleared after T+2 | Update booking status to "paid" |
| `transaction_settlement_declined` | Payment failed after initial success | Cancel booking, notify user |
| `dispute_opened` | Customer initiated chargeback | Flag booking for review |
| `dispute_lost` | Chargeback won by customer | Reverse payment, update records |
| `dispute_won` | Chargeback won by merchant | No action needed |
| `transaction_disbursed` | Funds transferred to your account | Log for accounting |

### Webhook Payload

```json
{
  "event": "transaction_settled",
  "timestamp": "2024-01-03T12:00:00Z",
  "data": {
    "authorizationId": "auth-uuid",
    "transactionId": "txn-uuid",
    "amount": "300.00",
    "currency": "USD",
    "productType": "car_rental",
    "sourceEntityType": "rental_booking",
    "sourceEntityId": "your-booking-uuid",
    "status": "settled"
  }
}
```

### Implementation Example

```typescript
// In your webhook endpoint
app.post('/webhooks/hyperpocket', async (req, res) => {
  const { event, data } = req.body;

  switch (event) {
    case 'transaction_settled':
      // Payment cleared - finalize booking
      await db.rentalBookings.update(data.sourceEntityId, {
        paymentStatus: 'settled',
        settledAt: new Date()
      });

      // Notify host that payment is confirmed
      await notifyHost(data.sourceEntityId, 'Payment confirmed');
      break;

    case 'transaction_settlement_declined':
      // Payment failed after T+2 - cancel booking
      await db.rentalBookings.update(data.sourceEntityId, {
        status: 'cancelled',
        paymentStatus: 'failed',
        cancellationReason: 'Payment settlement declined'
      });

      // Notify customer and host
      await notifyCustomerAndHost(data.sourceEntityId, 'Payment failed');
      break;

    case 'dispute_opened':
      // Customer disputed charge - flag for review
      await db.rentalBookings.update(data.sourceEntityId, {
        disputeStatus: 'under_review',
        disputeOpenedAt: new Date()
      });

      // Alert support team
      await alertSupport(`Dispute opened for booking ${data.sourceEntityId}`);
      break;

    case 'dispute_lost':
      // Lost dispute - reverse payment
      await db.rentalBookings.update(data.sourceEntityId, {
        paymentStatus: 'reversed',
        disputeStatus: 'lost'
      });
      break;
  }

  // Always respond 200 to acknowledge receipt
  res.status(200).json({ received: true });
});
```

### Webhook Security

**Future:** Webhooks will include a signature for verification:

```typescript
const crypto = require('crypto');

function verifyWebhookSignature(payload, signature, secret) {
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

// In your webhook handler
if (!verifyWebhookSignature(req.body, req.headers['x-hyperpocket-signature'], WEBHOOK_SECRET)) {
  return res.status(401).json({ error: 'Invalid signature' });
}
```

### Retry Logic

If your webhook endpoint is down, Hyperpocket will retry:
- Immediate retry
- After 5 minutes
- After 1 hour
- After 24 hours

Always return `200 OK` quickly. Process webhooks asynchronously if needed.

---

## Data Management Guidelines

### What to Store in Your Database

✅ **DO Store:**
- Authorization IDs (UUIDs) returned by Wallet API
- Payment status flags (`pending`, `captured`, `voided`)
- Idempotency keys you generated
- Your booking/ride details (dates, amounts, descriptions)

### What NOT to Store

❌ **DON'T Store:**
- Credit card numbers, CVV, expiration dates
- Payment method nonces (use once and discard)
- Transaction amounts or balances from Wallet
- Settlement dates or status (fetch via API)

### Example Schema

```sql
-- GOOD: Minimal payment references
CREATE TABLE rental_bookings (
  id UUID PRIMARY KEY,
  customer_id UUID NOT NULL,
  host_id UUID NOT NULL,

  -- Booking details (your domain)
  vehicle_id UUID NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  rental_fee DECIMAL(10, 2) NOT NULL,
  deposit_amount DECIMAL(10, 2) NOT NULL,

  -- Payment references (from Wallet API)
  rental_fee_auth_id UUID, -- From /payments/charge response
  deposit_auth_id UUID,     -- From /payments/authorize response

  -- Status flags
  payment_status VARCHAR(50), -- 'pending', 'captured', 'settled', 'failed'
  deposit_status VARCHAR(50), -- 'held', 'released', 'captured', 'voided'

  -- Metadata
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- BAD: Duplicating wallet data
CREATE TABLE rental_bookings_bad (
  -- ... other fields ...

  card_number VARCHAR(16), -- ❌ PCI compliance violation
  card_cvv VARCHAR(4),     -- ❌ Never store CVV
  wallet_balance DECIMAL,  -- ❌ Fetch via API instead
  transaction_amount DECIMAL, -- ❌ Already stored in Wallet
  settlement_date TIMESTAMP -- ❌ Get from webhook
);
```

### Fetching Fresh Data

Always fetch current state from Wallet API when displaying to users:

```typescript
// GOOD: Fetch latest balance
async function getDriverDashboard(driverId) {
  const balanceResponse = await fetch(
    `https://wallet.hyperpocket.com/wallets?userId=${driverId}&currency=USD`
  );
  const { data } = await balanceResponse.json();

  return {
    driverId,
    name: driver.name,
    availableBalance: data.availableBalance, // Fresh from API
    pendingBalance: data.balance - data.availableBalance
  };
}

// BAD: Using stale data
async function getDriverDashboardBad(driverId) {
  const driver = await db.drivers.findOne({ id: driverId });
  return {
    availableBalance: driver.wallet_balance // ❌ Stale and out of sync
  };
}
```

---

## Error Handling & Retries

### HTTP Status Codes

| Code | Meaning | Action |
|------|---------|--------|
| `200` | Success | Process response |
| `201` | Created | Resource created successfully |
| `400` | Bad Request | Fix request parameters, don't retry |
| `401` | Unauthorized | Check API key |
| `404` | Not Found | Resource doesn't exist |
| `409` | Conflict | Duplicate idempotency key (safe to ignore) |
| `500` | Server Error | Retry with exponential backoff |
| `503` | Service Unavailable | Retry with exponential backoff |

### Common Errors

#### Insufficient Balance

```json
{
  "error": "Withdrawal failed",
  "details": "Insufficient available balance"
}
```

**Action:** Display error to user or create debt record for drivers.

#### Invalid Authorization

```json
{
  "error": "Capture failed",
  "details": "Authorization not found or already fully captured"
}
```

**Action:** Check authorization status via `GET /payments/{authorizationId}`.

#### Duplicate Request

```json
{
  "error": "Conflict",
  "details": "Idempotency key already used"
}
```

**Action:** This is safe - the original request succeeded. Fetch the result using your stored authorization ID.

### Retry Strategy

Use exponential backoff for network errors and 5xx responses:

```typescript
async function callWalletAPI(url, options, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);

      // Success or client error (don't retry)
      if (response.ok || response.status < 500) {
        return response;
      }

      // Server error - retry with backoff
      if (attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        console.log(`Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    } catch (error) {
      // Network error - retry
      if (attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt) * 1000;
        await sleep(delay);
      } else {
        throw error;
      }
    }
  }

  throw new Error('Max retries exceeded');
}
```

### Idempotency Safety

Thanks to idempotency keys, you can safely retry any request:

```typescript
const idempotencyKey = `booking-${booking.id}-rental-fee`;

// First attempt fails due to network error
await callWalletAPI('/payments/charge', {
  method: 'POST',
  body: JSON.stringify({
    ...paymentData,
    idempotencyKey
  })
});

// Retry with SAME idempotency key
// If first request actually succeeded, you'll get the same result
await callWalletAPI('/payments/charge', {
  method: 'POST',
  body: JSON.stringify({
    ...paymentData,
    idempotencyKey // Same key = safe retry
  })
});
```

---

## Testing

### Sandbox Environment

```
Base URL: https://wallet-staging.hyperpocket.com
```

### Test Payment Method Nonces

Use these nonces instead of real card data:

| Nonce | Result |
|-------|--------|
| `fake-valid-nonce` | Success |
| `fake-processor-declined-visa-nonce` | Card declined |
| `fake-processor-failure-nonce` | Processor error |
| `fake-valid-discover-nonce` | Success (Discover card) |

### Test Cards (Braintree Sandbox)

**Successful transactions:**
```
Card: 4111 1111 1111 1111 (Visa)
Card: 5555 5555 5555 4444 (Mastercard)
CVV: 123
Exp: Any future date
```

### Test Scenarios

#### Ride-Hailing Flow

```bash
# 1. Authorize $50 for ride
curl -X POST https://wallet-staging.hyperpocket.com/payments/authorize \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "test-user-uuid",
    "amount": 50.00,
    "currency": "USD",
    "paymentMethodNonce": "fake-valid-nonce",
    "productType": "ride_hailing",
    "sourceEntityType": "ride_request",
    "sourceEntityId": "ride-test-123",
    "idempotencyKey": "ride-test-123-auth"
  }'

# Save the authorization ID from response

# 2. Capture $27.50 (actual fare)
curl -X POST https://wallet-staging.hyperpocket.com/payments/capture \
  -H "Content-Type: application/json" \
  -d '{
    "authorizationId": "AUTH_ID_FROM_STEP_1",
    "amount": 27.50,
    "userId": "test-user-uuid",
    "currency": "USD"
  }'
```

#### Car Rental Flow

```bash
# 1. Charge rental fee
curl -X POST https://wallet-staging.hyperpocket.com/payments/charge \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "test-user-uuid",
    "amount": 300.00,
    "currency": "USD",
    "paymentMethodNonce": "fake-valid-nonce",
    "productType": "car_rental",
    "sourceEntityType": "rental_booking",
    "sourceEntityId": "rental-test-456",
    "idempotencyKey": "rental-test-456-fee"
  }'

# 2. Hold security deposit
curl -X POST https://wallet-staging.hyperpocket.com/payments/authorize \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "test-user-uuid",
    "amount": 500.00,
    "currency": "USD",
    "paymentMethodNonce": "fake-valid-nonce",
    "productType": "car_rental",
    "sourceEntityType": "rental_deposit",
    "sourceEntityId": "rental-test-456",
    "idempotencyKey": "rental-test-456-deposit"
  }'

# 3. Capture damage amount
curl -X POST https://wallet-staging.hyperpocket.com/payments/capture \
  -H "Content-Type: application/json" \
  -d '{
    "authorizationId": "DEPOSIT_AUTH_ID",
    "amount": 150.00,
    "userId": "test-user-uuid",
    "currency": "USD"
  }'
```

### Webhook Testing

Use a tool like [ngrok](https://ngrok.com/) to expose your local webhook endpoint:

```bash
ngrok http 3000

# Register webhook URL
https://your-ngrok-url.ngrok.io/webhooks/hyperpocket
```

---

## Support & FAQs

### Contact

- **Email:** support@hyperpocket.com
- **Slack:** #wallet-integration (request access)
- **Documentation:** https://docs.hyperpocket.com

### FAQs

**Q: Do I need to store user's wallet balance in my database?**

A: No! Always fetch balance via `GET /wallets?userId={uuid}`. Your database should only store authorization IDs returned by our API.

---

**Q: What happens if a payment settles after T+2 but the booking was already completed?**

A: Our webhook will notify you of the `transaction_settled` event. Update your booking record's `paymentStatus` to `'settled'` for accounting purposes. The booking itself remains completed.

---

**Q: Can I partially capture an authorization multiple times?**

A: Yes! You can capture up to the `remainingAmount` in multiple calls. For example:
- Authorize: $500
- Capture 1: $100 → Remaining: $400
- Capture 2: $150 → Remaining: $250
- Void: Release remaining $250

---

**Q: What if a driver owes platform fees but has $0 wallet balance?**

A: You have several options:
1. Create a debt record in your system and collect on next earning
2. Send a payment request for the driver to top up their wallet
3. Withhold payouts until fees are paid
4. Automatically deduct from next card payment (see Scenario 4)

---

**Q: Should I record cash transactions in the wallet?**

A: Only if you need unified reporting. For simple cases, track cash in your own database and only use the wallet API to collect platform fees during settlement.

---

**Q: How do I handle refunds for cash transactions?**

A: Cash refunds happen outside the wallet system. Track them in your own database. If you collected platform fees for that transaction, you may need to credit the driver's wallet using `/wallets/deposit`.

---

**Q: Can I support multiple currencies for the same user?**

A: Yes! Users automatically get separate wallet accounts for each currency (USD, THB, MYR, etc.). Just specify the `currency` parameter in API calls.

---

**Q: What's the difference between `balance` and `availableBalance`?**

A:
- `balance`: Total funds including pending deposits (not yet settled)
- `availableBalance`: Only settled funds that can be withdrawn

Always use `availableBalance` for withdrawal limits.

---

**Q: How long does it take for authorized funds to be captured?**

A: Captures are processed immediately by the payment gateway. However, settlement (when funds actually move) takes T+2 business days.

---

**Q: What if a customer disputes a charge 3 months later?**

A: The `dispute_opened` webhook will notify you. The wallet service will automatically reverse the transaction if you lose the dispute (`dispute_lost` webhook). Update your booking records accordingly.

---

**Q: Can I get a list of all transactions for a user?**

A: Yes! Use the Admin API:
```
GET /admin/transactions?userId={uuid}&startDate={date}&endDate={date}
```

---

**Q: How do I test webhook events without waiting for actual settlement?**

A: Use the Braintree/Stripe sandbox webhook simulator to trigger test events. Contact support for webhook simulation credentials.

---

**Q: What's the authorization expiration time?**

A: Authorizations typically expire after 7 days (Braintree) or 7-30 days (depending on processor). Always capture or void within 24-48 hours for ride-hailing use cases.

---

**Q: Can I update an authorization amount after it's created?**

A: No. If the fare estimate changes significantly, void the old authorization and create a new one.

---

**Q: Do I need separate API keys for production and staging?**

A: Yes. Use staging API keys for development/testing and production API keys for live traffic. Never use production keys in staging environments.

---

## Appendix: Complete Integration Checklist

### Pre-Launch

- [ ] Environment setup
  - [ ] Staging API credentials obtained
  - [ ] Production API credentials obtained
  - [ ] Base URLs configured
- [ ] User ID mapping
  - [ ] User IDs are UUIDs in your database
  - [ ] User IDs are consistent with wallet service
- [ ] Payment UI
  - [ ] Braintree/Stripe Drop-in UI integrated
  - [ ] Client token generation endpoint called
  - [ ] Payment method nonces captured
- [ ] Idempotency implementation
  - [ ] Unique keys generated for each booking
  - [ ] Keys include booking ID + operation type
  - [ ] Retry logic uses same key
- [ ] Database schema
  - [ ] Authorization ID columns added to bookings
  - [ ] Payment status fields added
  - [ ] NO sensitive payment data stored

### Ride-Hailing Apps

- [ ] Ride start: Authorize payment
- [ ] Ride complete: Capture actual fare
- [ ] Ride cancelled: Void authorization
- [ ] Display available balance to drivers
- [ ] Platform fee collection for cash rides

### Car Rental Apps

- [ ] Booking created: Charge rental fee
- [ ] Booking created: Authorize deposit
- [ ] Return without damage: Void deposit
- [ ] Return with damage: Partial capture from deposit
- [ ] Booking cancelled: Refund + void deposit

### Webhook Integration

- [ ] Webhook endpoint created
- [ ] Webhook URL registered with Hyperpocket
- [ ] `transaction_settled` handler implemented
- [ ] `transaction_settlement_declined` handler implemented
- [ ] `dispute_opened` handler implemented
- [ ] `dispute_lost` handler implemented
- [ ] Webhook signature verification (when available)
- [ ] Retry logic with exponential backoff

### Testing

- [ ] Sandbox environment tested
- [ ] Test nonces working
- [ ] Successful authorization flow tested
- [ ] Capture flow tested (full and partial)
- [ ] Void flow tested
- [ ] Refund flow tested
- [ ] Insufficient balance error handled
- [ ] Duplicate request (409) handled
- [ ] Network retry logic tested
- [ ] Webhook events simulated and handled

### Production Readiness

- [ ] API keys switched to production
- [ ] Webhook URL pointing to production endpoint
- [ ] Error monitoring configured
- [ ] Transaction logging implemented
- [ ] Support team trained on wallet integration
- [ ] Runbook created for common issues
- [ ] Monitoring alerts configured

---

## Changelog

**v1.0 - 2025-11-07**
- Initial release
- Ride-hailing integration guide
- Car rental integration guide
- Cash transaction handling
- Driver settlement flows
- Complete API reference
- Webhook integration guide

---

**Need Help?** Contact us at support@hyperpocket.com or join our Slack channel #wallet-integration
