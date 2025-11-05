# Payment Gateway Frontend Integration Guide

**Version:** 1.0
**Last Updated:** 2025-11-05
**Target:** Svelte/SvelteKit Applications
**Backend API:** Hyperpocket Wallet Service

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Prerequisites](#prerequisites)
4. [API Reference](#api-reference)
5. [Component Specifications](#component-specifications)
6. [Step-by-Step Implementation](#step-by-step-implementation)
7. [Payment Flows](#payment-flows)
8. [Error Handling](#error-handling)
9. [Security Considerations](#security-considerations)
10. [Testing](#testing)
11. [Deployment](#deployment)

---

## Overview

### Purpose

This document provides complete specifications for implementing a payment gateway UI that integrates with the Hyperpocket Wallet Service (SOA backend). The UI will support three payment methods:

1. **Wallet** - Internal wallet balance
2. **Credit Card** - Via Braintree payment gateway
3. **Bank Transfer** - Placeholder for future implementation

### Design Principles

- **Reusable Components** - Build once, use across all products (ride-hailing, car rental, delivery)
- **API-First** - All payment logic handled by backend SOA
- **Secure** - Never store sensitive payment data in frontend
- **User-Friendly** - Clear error messages, loading states, success confirmations

---

## Architecture

### System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Frontend Apps                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │ Ride-Hailing │  │  Car Rental  │  │   Delivery   │     │
│  │   (Svelte)   │  │   (Svelte)   │  │   (Svelte)   │     │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘     │
│         │                  │                  │              │
│         └──────────────────┼──────────────────┘              │
│                            │                                 │
│                   ┌────────▼────────┐                       │
│                   │ Payment Gateway │                       │
│                   │   Components    │                       │
│                   └────────┬────────┘                       │
└────────────────────────────┼──────────────────────────────┘
                             │
                             │ HTTPS/REST
                             │
                   ┌─────────▼─────────┐
                   │  Wallet Service   │
                   │   (Hono/Node.js)  │
                   │  Port: 3000       │
                   └─────────┬─────────┘
                             │
                   ┌─────────▼─────────┐
                   │    PostgreSQL     │
                   └───────────────────┘
```

### Component Structure

```
src/lib/components/payment/
├── PaymentGateway.svelte          # Main component - payment method selector
├── WalletPayment.svelte           # Wallet payment form
├── CreditCardPayment.svelte       # Credit card (Braintree Drop-in)
├── BankTransferPayment.svelte     # Bank transfer (placeholder)
├── types.ts                       # TypeScript interfaces
├── api/
│   ├── wallet-api.ts              # Wallet API client
│   ├── payment-api.ts             # Payment API client
│   └── braintree.ts               # Braintree client token
└── utils/
    ├── formatters.ts              # Currency formatting
    └── validators.ts              # Input validation
```

---

## Prerequisites

### 1. Environment Variables

Add to your `.env` file:

```bash
# Wallet API Base URL
PUBLIC_WALLET_API_URL=http://localhost:3000
# For production: https://wallet-api.yourcompany.com

# Braintree (loaded dynamically from backend)
# No client-side Braintree keys needed!
```

### 2. Install Dependencies

```bash
# For Braintree Drop-in UI
npm install braintree-web-drop-in

# For TypeScript types
npm install -D @types/braintree-web-drop-in

# For currency formatting (optional)
npm install currency.js
```

### 3. CORS Configuration

Ensure your backend has your frontend origin in CORS config:

```typescript
// Backend: src/index.ts
cors({
  origin: [
    'http://localhost:5173',        // Your local dev
    'https://yourapp.com',          // Production
  ],
  credentials: true,
})
```

---

## API Reference

### Base URL

- **Development:** `http://localhost:3000`
- **Production:** `https://wallet-api.yourcompany.com`

### Authentication

Currently, the API uses `userId` parameter. In production, you should:
- Add JWT authentication
- Include `Authorization: Bearer <token>` header
- Backend validates user from token

### Endpoints Used by Payment Gateway

#### 1. Get Wallet Balance

```http
GET /wallets?userId={userId}&currency={currency}
```

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| userId | UUID | Yes | Current user's ID |
| currency | string | No | 3-letter currency code (default: USD) |

**Response:**
```json
{
  "data": {
    "id": "wallet-uuid",
    "userId": "user-uuid",
    "currency": "USD",
    "balance": "150.0000",
    "availableBalance": "150.0000",
    "createdAt": "2025-11-05T10:00:00Z",
    "updatedAt": "2025-11-05T10:00:00Z"
  },
  "message": "Wallet account fetched successfully"
}
```

**TypeScript Interface:**
```typescript
interface WalletBalanceResponse {
  data: {
    id: string;
    userId: string;
    currency: string;
    balance: string;
    availableBalance: string;
    createdAt: string;
    updatedAt: string;
  };
  message: string;
}
```

---

#### 2. Get Braintree Client Token

```http
GET /payments/client-token?customerId={customerId}
```

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| customerId | string | No | Braintree customer ID (optional) |

**Response:**
```json
{
  "data": {
    "clientToken": "eyJ2ZXJzaW9uIjoyLCJhdXRob3JpemF0aW9uRmluZ2VycHJpbnQi..."
  },
  "message": "Client token generated successfully"
}
```

**Usage:**
This token is required to initialize Braintree Drop-in UI.

---

#### 3. Charge Payment (Immediate)

```http
POST /payments/charge
Content-Type: application/json
```

**Request Body:**
```json
{
  "userId": "user-uuid",
  "amount": 100.00,
  "currency": "USD",
  "paymentMethodNonce": "fake-valid-nonce",
  "productType": "ride_hailing",
  "sourceEntityType": "ride_request",
  "sourceEntityId": "booking-uuid",
  "description": "Payment for ride #12345",
  "idempotencyKey": "booking-uuid-payment",
  "country": "US"
}
```

**Request Parameters:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| userId | UUID | Yes | User making the payment |
| amount | number | Yes | Payment amount |
| currency | string | Yes | 3-letter currency code (USD, THB, MYR) |
| paymentMethodNonce | string | Yes* | Braintree payment nonce (*not needed for wallet) |
| productType | enum | Yes | 'ride_hailing', 'car_rental', 'delivery' |
| sourceEntityType | string | Yes | e.g., 'ride_request', 'rental_booking' |
| sourceEntityId | UUID | Yes | Booking/order ID from your app |
| description | string | No | Payment description |
| idempotencyKey | string | Yes | Unique key to prevent duplicates |
| country | string | No | 2-letter country code for processor routing |

**Response (Success):**
```json
{
  "data": {
    "authorization": {
      "id": "auth-uuid",
      "gatewayTransactionId": "braintree-txn-id",
      "processor": "braintree",
      "status": "captured",
      "authorizedAmount": "100.0000",
      "capturedAmount": "100.0000",
      "currency": "USD",
      "platformRef": "CHG-abc123"
    },
    "transaction": {
      "id": "txn-uuid",
      "type": "payment",
      "status": "completed",
      "netAmount": "100.0000",
      "platformRef": "CHG-abc123"
    }
  },
  "message": "Payment charged successfully"
}
```

**Response (Error):**
```json
{
  "error": "Charge failed",
  "details": "Insufficient funds"
}
```

**TypeScript Interfaces:**
```typescript
interface ChargePaymentRequest {
  userId: string;
  amount: number;
  currency: string;
  paymentMethodNonce: string;
  productType: 'ride_hailing' | 'car_rental' | 'delivery';
  sourceEntityType: string;
  sourceEntityId: string;
  description?: string;
  idempotencyKey: string;
  country?: string;
}

interface ChargePaymentResponse {
  data: {
    authorization: {
      id: string;
      gatewayTransactionId: string;
      processor: string;
      status: string;
      authorizedAmount: string;
      capturedAmount: string;
      currency: string;
      platformRef: string;
    };
    transaction: {
      id: string;
      type: string;
      status: string;
      netAmount: string;
      platformRef: string;
    };
  };
  message: string;
}
```

---

#### 4. Authorize Payment (Hold Funds)

```http
POST /payments/authorize
Content-Type: application/json
```

**Use Case:** For ride-hailing - authorize when ride starts, capture when completed.

**Request Body:** Same as `/payments/charge` above.

**Key Difference:**
- `/authorize` - Holds funds, doesn't charge yet
- `/charge` - Charges immediately

---

#### 5. Wallet Transfer (Internal Payment)

For wallet payments, use the wallet transfer endpoint:

```http
POST /wallets/withdraw
Content-Type: application/json
```

**Request Body:**
```json
{
  "userId": "user-uuid",
  "amount": 100.00,
  "currency": "USD"
}
```

**Response:**
```json
{
  "data": {
    "id": "txn-uuid",
    "type": "withdrawal",
    "status": "completed",
    "netAmount": "100.0000",
    "reference": "WDR-xyz789"
  },
  "message": "Withdrawal successful"
}
```

**Note:** For wallet payments in your booking flow, you may want to create a dedicated endpoint like `/wallets/pay-for-booking` that combines withdrawal + booking creation in one atomic operation.

---

## Component Specifications

### 1. PaymentGateway.svelte

**Purpose:** Main component that handles payment method selection and orchestrates payment flow.

**Props:**
```typescript
interface PaymentGatewayProps {
  // Required
  amount: number;              // Payment amount
  currency: string;            // USD, THB, MYR, etc.
  userId: string;              // Current user ID
  productType: 'ride_hailing' | 'car_rental' | 'delivery';
  sourceEntityType: string;    // 'ride_request', 'rental_booking', etc.
  sourceEntityId: string;      // Booking/order UUID

  // Optional
  apiBaseUrl?: string;         // Default: from env
  country?: string;            // For processor routing (TH, US, etc.)
  allowedMethods?: ('wallet' | 'credit_card' | 'bank_transfer')[];
  onSuccess?: (result: PaymentResult) => void;
  onError?: (error: PaymentError) => void;
  onCancel?: () => void;
}
```

**Events:**
```typescript
// Dispatched events
dispatch('success', {
  paymentMethod: 'wallet' | 'credit_card',
  transactionId: string,
  amount: number,
  platformRef: string
});

dispatch('error', {
  code: string,
  message: string,
  details?: any
});

dispatch('cancel');
```

**State Management:**
```typescript
let selectedMethod: 'wallet' | 'credit_card' | 'bank_transfer' | null = null;
let walletBalance: number = 0;
let loading: boolean = false;
let error: string | null = null;
```

**Lifecycle:**
1. `onMount`: Fetch wallet balance
2. User selects payment method
3. Show appropriate payment form
4. Handle payment completion
5. Emit success/error events

---

### 2. WalletPayment.svelte

**Purpose:** Handle internal wallet payments.

**Props:**
```typescript
interface WalletPaymentProps {
  amount: number;
  currency: string;
  userId: string;
  productType: string;
  sourceEntityType: string;
  sourceEntityId: string;
  apiBaseUrl: string;
  walletBalance: number;  // Passed from parent
}
```

**UI Elements:**
- Balance display
- Amount to pay
- Confirmation button
- Loading state
- Error display

**Payment Flow:**
```typescript
async function payWithWallet() {
  loading = true;
  error = null;

  try {
    // Call wallet withdrawal API
    const response = await fetch(`${apiBaseUrl}/wallets/withdraw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        amount,
        currency
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.details || 'Payment failed');
    }

    const result = await response.json();

    // Emit success
    dispatch('success', {
      paymentMethod: 'wallet',
      transactionId: result.data.id,
      amount: amount,
      platformRef: result.data.reference
    });

  } catch (err) {
    error = err.message;
    dispatch('error', {
      code: 'WALLET_PAYMENT_FAILED',
      message: err.message
    });
  } finally {
    loading = false;
  }
}
```

---

### 3. CreditCardPayment.svelte

**Purpose:** Integrate Braintree Drop-in UI for credit card payments.

**Props:**
```typescript
interface CreditCardPaymentProps {
  amount: number;
  currency: string;
  userId: string;
  productType: string;
  sourceEntityType: string;
  sourceEntityId: string;
  apiBaseUrl: string;
  country?: string;
}
```

**Dependencies:**
```bash
npm install braintree-web-drop-in
```

**Implementation Steps:**

#### Step 1: Fetch Client Token

```typescript
import { onMount } from 'svelte';
import dropin from 'braintree-web-drop-in';

let dropinInstance: any = null;
let clientToken: string = '';
let loading = true;

onMount(async () => {
  try {
    // Get client token from backend
    const response = await fetch(
      `${apiBaseUrl}/payments/client-token`,
      { credentials: 'include' }
    );
    const data = await response.json();
    clientToken = data.data.clientToken;

    // Initialize Drop-in
    await initializeBraintree();

  } catch (err) {
    error = 'Failed to initialize payment form';
  } finally {
    loading = false;
  }
});
```

#### Step 2: Initialize Braintree Drop-in

```typescript
async function initializeBraintree() {
  dropinInstance = await dropin.create({
    authorization: clientToken,
    container: '#braintree-drop-in-container',

    // Customize UI
    card: {
      cardholderName: {
        required: true
      },
      overrides: {
        fields: {
          number: {
            placeholder: '4111 1111 1111 1111'
          },
          cvv: {
            placeholder: '123'
          }
        }
      }
    },

    // Supported payment methods
    paypal: {
      flow: 'checkout',
      amount: amount.toString(),
      currency: currency
    },

    // Styling
    locale: 'en_US'
  });
}
```

#### Step 3: Handle Payment Submission

```typescript
async function handlePayment() {
  loading = true;
  error = null;

  try {
    // Request payment nonce from Braintree
    const { nonce } = await dropinInstance.requestPaymentMethod();

    // Charge via backend
    const response = await fetch(`${apiBaseUrl}/payments/charge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        userId,
        amount,
        currency,
        paymentMethodNonce: nonce,
        productType,
        sourceEntityType,
        sourceEntityId,
        idempotencyKey: `${sourceEntityId}-payment-${Date.now()}`,
        country,
        description: `Payment for ${sourceEntityType}`
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.details || 'Payment failed');
    }

    const result = await response.json();

    // Success!
    dispatch('success', {
      paymentMethod: 'credit_card',
      transactionId: result.data.authorization.id,
      amount: amount,
      platformRef: result.data.authorization.platformRef
    });

  } catch (err) {
    error = err.message;
    dispatch('error', {
      code: 'CARD_PAYMENT_FAILED',
      message: err.message
    });
  } finally {
    loading = false;
  }
}
```

#### Step 4: Cleanup

```typescript
import { onDestroy } from 'svelte';

onDestroy(() => {
  if (dropinInstance) {
    dropinInstance.teardown();
  }
});
```

**Complete Component:**

```svelte
<!-- CreditCardPayment.svelte -->
<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import dropin from 'braintree-web-drop-in';

  export let amount: number;
  export let currency: string;
  export let userId: string;
  export let productType: string;
  export let sourceEntityType: string;
  export let sourceEntityId: string;
  export let apiBaseUrl: string;
  export let country: string = '';

  const dispatch = createEventDispatcher();

  let dropinInstance: any = null;
  let loading = true;
  let error: string | null = null;
  let processing = false;

  onMount(async () => {
    try {
      // Fetch client token
      const response = await fetch(
        `${apiBaseUrl}/payments/client-token`,
        { credentials: 'include' }
      );

      if (!response.ok) throw new Error('Failed to get client token');

      const data = await response.json();

      // Initialize Braintree Drop-in
      dropinInstance = await dropin.create({
        authorization: data.data.clientToken,
        container: '#braintree-drop-in-container',
        card: {
          cardholderName: { required: true }
        }
      });

      loading = false;

    } catch (err: any) {
      error = err.message;
      loading = false;
    }
  });

  async function handlePayment() {
    if (!dropinInstance) return;

    processing = true;
    error = null;

    try {
      // Get payment nonce
      const { nonce } = await dropinInstance.requestPaymentMethod();

      // Charge payment
      const response = await fetch(`${apiBaseUrl}/payments/charge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          userId,
          amount,
          currency,
          paymentMethodNonce: nonce,
          productType,
          sourceEntityType,
          sourceEntityId,
          idempotencyKey: `${sourceEntityId}-payment-${Date.now()}`,
          country,
          description: `Payment for ${sourceEntityType}`
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.details || 'Payment failed');
      }

      const result = await response.json();

      dispatch('success', {
        paymentMethod: 'credit_card',
        transactionId: result.data.authorization.id,
        amount,
        platformRef: result.data.authorization.platformRef
      });

    } catch (err: any) {
      error = err.message;
      dispatch('error', {
        code: 'CARD_PAYMENT_FAILED',
        message: err.message
      });
    } finally {
      processing = false;
    }
  }

  onDestroy(() => {
    if (dropinInstance) {
      dropinInstance.teardown();
    }
  });
</script>

<div class="credit-card-payment">
  {#if loading}
    <div class="loading">
      <p>Loading payment form...</p>
    </div>
  {:else if error}
    <div class="error">
      <p>{error}</p>
    </div>
  {:else}
    <div id="braintree-drop-in-container"></div>

    <button
      class="pay-button"
      on:click={handlePayment}
      disabled={processing}
    >
      {processing ? 'Processing...' : `Pay ${currency} ${amount.toFixed(2)}`}
    </button>

    {#if error}
      <div class="error-message">{error}</div>
    {/if}
  {/if}
</div>

<style>
  .credit-card-payment {
    margin-top: 1rem;
  }

  .loading, .error {
    text-align: center;
    padding: 2rem;
  }

  .pay-button {
    width: 100%;
    padding: 1rem;
    margin-top: 1rem;
    background: #4CAF50;
    color: white;
    border: none;
    border-radius: 4px;
    font-size: 1rem;
    font-weight: bold;
    cursor: pointer;
  }

  .pay-button:disabled {
    background: #ccc;
    cursor: not-allowed;
  }

  .error-message {
    margin-top: 1rem;
    padding: 1rem;
    background: #ffebee;
    color: #c62828;
    border-radius: 4px;
  }
</style>
```

---

### 4. BankTransferPayment.svelte

**Purpose:** Placeholder for bank transfer payment method (to be implemented later).

**Props:**
```typescript
interface BankTransferPaymentProps {
  amount: number;
  currency: string;
}
```

**Simple Implementation:**

```svelte
<script lang="ts">
  export let amount: number;
  export let currency: string;
</script>

<div class="bank-transfer-payment">
  <div class="placeholder">
    <h3>Bank Transfer</h3>
    <p>This payment method is coming soon!</p>
    <p>Amount: {currency} {amount.toFixed(2)}</p>
  </div>
</div>

<style>
  .placeholder {
    text-align: center;
    padding: 2rem;
    background: #f5f5f5;
    border-radius: 8px;
  }
</style>
```

---

## Step-by-Step Implementation

### Step 1: Create Type Definitions

**File:** `src/lib/components/payment/types.ts`

```typescript
export type PaymentMethod = 'wallet' | 'credit_card' | 'bank_transfer';

export type ProductType = 'ride_hailing' | 'car_rental' | 'delivery';

export interface PaymentGatewayConfig {
  amount: number;
  currency: string;
  userId: string;
  productType: ProductType;
  sourceEntityType: string;
  sourceEntityId: string;
  apiBaseUrl?: string;
  country?: string;
  allowedMethods?: PaymentMethod[];
}

export interface PaymentResult {
  paymentMethod: PaymentMethod;
  transactionId: string;
  amount: number;
  platformRef: string;
  processor?: string;
}

export interface PaymentError {
  code: string;
  message: string;
  details?: any;
}

export interface WalletBalance {
  balance: string;
  availableBalance: string;
  currency: string;
}
```

---

### Step 2: Create API Client

**File:** `src/lib/components/payment/api/wallet-api.ts`

```typescript
import type { WalletBalance } from '../types';

const API_BASE = import.meta.env.PUBLIC_WALLET_API_URL || 'http://localhost:3000';

export class WalletAPIError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number,
    public details?: any
  ) {
    super(message);
    this.name = 'WalletAPIError';
  }
}

export async function getWalletBalance(
  userId: string,
  currency: string = 'USD'
): Promise<WalletBalance> {
  try {
    const response = await fetch(
      `${API_BASE}/wallets?userId=${userId}&currency=${currency}`,
      { credentials: 'include' }
    );

    if (!response.ok) {
      const error = await response.json();
      throw new WalletAPIError(
        error.details || 'Failed to fetch wallet balance',
        'FETCH_BALANCE_FAILED',
        response.status,
        error
      );
    }

    const data = await response.json();
    return {
      balance: data.data.balance,
      availableBalance: data.data.availableBalance,
      currency: data.data.currency
    };

  } catch (err) {
    if (err instanceof WalletAPIError) throw err;
    throw new WalletAPIError(
      'Network error',
      'NETWORK_ERROR',
      0,
      err
    );
  }
}

export async function withdrawFromWallet(
  userId: string,
  amount: number,
  currency: string
): Promise<any> {
  try {
    const response = await fetch(
      `${API_BASE}/wallets/withdraw`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ userId, amount, currency })
      }
    );

    if (!response.ok) {
      const error = await response.json();
      throw new WalletAPIError(
        error.details || 'Withdrawal failed',
        'WITHDRAWAL_FAILED',
        response.status,
        error
      );
    }

    return await response.json();

  } catch (err) {
    if (err instanceof WalletAPIError) throw err;
    throw new WalletAPIError(
      'Network error',
      'NETWORK_ERROR',
      0,
      err
    );
  }
}
```

**File:** `src/lib/components/payment/api/payment-api.ts`

```typescript
import type { ProductType, PaymentResult } from '../types';

const API_BASE = import.meta.env.PUBLIC_WALLET_API_URL || 'http://localhost:3000';

export class PaymentAPIError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number,
    public details?: any
  ) {
    super(message);
    this.name = 'PaymentAPIError';
  }
}

