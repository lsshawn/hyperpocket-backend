# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Hyperpocket Backend is a **Wallet Microservice** implementing financial ledger logic for multi-product platforms (ride-hailing, rentals, deliveries, etc.). Built with Hono, TypeScript, Drizzle ORM, and PostgreSQL.

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

When integrating with multiple products (ride-hailing, rentals, etc.), the README suggests adding to the `transactions` table:

- `product_type`: pgEnum for the business line
- `source_entity_type`: table name from originating product
- `source_entity_id`: UUID of the entity (e.g., booking ID)
- `platform_ref`: globally unique reference for audit logs

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

## Future Enhancements (from README)

- Payment gateway integrations (Stripe pre-auth, captures, releases)
- Invoice table for periodic fee billing
- Authentication middleware (referenced in `kyc/routes.ts`)
- Support for partial captures (damage claims, etc.)
