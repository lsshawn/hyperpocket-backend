
## Handling Delayed Payouts

This is a core concept of financial ledger design: handling funds that are in-flight.

For a scenario with delayed payouts from a payment gateway like Stripe, it is best practice to credit the user's wallet immediately but distinguish between funds that are pending and funds that are available to spend. This gives the user immediate feedback that their deposit was successful, while protecting your system from letting them spend money you haven't actually received yet.

To achieve this, we can introduce an `availableBalance` to the `walletAccount`. Here's how it would work:

 1 Ledger Balance vs. Available Balance: The existing balance column will act as the ledger balance, which includes all funds (pending + available). We'll add a new availableBalance column for funds that have been settled and are spendable.
 2 Deposit Flow: When a user deposits money via Stripe, a transaction is created with a pending status. The deposited amount is added to their `walletAccount.balance`, but not to their `availableBalance`.
 3 Settlement Flow: When Stripe pays out the funds to you (e.g., 5 days later), you'll update the original transaction status to completed and add the amount to the user's `walletAccount.availableBalance`.

This way, the funds are always associated with the user's wallet, answering your question.

You don't need a separate "master wallet" table in your schema; this accounting model handles it cleanly.