export interface ChargePaymentParams {
  userId: string;
  amount: number;
  currency: string;
  paymentMethodNonce: string;
  productType: ProductType;
  sourceEntityType: string;
  sourceEntityId: string;
  description?: string;
  idempotencyKey: string;
  country?: string;
}

export async function getBraintreeClientToken(): Promise<string> {
  try {
    const response = await fetch(
      `${API_BASE}/payments/client-token`,
      { credentials: 'include' }
    );

    if (!response.ok) {
      throw new PaymentAPIError(
        'Failed to get client token',
        'CLIENT_TOKEN_FAILED',
        response.status
      );
    }

    const data = await response.json();
    return data.data.clientToken;

  } catch (err) {
    if (err instanceof PaymentAPIError) throw err;
    throw new PaymentAPIError(
      'Network error',
      'NETWORK_ERROR',
      0,
      err
    );
  }
}

export async function chargePayment(
  params: ChargePaymentParams
): Promise<PaymentResult> {
  try {
    const response = await fetch(
      `${API_BASE}/payments/charge`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(params)
      }
    );

    if (!response.ok) {
      const error = await response.json();
      throw new PaymentAPIError(
        error.details || 'Payment failed',
        'PAYMENT_FAILED',
        response.status,
        error
      );
    }

    const result = await response.json();

    return {
      paymentMethod: 'credit_card',
      transactionId: result.data.authorization.id,
      amount: params.amount,
      platformRef: result.data.authorization.platformRef,
      processor: result.data.authorization.processor
    };

  } catch (err) {
    if (err instanceof PaymentAPIError) throw err;
    throw new PaymentAPIError(
      'Network error',
      'NETWORK_ERROR',
      0,
      err
    );
  }
}
```

---

### Step 3: Create Utility Functions

**File:** `src/lib/components/payment/utils/formatters.ts`

```typescript
export function formatCurrency(
  amount: number,
  currency: string,
  locale: string = 'en-US'
): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currency
  }).format(amount);
}

