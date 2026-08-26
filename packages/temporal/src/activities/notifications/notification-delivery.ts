/**
 * Notification external-delivery activities.
 *
 * The in-app notification row already exists by the time these run — the API's
 * `createNotification` chokepoint inserts it, then fire-and-forgets the
 * `notificationDeliveryWorkflow`, which calls these activities. Each channel is
 * independent: a failure here never touches the in-app row and (via the
 * workflow's `Promise.allSettled`) never blocks the other channel (AC-5/AC-6).
 *
 * Webhook URL + signing secret are decrypted HERE, at the moment of use — never
 * passed through workflow input, so plaintext never lands in Temporal history.
 */

import { createHmac } from "node:crypto";
import {
	db,
	getDeliveryPreferences,
	type NotificationCategory,
	type NotificationType,
} from "@repo/database";
import { logger } from "@repo/logs";
import { sendEmail } from "@repo/mail";
import { decryptApiKey, toAbsoluteUrl } from "@repo/utils";
import { getUnsafeUrlReason } from "@repo/utils/url-security";

export type NotificationDeliveryActivityInput = {
	notificationId: string;
};

export type DeliveryOutcome =
	| { delivered: true }
	| { delivered: false; reason: string };

/** Header carrying the HMAC-SHA256 signature of the raw request body. */
const SIGNATURE_HEADER = "X-Fabric-Signature";
/** Header echoing the notification id — lets receivers dedupe retries. */
const DELIVERY_ID_HEADER = "X-Fabric-Delivery-Id";
/** Header naming the notification type for cheap receiver-side routing. */
const EVENT_HEADER = "X-Fabric-Event";

/** Resolve a notification link to an absolute URL for off-app consumers. */
function toAbsoluteLink(link: string | null): string | null {
	return link ? toAbsoluteUrl(link) : null;
}

type DeliveryNotification = {
	id: string;
	userId: string;
	type: NotificationType;
	category: NotificationCategory;
	title: string;
	snippet: string | null;
	link: string | null;
	projectId: string | null;
	storyId: string | null;
	taskId: string | null;
	commentId: string | null;
	documentId: string | null;
	actorUserId: string | null;
	createdAt: Date;
	actor: { id: string; name: string | null } | null;
};

async function loadNotification(
	notificationId: string,
): Promise<DeliveryNotification | null> {
	return db.notification.findUnique({
		where: { id: notificationId },
		select: {
			id: true,
			userId: true,
			type: true,
			category: true,
			title: true,
			snippet: true,
			link: true,
			projectId: true,
			storyId: true,
			taskId: true,
			commentId: true,
			documentId: true,
			actorUserId: true,
			createdAt: true,
			actor: { select: { id: true, name: true } },
		},
	});
}

/**
 * The JSON body POSTed to a user's webhook endpoint. Stable, documented shape
 * (Q2): event identity, human-readable title/snippet, an absolute deep link,
 * the acting user, a timestamp, and the source-entity pointers.
 */
export function buildWebhookPayload(notification: DeliveryNotification) {
	return {
		id: notification.id,
		notificationId: notification.id,
		type: notification.type,
		category: notification.category,
		title: notification.title,
		snippet: notification.snippet,
		link: toAbsoluteLink(notification.link),
		actor: notification.actor
			? { id: notification.actor.id, name: notification.actor.name }
			: null,
		createdAt: notification.createdAt.toISOString(),
		source: {
			projectId: notification.projectId,
			storyId: notification.storyId,
			taskId: notification.taskId,
			commentId: notification.commentId,
			documentId: notification.documentId,
		},
	};
}

