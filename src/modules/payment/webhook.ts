import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db/index.js";
import {
	paymentAuthorization,
	transaction,
	walletAccount,
} from "../../db/schema.js";
import { gateway } from "./braintree-client.js";

const webhookRoutes = new Hono();

/**
 * POST /webhooks/braintree
 * Handle Braintree webhook notifications
 *
 * Webhook events we handle:
 * - subscription_charged_successfully
 * - subscription_charged_unsuccessfully
 * - transaction_settled
 * - transaction_settlement_declined
 * - transaction_disbursed
 * - dispute_opened
 * - dispute_lost
 * - dispute_won
 */
webhookRoutes.post("/braintree", async (c) => {
	try {
		const body = await c.req.parseBody();
		const btSignature = body.bt_signature as string;
		const btPayload = body.bt_payload as string;

		if (!btSignature || !btPayload) {
			return c.json({ error: "Missing bt_signature or bt_payload" }, 400);
		}

		// Verify webhook authenticity
		const webhookNotification = await gateway.webhookNotification.parse(
			btSignature,
			btPayload,
		);

		console.log(
			`[Webhook] Received: ${webhookNotification.kind} at ${webhookNotification.timestamp}`,
		);

		// Handle different webhook types
		switch (webhookNotification.kind) {
			case "transaction_settled":
				await handleTransactionSettled(webhookNotification);
				break;

			case "transaction_settlement_declined":
				await handleTransactionSettlementDeclined(webhookNotification);
				break;

			case "transaction_disbursed":
				await handleTransactionDisbursed(webhookNotification);
				break;

			case "dispute_opened":
				await handleDisputeOpened(webhookNotification);
				break;

			case "dispute_lost":
				await handleDisputeLost(webhookNotification);
				break;

			case "dispute_won":
				await handleDisputeWon(webhookNotification);
				break;

			default:
				console.log(
					`[Webhook] Unhandled event type: ${webhookNotification.kind}`,
				);
		}

		return c.json({ success: true, message: "Webhook processed" }, 200);
	} catch (error: any) {
		console.error("[Webhook] Error:", error);
		return c.json(
			{ error: "Webhook processing failed", details: error.message },
			500,
		);
	}
});

/**
 * Handle transaction_settled event
 * Updates authorization and transaction status to settled
 */
async function handleTransactionSettled(notification: any) {
	const btTransaction = notification.transaction;

	return db.transaction(async (tx) => {
		// Find authorization by gateway transaction ID
		const auth = await tx.query.paymentAuthorization.findFirst({
			where: eq(paymentAuthorization.gatewayTransactionId, btTransaction.id),
		});

		if (!auth) {
			console.log(
				`[Webhook] Authorization not found for transaction: ${btTransaction.id}`,
			);
			return;
		}

		// Update authorization status to settled
		await tx
			.update(paymentAuthorization)
			.set({
				status: "settled",
				updatedAt: new Date(),
			})
			.where(eq(paymentAuthorization.id, auth.id));

		// Update related transaction if exists
		const txn = await tx.query.transaction.findFirst({
			where: eq(transaction.platformRef, auth.platformRef),
		});

		if (txn) {
			await tx
				.update(transaction)
				.set({
					status: "completed",
					settledAt: new Date(),
					updatedAt: new Date(),
				})
				.where(eq(transaction.id, txn.id));
		}

		console.log(
			`[Webhook] Transaction settled: ${btTransaction.id} -> Authorization: ${auth.id}`,
		);
	});
}

/**
 * Handle transaction_settlement_declined event
 * Marks transaction as failed and reverses wallet balance
 */
async function handleTransactionSettlementDeclined(notification: any) {
	const btTransaction = notification.transaction;

	return db.transaction(async (tx) => {
		// Find authorization
		const auth = await tx.query.paymentAuthorization.findFirst({
			where: eq(paymentAuthorization.gatewayTransactionId, btTransaction.id),
		});

		if (!auth) {
			console.log(
				`[Webhook] Authorization not found for declined transaction: ${btTransaction.id}`,
			);
			return;
		}

		// Update authorization status
		await tx
			.update(paymentAuthorization)
			.set({
				status: "failed" as any, // Note: Need to add 'failed' to authorizationStatusEnum
				updatedAt: new Date(),
			})
			.where(eq(paymentAuthorization.id, auth.id));

		// Find related transaction
		const txn = await tx.query.transaction.findFirst({
			where: eq(transaction.platformRef, auth.platformRef),
		});

		if (txn && txn.status === "completed") {
			// Reverse the transaction
			await tx
				.update(transaction)
				.set({
					status: "failed",
					updatedAt: new Date(),
				})
				.where(eq(transaction.id, txn.id));

			// Reverse wallet balance
			const netAmount = txn.netAmount;
			await tx
				.update(walletAccount)
				.set({
					balance: sql`${walletAccount.balance} - ${netAmount}`,
					availableBalance: sql`${walletAccount.availableBalance} - ${netAmount}`,
				})
				.where(eq(walletAccount.id, txn.walletAccountId));

			console.log(
				`[Webhook] Transaction settlement declined and reversed: ${btTransaction.id}`,
			);
		}
	});
}

