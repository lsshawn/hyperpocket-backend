# Payment Module - Braintree Integration

This module handles payment processing for ride-hailing and car rental use cases using Braintree.

## Use Cases

### 1. Ride-Hailing Flow
**Authorization First, Charge Later**

1. **Ride Starts**: Authorize payment when passenger enters vehicle
   ```
   POST /payments/authorize
   ```

2. **Ride Completes**: Capture actual fare amount
   ```
   POST /payments/capture
   ```

3. **Ride Cancelled**: Release authorization
   ```
   POST /payments/void
   ```

### 2. Car Rental Flow
**Upfront Charge + Security Deposit**

1. **Booking Created**:
   - Charge rental fee immediately
     ```
     POST /payments/charge
     ```
   - Hold security deposit
     ```
     POST /payments/authorize
     ```

2. **Rental Completed (No Damage)**:
   - Release security deposit
     ```
     POST /payments/void
     ```

3. **Rental Completed (With Damage)**:
   - Capture damage amount from security deposit
     ```
     POST /payments/capture (partial)
     ```

4. **Booking Cancelled**:
   - Refund rental fee based on cancellation policy
     ```
     POST /payments/refund (full or partial)
     ```
   - Release security deposit
     ```
     POST /payments/void
     ```

### 3. Additional Use Cases

#### Tips (Post-Ride)
- After ride completion, customer can add tip
- Use immediate charge with tip amount

#### Split Payments
- Multiple passengers can each authorize their portion
- Capture each authorization separately

#### Promotional Credits
- Apply credits before charging
- Reduce charge amount accordingly

## API Endpoints

### Payment Operations

#### 1. Generate Client Token
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

#### 2. Create/Get Customer
```http
POST /payments/customer
Content-Type: application/json

{
  "userId": "uuid",
  "firstName": "John",
  "lastName": "Doe",
  "email": "john@example.com",
  "phone": "+1234567890"
}
```

---

#### 3. Authorize Payment (Hold Funds)
```http
POST /payments/authorize
Content-Type: application/json

{
  "userId": "uuid",
  "amount": 50.00,
  "currency": "USD",
  "paymentMethodNonce": "fake-valid-nonce",
  "productType": "ride_hailing",
  "sourceEntityType": "ride_request",
  "sourceEntityId": "booking-uuid",
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

---

#### 4. Charge Payment (Immediate)
```http
POST /payments/charge
Content-Type: application/json

{
  "userId": "uuid",
  "amount": 100.00,
  "currency": "USD",
  "paymentMethodNonce": "fake-valid-nonce",
  "productType": "car_rental",
  "sourceEntityType": "rental_booking",
  "sourceEntityId": "booking-uuid",
  "description": "Rental fee for 3 days",
  "idempotencyKey": "booking-uuid-charge"
}
```

---

#### 5. Capture Payment (Full or Partial)
```http
POST /payments/capture
Content-Type: application/json

{
  "authorizationId": "auth-uuid",
  "amount": 45.50,
  "userId": "uuid",
  "currency": "USD"
}
```

**Notes:**
- Omit `amount` for full capture
- Include `amount` for partial capture

---

#### 6. Void Authorization (Release Hold)
```http
POST /payments/void
Content-Type: application/json

{
  "authorizationId": "auth-uuid",
  "userId": "uuid"
}
```

---

#### 7. Refund Payment (Full or Partial)
```http
POST /payments/refund
Content-Type: application/json

{
  "authorizationId": "auth-uuid",
  "amount": 50.00,
  "reason": "Booking cancelled - 50% refund per policy",
  "userId": "uuid",
  "currency": "USD"
}
```

---

#### 8. Get Authorization Details
```http
GET /payments/{authorizationId}
```

---

#### 9. Get Authorizations by Source Entity
```http
GET /payments/by-source?sourceEntityId={booking-uuid}
```

**Use Case:** Get all payment authorizations for a specific booking

---

## Webhook Integration

Braintree sends webhook notifications for transaction lifecycle events.

### Setup Webhook URL
In Braintree Control Panel:
```
https://your-domain.com/webhooks/braintree
```

### Webhook Events Handled

| Event | Description | Action |
|-------|-------------|--------|
| `transaction_settled` | Payment cleared (T+2) | Mark as settled |
| `transaction_settlement_declined` | Payment failed after settlement | Reverse transaction |
| `transaction_disbursed` | Funds transferred to merchant | Log/notify |
| `dispute_opened` | Customer initiated chargeback | Flag for review |
| `dispute_lost` | Chargeback won by customer | Reverse transaction |
| `dispute_won` | Chargeback won by merchant | No action needed |

---

## Testing

### Braintree Sandbox Test Cards

**Successful Transactions:**
```
Card: 4111 1111 1111 1111
CVV: 123
Exp: Any future date
```

**Test Nonces:**
- Valid: `fake-valid-nonce`
- Processor Declined: `fake-processor-declined-visa-nonce`
- Gateway Rejected: `fake-gateway-rejected-fraud-nonce`

### Test Flow Example

```bash
# 1. Generate client token
curl http://localhost:3000/payments/client-token