export function parseCurrencyAmount(value: string): number {
  // Remove non-numeric characters except decimal point
  const cleaned = value.replace(/[^\d.]/g, '');
  return parseFloat(cleaned) || 0;
}
```

**File:** `src/lib/components/payment/utils/validators.ts`

```typescript
export function isValidAmount(amount: number): boolean {
  return amount > 0 && Number.isFinite(amount);
}

export function isValidCurrency(currency: string): boolean {
  return /^[A-Z]{3}$/.test(currency);
}

export function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}
```

---

### Step 4: Create Main Component

**File:** `src/lib/components/payment/PaymentGateway.svelte`

```svelte
<script lang="ts">
  import { onMount, createEventDispatcher } from 'svelte';
  import { getWalletBalance } from './api/wallet-api';
  import WalletPayment from './WalletPayment.svelte';
  import CreditCardPayment from './CreditCardPayment.svelte';
  import BankTransferPayment from './BankTransferPayment.svelte';
  import type { PaymentMethod, ProductType, PaymentResult, PaymentError } from './types';

  // Props
  export let amount: number;
  export let currency: string = 'USD';
  export let userId: string;
  export let productType: ProductType;
  export let sourceEntityType: string;
  export let sourceEntityId: string;
  export let apiBaseUrl: string = import.meta.env.PUBLIC_WALLET_API_URL || 'http://localhost:3000';
  export let country: string = '';
  export let allowedMethods: PaymentMethod[] = ['wallet', 'credit_card', 'bank_transfer'];

  const dispatch = createEventDispatcher<{
    success: PaymentResult;
    error: PaymentError;
    cancel: void;
  }>();

  // State
  let selectedMethod: PaymentMethod | null = null;
  let walletBalance: number = 0;
  let loadingBalance = true;
  let balanceError: string | null = null;

  // Computed
  $: hasInsufficientBalance = walletBalance < amount;
  $: canUseWallet = allowedMethods.includes('wallet') && !hasInsufficientBalance;
  $: canUseCreditCard = allowedMethods.includes('credit_card');
  $: canUseBankTransfer = allowedMethods.includes('bank_transfer');

  onMount(async () => {
    if (allowedMethods.includes('wallet')) {
      try {
        const balance = await getWalletBalance(userId, currency);
        walletBalance = parseFloat(balance.availableBalance);
      } catch (err: any) {
        balanceError = err.message;
      } finally {
        loadingBalance = false;
      }
    } else {
      loadingBalance = false;
    }
  });

  function handleSuccess(event: CustomEvent<PaymentResult>) {
    dispatch('success', event.detail);
  }

  function handleError(event: CustomEvent<PaymentError>) {
    dispatch('error', event.detail);
  }

  function handleCancel() {
    selectedMethod = null;
    dispatch('cancel');
  }