/**
 * Handle transaction_disbursed event
 * Funds have been transferred to merchant account (T+2 settlement complete)
 */
async function handleTransactionDisbursed(notification: any) {
	const btTransaction = notification.transaction;

	console.log(
		`[Webhook] Transaction disbursed (funds transferred): ${btTransaction.id}`,
	);

	// You can add custom logic here, such as:
	// - Sending notification to user
	// - Updating internal accounting records
	// - Triggering payout to hosts/drivers
}

/**
 * Handle dispute_opened event
 * Customer has initiated a chargeback/dispute
 */
async function handleDisputeOpened(notification: any) {
	const dispute = notification.dispute;

	return db.transaction(async (tx) => {
		// Find authorization by gateway transaction ID
		const auth = await tx.query.paymentAuthorization.findFirst({
			where: eq(
				paymentAuthorization.gatewayTransactionId,
				dispute.transaction.id,
			),
		});

		if (!auth) {
			console.log(
				`[Webhook] Authorization not found for disputed transaction: ${dispute.transaction.id}`,
			);
			return;
		}

		// Update authorization metadata with dispute info
		await tx
			.update(paymentAuthorization)
			.set({
				metadata: {
					...(auth.metadata as any),
					dispute: {
						id: dispute.id,
						status: "opened",
						amount: dispute.amount,
						reason: dispute.reason,
						openedAt: new Date(),
					},
				},
				updatedAt: new Date(),
			})
			.where(eq(paymentAuthorization.id, auth.id));

		console.log(
			`[Webhook] Dispute opened for transaction: ${dispute.transaction.id}, Reason: ${dispute.reason}`,
		);

		// TODO: Send notification to admin/support team
	});
}

/**
 * Handle dispute_lost event
 * Merchant lost the dispute - funds will be returned to customer
 */
async function handleDisputeLost(notification: any) {
	const dispute = notification.dispute;

	return db.transaction(async (tx) => {
		// Find authorization
		const auth = await tx.query.paymentAuthorization.findFirst({
			where: eq(
				paymentAuthorization.gatewayTransactionId,
				dispute.transaction.id,
			),
		});

		if (!auth) {
			console.log(
				`[Webhook] Authorization not found for lost dispute: ${dispute.transaction.id}`,
			);
			return;
		}

		// Update authorization metadata
		await tx
			.update(paymentAuthorization)
			.set({
				metadata: {
					...(auth.metadata as any),
					dispute: {
						...(auth.metadata as any)?.dispute,
						status: "lost",
						lostAt: new Date(),
					},
				},
				updatedAt: new Date(),
			})
			.where(eq(paymentAuthorization.id, auth.id));

		// Find related transaction and reverse balance
		const txn = await tx.query.transaction.findFirst({
			where: eq(transaction.platformRef, auth.platformRef),
		});

		if (txn) {
			// Mark transaction as reversed
			await tx
				.update(transaction)
				.set({
					status: "reversed",
					updatedAt: new Date(),
				})
				.where(eq(transaction.id, txn.id));

			// Reverse wallet balance
			const netAmount = txn.netAmount;
			await tx
				.update(walletAccount)
				.set({
					balance: sql`${walletAccount.balance} - ${netAmount}`,
					availableBalance: sql`${walletAccount.availableBalance} - ${netAmount}`,
				})
				.where(eq(walletAccount.id, txn.walletAccountId));

			console.log(
				`[Webhook] Dispute lost, transaction reversed: ${dispute.transaction.id}`,
			);
		}

		// TODO: Send notification to admin/support team
	});
}

/**
 * Handle dispute_won event
 * Merchant won the dispute - funds remain with merchant
 */
async function handleDisputeWon(notification: any) {
	const dispute = notification.dispute;

	return db.transaction(async (tx) => {
		// Find authorization
		const auth = await tx.query.paymentAuthorization.findFirst({
			where: eq(
				paymentAuthorization.gatewayTransactionId,
				dispute.transaction.id,
			),
		});

		if (!auth) {
			console.log(
				`[Webhook] Authorization not found for won dispute: ${dispute.transaction.id}`,
			);
			return;
		}

		// Update authorization metadata
		await tx
			.update(paymentAuthorization)
			.set({
				metadata: {
					...(auth.metadata as any),
					dispute: {
						...(auth.metadata as any)?.dispute,
						status: "won",
						wonAt: new Date(),
					},
				},
				updatedAt: new Date(),
			})
			.where(eq(paymentAuthorization.id, auth.id));

		console.log(
			`[Webhook] Dispute won for transaction: ${dispute.transaction.id}`,
		);

		// TODO: Send notification to admin/support team
	});
}

export default webhookRoutes;