# 2. Authorize $50 for ride
curl -X POST http://localhost:3000/payments/authorize \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user-uuid",
    "amount": 50.00,
    "currency": "USD",
    "paymentMethodNonce": "fake-valid-nonce",
    "productType": "ride_hailing",
    "sourceEntityType": "ride_request",
    "sourceEntityId": "ride-uuid",
    "idempotencyKey": "ride-uuid-auth"
  }'

# 3. Capture $45.50 (actual fare)
curl -X POST http://localhost:3000/payments/capture \
  -H "Content-Type: application/json" \
  -d '{
    "authorizationId": "auth-uuid-from-step-2",
    "amount": 45.50,
    "userId": "user-uuid",
    "currency": "USD"
  }'
```

---

## Database Schema

### payment_authorizations
Tracks all payment authorizations (holds, pre-auths, charges)

Key fields:
- `gatewayTransactionId`: Braintree transaction ID
- `authorizedAmount`: Original hold amount
- `capturedAmount`: Amount captured so far
- `remainingAmount`: Available to capture
- `status`: authorized, captured, voided, etc.

### refunds
Tracks all refund transactions

Key fields:
- `gatewayRefundId`: Braintree refund ID
- `originalTransactionId`: Link to original transaction
- `refundAmount`: Amount refunded
- `reason`: Refund reason

---

## Error Handling

### Common Errors

**400 Bad Request:**
- Invalid authorization ID
- Amount exceeds authorized/captured amount
- Cannot capture/void/refund in current status

**409 Conflict:**
- Duplicate idempotency key

**500 Internal Server Error:**
- Braintree API failure
- Database transaction failure

### Idempotency

All operations that create charges use idempotency keys to prevent duplicate charges:
- Use booking ID or similar unique identifier
- Safe to retry failed requests with same key
- Returns existing result if key already processed

---

## Security Considerations

1. **Never log sensitive data**: Card numbers, CVV, nonces
2. **Validate user ownership**: Always check userId matches authorization
3. **Use HTTPS**: All payment endpoints require TLS
4. **Webhook verification**: Verify webhook signatures
5. **Environment separation**: Use sandbox for testing

---

## SOA Integration

This payment service follows the Service-Oriented Architecture defined in CLAUDE.md:

### Key Principles

1. **API-Only Access**: Core apps MUST use REST API endpoints
2. **No Direct DB Access**: Core apps cannot query payment tables
3. **Idempotency**: All operations accept unique keys (booking ID)
4. **Multi-Product Support**: Uses product_type, source_entity_type, source_entity_id fields

### Integration Example (Car Rental App)

```typescript
// In car rental backend
async function createBooking(bookingData) {
  // 1. Create booking in rental database
  const booking = await db.bookings.create(bookingData);

  // 2. Charge rental fee via Wallet API
  const chargeResponse = await fetch('https://wallet-api.com/payments/charge', {
    method: 'POST',
    body: JSON.stringify({
      userId: booking.userId,
      amount: booking.rentalFee,
      currency: 'USD',
      paymentMethodNonce: bookingData.paymentNonce,
      productType: 'car_rental',
      sourceEntityType: 'rental_booking',
      sourceEntityId: booking.id, // Rental DB booking UUID
      idempotencyKey: `${booking.id}-rental-fee`
    })
  });

  // 3. Hold security deposit via Wallet API
  const authResponse = await fetch('https://wallet-api.com/payments/authorize', {
    method: 'POST',
    body: JSON.stringify({
      userId: booking.userId,
      amount: 500, // $500 deposit
      currency: 'USD',
      paymentMethodNonce: bookingData.paymentNonce,
      productType: 'car_rental',
      sourceEntityType: 'rental_deposit',
      sourceEntityId: booking.id,
      idempotencyKey: `${booking.id}-deposit`
    })
  });

  // 4. Store authorization IDs in rental database (non-FK UUIDs)
  await db.bookings.update(booking.id, {
    rentalFeeAuthId: chargeResponse.data.authorization.id,
    depositAuthId: authResponse.data.id
  });

  return booking;
}
```

---

## Monitoring & Logging

### Key Metrics to Track

- Authorization success rate
- Capture success rate
- Refund frequency
- Dispute rate
- Average settlement time
- Webhook processing time

### Logging Best Practices

```typescript
// Good - structured logging
console.log('[Payment] Authorization created', {
  authId: auth.id,
  userId: auth.userId,
  amount: auth.authorizedAmount,
  productType: auth.productType
});

// Bad - logging sensitive data
console.log('Card number:', cardNumber); // NEVER DO THIS
```