/** Minimal, brand-neutral HTML body for the email channel (raw send mode). */
function buildEmailHtml(notification: DeliveryNotification): string {
	const link = toAbsoluteLink(notification.link);
	const snippet = notification.snippet
		? `<p style="margin:0 0 16px;color:#3f3f46;font-size:14px;line-height:1.6;">${escapeHtml(
				notification.snippet,
			)}</p>`
		: "";
	const button = link
		? `<p style="margin:24px 0 0;"><a href="${escapeHtml(
				link,
			)}" style="display:inline-block;background:#9F2A3A;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px;">View in Fabric</a></p>`
		: "";
	return `<div style="font-family:ui-sans-serif,system-ui,sans-serif;max-width:560px;margin:0 auto;padding:8px;"><h2 style="margin:0 0 12px;font-size:18px;color:#18181b;">${escapeHtml(
		notification.title,
	)}</h2>${snippet}${button}</div>`;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/**
 * Deliver a notification by email to the recipient's registered account
 * address. Per product decision there is NO email-verification gate — we send
 * to the address on file as-is. A failed render/send returns `{delivered:false}`
 * (sendEmail already swallows + logs); we never throw here, so email never
 * retries pointlessly and never blocks the webhook channel.
 */
export async function sendNotificationEmailActivity(
	input: NotificationDeliveryActivityInput,
): Promise<DeliveryOutcome> {
	const notification = await loadNotification(input.notificationId);
	if (!notification) {
		return { delivered: false, reason: "notification-not-found" };
	}

	const user = await db.user.findUnique({
		where: { id: notification.userId },
		select: { email: true },
	});
	if (!user?.email) {
		logger.warn(
			{
				channel: "email",
				notificationId: notification.id,
				type: notification.type,
				timestamp: new Date().toISOString(),
			},
			"[notification-delivery] email skipped — recipient has no address",
		);
		return { delivered: false, reason: "no-email-address" };
	}

	const ok = await sendEmail({
		to: user.email,
		subject: notification.title,
		html: buildEmailHtml(notification),
		text: notification.snippet ?? notification.title,
		idempotencyKey: `notif-email-${notification.id}`,
	});

	if (!ok) {
		// sendEmail returns false on provider/render failure (already logged).
		// Surface a structured delivery-failure line for observability (AC-10).
		logger.warn(
			{
				channel: "email",
				notificationId: notification.id,
				type: notification.type,
				timestamp: new Date().toISOString(),
			},
			"[notification-delivery] email send failed",
		);
		return { delivered: false, reason: "send-failed" };
	}

	return { delivered: true };
}

/**
 * Deliver a notification to the recipient's configured webhook endpoint.
 *
 * Signs the raw JSON body with HMAC-SHA256 using the per-user secret (decrypted
 * here) and POSTs it. A non-2xx response or network error is logged (AC-10) and
 * thrown so Temporal retries per the workflow's retry policy; after retries are
 * exhausted the workflow's `allSettled` absorbs the rejection so other channels
 * are unaffected.
 */
export async function sendNotificationWebhookActivity(
	input: NotificationDeliveryActivityInput,
): Promise<DeliveryOutcome> {
	const notification = await loadNotification(input.notificationId);
	if (!notification) {
		return { delivered: false, reason: "notification-not-found" };
	}

	const prefs = await getDeliveryPreferences(notification.userId);
	if (!prefs.webhookEnabled || !prefs.encryptedWebhookUrl) {
		// Defensive: dispatcher already gated on this, but prefs may have changed
		// between dispatch and execution.
		return { delivered: false, reason: "webhook-not-configured" };
	}

	const url = decryptApiKey(prefs.encryptedWebhookUrl);

	// SSRF guard (consistent with the repo's other user-URL outbound paths via
	// @repo/utils): public http(s) is allowed, but loopback/private/link-local
	// hosts and cloud-metadata endpoints (169.254.169.254, metadata.*) are
	// rejected. An unsafe URL is a permanent misconfiguration, so we log + give
	// up rather than throwing (which would trigger pointless retries). This does
	// not affect the other channels — the workflow fans out via allSettled.
	const unsafeReason = getUnsafeUrlReason(url);
	if (unsafeReason) {
		logger.warn(
			{
				channel: "webhook",
				notificationId: notification.id,
				type: notification.type,
				reason: unsafeReason,
				timestamp: new Date().toISOString(),
			},
			"[notification-delivery] webhook blocked — unsafe target URL",
		);
		return { delivered: false, reason: "unsafe-url" };
	}

	const body = JSON.stringify(buildWebhookPayload(notification));

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		[DELIVERY_ID_HEADER]: notification.id,
		[EVENT_HEADER]: notification.type,
	};
	if (prefs.encryptedWebhookSecret) {
		const secret = decryptApiKey(prefs.encryptedWebhookSecret);
		const signature = createHmac("sha256", secret)
			.update(body)
			.digest("hex");
		headers[SIGNATURE_HEADER] = `sha256=${signature}`;
	}

	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers,
			body,
			// Don't follow redirects — a redirect to an internal host would
			// bypass the SSRF check above. Cap the request so a slow endpoint
			// can't hold the activity slot until the Temporal timeout fires.
			redirect: "error",
			signal: AbortSignal.timeout(10_000),
		});
	} catch (error) {
		logger.warn(
			{
				channel: "webhook",
				notificationId: notification.id,
				type: notification.type,
				error: error instanceof Error ? error.message : String(error),
				timestamp: new Date().toISOString(),
			},
			"[notification-delivery] webhook request failed",
		);
		throw error;
	}

	if (!response.ok) {
		logger.warn(
			{
				channel: "webhook",
				notificationId: notification.id,
				type: notification.type,
				status: response.status,
				timestamp: new Date().toISOString(),
			},
			"[notification-delivery] webhook returned non-2xx",
		);
		throw new Error(`Webhook endpoint returned ${response.status}`);
	}

	return { delivered: true };
}