</script>

<div class="payment-gateway">
  <header>
    <h2>Select Payment Method</h2>
    <p class="amount">Amount: {currency} {amount.toFixed(2)}</p>
  </header>

  {#if loadingBalance}
    <div class="loading">Loading payment options...</div>
  {:else}
    <!-- Payment Method Selection -->
    {#if !selectedMethod}
      <div class="payment-methods">
        <!-- Wallet -->
        {#if allowedMethods.includes('wallet')}
          <button
            class="payment-method"
            class:disabled={hasInsufficientBalance}
            disabled={hasInsufficientBalance}
            on:click={() => !hasInsufficientBalance && (selectedMethod = 'wallet')}
          >
            <div class="icon">💰</div>
            <div class="details">
              <h3>Wallet</h3>
              <p class="balance">
                Balance: {currency} {walletBalance.toFixed(2)}
              </p>
              {#if hasInsufficientBalance}
                <span class="error">Insufficient balance</span>
              {/if}
            </div>
            <div class="arrow">→</div>
          </button>
        {/if}

        <!-- Credit Card -->
        {#if allowedMethods.includes('credit_card')}
          <button
            class="payment-method"
            on:click={() => selectedMethod = 'credit_card'}
          >
            <div class="icon">💳</div>
            <div class="details">
              <h3>Credit/Debit Card</h3>
              <p>Visa, Mastercard, Amex</p>
            </div>
            <div class="arrow">→</div>
          </button>
        {/if}

        <!-- Bank Transfer -->
        {#if allowedMethods.includes('bank_transfer')}
          <button
            class="payment-method"
            disabled
          >
            <div class="icon">🏦</div>
            <div class="details">
              <h3>Bank Transfer</h3>
              <p>Coming soon</p>
            </div>
          </button>
        {/if}
      </div>
    {:else}
      <!-- Selected Payment Method Form -->
      <div class="payment-form">
        <button class="back-button" on:click={handleCancel}>
          ← Back to payment methods
        </button>

        {#if selectedMethod === 'wallet'}
          <WalletPayment
            {amount}
            {currency}
            {userId}
            {productType}
            {sourceEntityType}
            {sourceEntityId}
            {apiBaseUrl}
            {walletBalance}
            on:success={handleSuccess}
            on:error={handleError}
          />
        {:else if selectedMethod === 'credit_card'}
          <CreditCardPayment
            {amount}
            {currency}
            {userId}
            {productType}
            {sourceEntityType}
            {sourceEntityId}
            {apiBaseUrl}
            {country}
            on:success={handleSuccess}
            on:error={handleError}
          />
        {:else if selectedMethod === 'bank_transfer'}
          <BankTransferPayment
            {amount}
            {currency}
          />
        {/if}
      </div>
    {/if}

    {#if balanceError}
      <div class="error-banner">
        Failed to load wallet balance: {balanceError}
      </div>
    {/if}
  {/if}
</div>

<style>
  .payment-gateway {
    max-width: 500px;
    margin: 0 auto;
    padding: 1.5rem;
    background: white;
    border-radius: 12px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  }

  header {
    margin-bottom: 2rem;
  }

  header h2 {
    margin: 0 0 0.5rem;
    font-size: 1.5rem;
    color: #333;
  }

  .amount {
    margin: 0;
    font-size: 1.25rem;
    font-weight: bold;
    color: #4CAF50;
  }

  .loading {
    text-align: center;
    padding: 2rem;
    color: #666;
  }

  .payment-methods {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .payment-method {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 1.25rem;
    border: 2px solid #e0e0e0;
    border-radius: 8px;
    background: white;
    cursor: pointer;
    transition: all 0.2s;
    text-align: left;
    width: 100%;
  }

  .payment-method:hover:not(:disabled) {
    border-color: #4CAF50;
    box-shadow: 0 2px 8px rgba(76, 175, 80, 0.2);
    transform: translateY(-2px);
  }

  .payment-method:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .icon {
    font-size: 2rem;
    flex-shrink: 0;
  }

  .details {
    flex: 1;
  }

  .details h3 {
    margin: 0 0 0.25rem;
    font-size: 1.1rem;
    color: #333;
  }

  .details p {
    margin: 0;
    font-size: 0.9rem;
    color: #666;
  }

  .balance {
    font-weight: 600;
    color: #4CAF50;
  }

  .error {
    display: block;
    margin-top: 0.25rem;
    font-size: 0.85rem;
    color: #f44336;
  }

  .arrow {
    font-size: 1.5rem;
    color: #999;
    flex-shrink: 0;
  }

  .back-button {
    margin-bottom: 1rem;
    padding: 0.5rem 1rem;
    background: none;
    border: 1px solid #ddd;
    border-radius: 4px;
    cursor: pointer;
    color: #666;
    font-size: 0.9rem;
  }

  .back-button:hover {
    background: #f5f5f5;
  }

  .error-banner {
    margin-top: 1rem;
    padding: 1rem;
    background: #ffebee;
    border-left: 4px solid #f44336;
    border-radius: 4px;
    color: #c62828;
    font-size: 0.9rem;
  }
</style>
```

---

### Step 5: Create Sub-Components

I've already provided the complete implementations above for:
- `WalletPayment.svelte` (in Component Specifications section)
- `CreditCardPayment.svelte` (in Component Specifications section)
- `BankTransferPayment.svelte` (in Component Specifications section)

---

### Step 6: Usage in Your Apps

**Example: In a Ride-Hailing Booking Page**

**File:** `src/routes/booking/[id]/payment/+page.svelte`

```svelte
<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import PaymentGateway from '$lib/components/payment/PaymentGateway.svelte';
  import type { PaymentResult, PaymentError } from '$lib/components/payment/types';

  // Get booking data (from +page.ts or +page.server.ts)
  export let data;

  const { booking, user } = data;

  let showSuccess = false;
  let paymentResult: PaymentResult | null = null;
  let paymentError: PaymentError | null = null;

  function handlePaymentSuccess(event: CustomEvent<PaymentResult>) {
    paymentResult = event.detail;
    showSuccess = true;

    // Update booking status in your backend
    updateBookingStatus(booking.id, 'paid', event.detail);

    // Redirect after 2 seconds
    setTimeout(() => {
      goto(`/bookings/${booking.id}/confirmation`);
    }, 2000);
  }

  function handlePaymentError(event: CustomEvent<PaymentError>) {
    paymentError = event.detail;
    console.error('Payment failed:', event.detail);
  }

  function handleCancel() {
    goto(`/bookings/${booking.id}`);
  }

  async function updateBookingStatus(
    bookingId: string,
    status: string,
    payment: PaymentResult
  ) {
    await fetch(`/api/bookings/${bookingId}/payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status,
        transactionId: payment.transactionId,
        platformRef: payment.platformRef
      })
    });
  }
</script>

<div class="payment-page">
  <h1>Complete Your Booking</h1>

  <div class="booking-summary">
    <h3>Booking Details</h3>
    <p>From: {booking.pickup}</p>
    <p>To: {booking.dropoff}</p>
    <p>Distance: {booking.distance} km</p>
    <p><strong>Fare: {booking.currency} {booking.fare}</strong></p>
  </div>

  {#if !showSuccess}
    <PaymentGateway
      amount={booking.fare}
      currency={booking.currency}
      userId={user.id}
      productType="ride_hailing"
      sourceEntityType="ride_request"
      sourceEntityId={booking.id}
      country={user.country}
      allowedMethods={['wallet', 'credit_card']}
      on:success={handlePaymentSuccess}
      on:error={handlePaymentError}
      on:cancel={handleCancel}
    />

    {#if paymentError}
      <div class="error-alert">
        <h3>Payment Failed</h3>
        <p>{paymentError.message}</p>
        <button on:click={() => paymentError = null}>Try Again</button>
      </div>
    {/if}
  {:else}
    <div class="success-message">
      <div class="checkmark">✓</div>
      <h2>Payment Successful!</h2>
      <p>Transaction ID: {paymentResult?.transactionId}</p>
      <p>Redirecting to confirmation...</p>
    </div>
  {/if}
</div>

<style>
  .payment-page {
    max-width: 800px;
    margin: 2rem auto;
    padding: 0 1rem;
  }

  .booking-summary {
    margin: 2rem 0;
    padding: 1.5rem;
    background: #f5f5f5;
    border-radius: 8px;
  }

  .error-alert {
    margin-top: 1rem;
    padding: 1.5rem;
    background: #ffebee;
    border-left: 4px solid #f44336;
    border-radius: 4px;
  }

  .success-message {
    text-align: center;
    padding: 3rem;
    background: #e8f5e9;
    border-radius: 12px;
  }

  .checkmark {
    font-size: 4rem;
    color: #4CAF50;
  }
</style>
```

---

## Payment Flows

### Flow 1: Wallet Payment

```
User Flow:
1. User views payment gateway
2. System fetches wallet balance (GET /wallets)
3. User selects "Wallet" method
4. User clicks "Pay with Wallet"
5. System calls POST /wallets/withdraw
6. Success → Update booking → Show confirmation
7. Error → Show error message

API Calls:
┌─────────────┐
│   Frontend  │
└──────┬──────┘
       │
       │ GET /wallets?userId=xxx&currency=USD
       ▼
┌─────────────┐
│   Backend   │
└──────┬──────┘
       │
       │ Returns: { availableBalance: "150.00" }
       ▼
┌─────────────┐
│   Frontend  │  (User clicks "Pay with Wallet")
└──────┬──────┘
       │
       │ POST /wallets/withdraw
       │ { userId, amount: 100, currency: "USD" }
       ▼
┌─────────────┐
│   Backend   │
└──────┬──────┘
       │
       │ Returns: { data: { id: "txn-uuid", status: "completed" } }
       ▼
┌─────────────┐
│   Frontend  │  (dispatch success event)
└─────────────┘
```

### Flow 2: Credit Card Payment

```
User Flow:
1. User selects "Credit Card" method
2. System fetches Braintree client token (GET /payments/client-token)
3. System initializes Braintree Drop-in UI
4. User enters card details
5. User clicks "Pay"
6. Braintree creates payment nonce
7. System calls POST /payments/charge with nonce
8. Success → Update booking → Show confirmation
9. Error → Show error message

API Calls:
┌─────────────┐
│   Frontend  │
└──────┬──────┘
       │
       │ GET /payments/client-token
       ▼
┌─────────────┐
│   Backend   │
└──────┬──────┘
       │
       │ Returns: { clientToken: "eyJ2ZXJzaW..." }
       ▼
┌─────────────┐
│   Frontend  │  (Initialize Braintree Drop-in)
└──────┬──────┘
       │
       │ User enters card details
       │ dropinInstance.requestPaymentMethod()
       ▼
┌─────────────┐
│  Braintree  │
└──────┬──────┘
       │
       │ Returns: { nonce: "fake-valid-nonce" }
       ▼
┌─────────────┐
│   Frontend  │
└──────┬──────┘
       │
       │ POST /payments/charge
       │ { userId, amount, currency, paymentMethodNonce: "fake-valid-nonce", ... }
       ▼
┌─────────────┐
│   Backend   │
└──────┬──────┘
       │
       │ Charges card via Braintree
       │ Creates transaction in database
       │ Returns: { data: { authorization: {...}, transaction: {...} } }
       ▼
┌─────────────┐
│   Frontend  │  (dispatch success event)
└─────────────┘
```

---

## Error Handling

### Error Categories

#### 1. Network Errors

```typescript
try {
  const response = await fetch(...);
} catch (err) {
  // Network failure (no internet, CORS, etc.)
  dispatch('error', {
    code: 'NETWORK_ERROR',
    message: 'Unable to connect. Please check your internet connection.',
    details: err
  });
}
```

#### 2. API Errors (4xx, 5xx)

```typescript
if (!response.ok) {
  const error = await response.json();

  // Handle specific error codes
  if (response.status === 400) {
    dispatch('error', {
      code: 'VALIDATION_ERROR',
      message: error.details || 'Invalid payment data',
      details: error
    });
  } else if (response.status === 409) {
    dispatch('error', {
      code: 'DUPLICATE_PAYMENT',
      message: 'This payment has already been processed',
      details: error
    });
  } else {
    dispatch('error', {
      code: 'API_ERROR',
      message: error.details || 'Payment processing failed',
      details: error
    });
  }
}
```

#### 3. Insufficient Balance

```typescript
// Check before allowing wallet selection
if (walletBalance < amount) {
  // Disable wallet button
  // Show "Insufficient balance" message
}

// Also handle backend validation
if (error.details === 'Insufficient available balance') {
  dispatch('error', {
    code: 'INSUFFICIENT_BALANCE',
    message: 'Your wallet balance is too low for this payment',
    details: error
  });
}
```

#### 4. Braintree Errors

```typescript
try {
  const { nonce } = await dropinInstance.requestPaymentMethod();
} catch (err) {
  // User cancelled or card validation failed
  dispatch('error', {
    code: 'BRAINTREE_ERROR',
    message: 'Payment method validation failed. Please check your card details.',
    details: err
  });
}
```

### User-Friendly Error Messages

```typescript
const ERROR_MESSAGES: Record<string, string> = {
  NETWORK_ERROR: 'Unable to connect. Please check your internet connection.',
  INSUFFICIENT_BALANCE: 'Your wallet balance is too low. Please use another payment method.',
  CARD_DECLINED: 'Your card was declined. Please try a different card.',
  INVALID_CARD: 'Invalid card details. Please check and try again.',
  DUPLICATE_PAYMENT: 'This payment has already been processed.',
  SERVER_ERROR: 'Something went wrong on our end. Please try again later.',
  TIMEOUT: 'Request timed out. Please try again.',
};

function getUserFriendlyMessage(error: PaymentError): string {
  return ERROR_MESSAGES[error.code] || error.message;
}
```

---

## Security Considerations

### 1. Never Store Sensitive Data

```typescript
// ❌ NEVER DO THIS
localStorage.setItem('cardNumber', '4111111111111111');
localStorage.setItem('cvv', '123');

// ✅ CORRECT
// Use Braintree nonce (one-time use token)
const { nonce } = await dropinInstance.requestPaymentMethod();
// Send nonce to backend, discard immediately after use
```

### 2. Use HTTPS Only

```typescript
// Check protocol in production
if (import.meta.env.PROD && window.location.protocol !== 'https:') {
  console.error('Payment gateway requires HTTPS');
  // Redirect to HTTPS or block payment
}
```

### 3. Validate on Backend

```typescript
// Frontend validation is for UX only
// Backend MUST validate everything:
// - User authentication
// - Amount matches booking
// - Idempotency key
// - Authorization (user owns this booking)
```

### 4. Idempotency Keys

```typescript
// Always generate unique idempotency keys
const idempotencyKey = `${sourceEntityId}-payment-${Date.now()}`;

// This prevents duplicate charges if user clicks "Pay" multiple times
```

### 5. CORS & Credentials

```typescript
// Always use credentials: 'include' for authenticated requests
fetch(url, {
  credentials: 'include',  // Send cookies/auth headers
  // ...
});
```

---

## Testing

### Unit Tests (Vitest/Jest)

```typescript
// wallet-api.test.ts
import { describe, it, expect, vi } from 'vitest';
import { getWalletBalance } from './api/wallet-api';

describe('getWalletBalance', () => {
  it('should fetch wallet balance successfully', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          balance: '100.00',
          availableBalance: '100.00',
          currency: 'USD'
        }
      })
    });

    const balance = await getWalletBalance('user-123', 'USD');

    expect(balance.availableBalance).toBe('100.00');
    expect(balance.currency).toBe('USD');
  });

  it('should throw error on API failure', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Server error' })
    });

    await expect(
      getWalletBalance('user-123', 'USD')
    ).rejects.toThrow('Failed to fetch wallet balance');
  });
});
```

### Integration Tests (Playwright)

```typescript
// payment.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Payment Gateway', () => {
  test('should complete wallet payment successfully', async ({ page }) => {
    // Navigate to payment page
    await page.goto('/booking/test-booking-id/payment');

    // Wait for payment gateway to load
    await expect(page.locator('h2')).toContainText('Select Payment Method');

    // Select wallet payment
    await page.click('button:has-text("Wallet")');

    // Click pay button
    await page.click('button:has-text("Pay")');

    // Wait for success message
    await expect(page.locator('.success-message')).toBeVisible();
    await expect(page.locator('.success-message')).toContainText('Payment Successful');
  });

  test('should show error for insufficient balance', async ({ page }) => {
    // Mock API to return low balance
    await page.route('**/wallets?*', route => {
      route.fulfill({
        status: 200,
        body: JSON.stringify({
          data: { availableBalance: '10.00' }
        })
      });
    });

    await page.goto('/booking/test-booking-id/payment');

    // Wallet button should be disabled
    const walletButton = page.locator('button:has-text("Wallet")');
    await expect(walletButton).toBeDisabled();
    await expect(walletButton).toContainText('Insufficient balance');
  });
});
```

### Manual Testing Checklist

- [ ] Wallet payment with sufficient balance
- [ ] Wallet payment with insufficient balance (button disabled)
- [ ] Credit card payment with valid card
- [ ] Credit card payment with invalid card (should show error)
- [ ] Credit card payment with declined card
- [ ] Cancel payment and return to method selection
- [ ] Network error during payment (disconnect wifi)
- [ ] Duplicate payment prevention (click Pay twice quickly)
- [ ] Different currencies (USD, THB, MYR)
- [ ] Mobile responsive design
- [ ] Loading states (spinner/skeleton)
- [ ] Error messages are user-friendly

---

## Deployment

### Environment Variables

**Development (.env.development):**
```bash
PUBLIC_WALLET_API_URL=http://localhost:3000
```

**Production (.env.production):**
```bash
PUBLIC_WALLET_API_URL=https://wallet-api.yourcompany.com
```

### Build & Deploy

```bash
# Install dependencies
npm install

# Run tests
npm test

# Build for production
npm run build

# Preview production build
npm run preview
```

### CDN for Braintree

Ensure Braintree SDK is loaded:

```html
<!-- In app.html or layout -->
<script src="https://js.braintreegateway.com/web/dropin/1.40.0/js/dropin.min.js"></script>
```

Or use npm package (already installed):
```typescript
import dropin from 'braintree-web-drop-in';
```

---

## Appendix

### A. Complete File Structure

```
src/
├── lib/
│   └── components/
│       └── payment/
│           ├── PaymentGateway.svelte
│           ├── WalletPayment.svelte
│           ├── CreditCardPayment.svelte
│           ├── BankTransferPayment.svelte
│           ├── types.ts
│           ├── api/
│           │   ├── wallet-api.ts
│           │   ├── payment-api.ts
│           │   └── braintree.ts
│           └── utils/
│               ├── formatters.ts
│               └── validators.ts
├── routes/
│   └── booking/
│       └── [id]/
│           └── payment/
│               └── +page.svelte
└── tests/
    ├── unit/
    │   ├── wallet-api.test.ts
    │   └── payment-api.test.ts
    └── e2e/
        └── payment.spec.ts
```

### B. Backend API Summary

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/wallets` | GET | Get wallet balance |
| `/wallets/withdraw` | POST | Withdraw from wallet |
| `/payments/client-token` | GET | Get Braintree token |
| `/payments/charge` | POST | Charge payment |
| `/payments/authorize` | POST | Authorize (hold) payment |
| `/payments/capture` | POST | Capture authorized payment |
| `/payments/void` | POST | Void/release authorization |
| `/payments/refund` | POST | Refund payment |

### C. Braintree Test Cards

| Card Number | Type | Result |
|-------------|------|--------|
| 4111 1111 1111 1111 | Visa | Success |
| 5555 5555 5555 4444 | Mastercard | Success |
| 378282246310005 | Amex | Success |
| 4000 0000 0000 0002 | Visa | Decline |

CVV: Any 3-4 digits
Expiry: Any future date

### D. Support & Troubleshooting

**Common Issues:**

1. **"Failed to get client token"**
   - Check backend is running
   - Verify CORS configuration
   - Check `PUBLIC_WALLET_API_URL` in .env

2. **"Payment method validation failed"**
   - Invalid card details
   - Test with Braintree test cards
   - Check Braintree sandbox credentials in backend

3. **"Insufficient balance" but balance looks correct**
   - Check currency mismatch
   - Refresh wallet balance
   - Verify `availableBalance` vs `balance`

4. **CORS errors**
   - Add your frontend URL to backend CORS config
   - Use `credentials: 'include'` in fetch calls

---

## Summary

This guide provides everything your frontend developers need to implement the payment gateway:

✅ Complete component specifications
✅ Step-by-step implementation guide
✅ API reference with TypeScript types
✅ Error handling strategies
✅ Security best practices
✅ Testing guidelines
✅ Deployment checklist

**Next Steps:**
1. Share this document with your frontend team
2. Set up the project structure
3. Implement components following the guide
4. Test thoroughly using the checklist
5. Deploy to production

**Estimated Implementation Time:** 3-5 days for an experienced Svelte developer

**Questions?** Refer to the troubleshooting section or backend API documentation.
