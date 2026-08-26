/**
 * Tests for the notification external-delivery activities.
 *
 * Email: sends to the recipient's account address (no verification gate) and
 * never throws (AC-2). Webhook: signs the raw body with HMAC-SHA256 in the
 * `X-Fabric-Signature` header, POSTs, and throws on non-2xx so Temporal retries
 * (AC-3/AC-6/AC-10). Mocks the DB, mail, encryption, and global fetch.
 */

import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	findNotification,
	findUser,
	getDeliveryPrefs,
	sendEmail,
	unsafeReason,
} = vi.hoisted(() => ({
	findNotification: vi.fn(),
	findUser: vi.fn(),
	getDeliveryPrefs: vi.fn(),
	sendEmail: vi.fn(),
	unsafeReason: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		notification: { findUnique: findNotification },
		user: { findUnique: findUser },
	},
	getDeliveryPreferences: getDeliveryPrefs,
}));
vi.mock("@repo/mail", () => ({ sendEmail }));
const TEST_BASE_URL = "https://app.fabric.test";
vi.mock("@repo/utils", () => ({
	// Identity decrypt keeps the test's expected signature easy to compute.
	decryptApiKey: (value: string) => value,
	getBaseUrl: () => TEST_BASE_URL,
	// Mirrors the real helper against the pinned base above. Its resolution
	// rules are covered by packages/utils/__tests__/base-url.test.ts; these
	// tests are about the delivery payload, so it is stubbed at the boundary.
	toAbsoluteUrl: (path: string) =>
		/^https?:\/\//i.test(path)
			? path
			: `${TEST_BASE_URL}${path.startsWith("/") ? "" : "/"}${path}`,
}));
vi.mock("@repo/utils/url-security", () => ({
	getUnsafeUrlReason: (url: string) => unsafeReason(url),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
	buildWebhookPayload,
	sendNotificationEmailActivity,
	sendNotificationWebhookActivity,
} from "../notification-delivery";

const NOTIFICATION = {
	id: "n1",
	userId: "u1",
	type: "STORY_MENTION",
	category: "MENTION",
	title: "You were mentioned",
	snippet: "Hey @you take a look",
	link: "/app/stories/s1",
	projectId: "p1",
	storyId: "s1",
	taskId: null,
	commentId: "c1",
	documentId: null,
	actorUserId: "actor1",
	createdAt: new Date("2026-06-25T10:00:00.000Z"),
	actor: { id: "actor1", name: "Ada" },
};

beforeEach(() => {
	vi.clearAllMocks();
	findNotification.mockResolvedValue({ ...NOTIFICATION });
	findUser.mockResolvedValue({ email: "user@example.com" });
	getDeliveryPrefs.mockResolvedValue({
		emailEnabled: true,
		webhookEnabled: true,
		encryptedWebhookUrl: "https://hooks.example.com/fabric",
		encryptedWebhookSecret: "topsecret",
	});
	sendEmail.mockResolvedValue(true);
	unsafeReason.mockReturnValue(null); // URL is safe by default
	global.fetch = vi.fn();
});

describe("sendNotificationEmailActivity", () => {
	it("sends to the recipient's account email with an idempotency key (AC-2)", async () => {
		const result = await sendNotificationEmailActivity({
			notificationId: "n1",
		});
		expect(result).toEqual({ delivered: true });
		const arg = sendEmail.mock.calls[0][0];
		expect(arg.to).toBe("user@example.com");
		expect(arg.subject).toBe("You were mentioned");
		expect(arg.idempotencyKey).toBe("notif-email-n1");
	});

	it("returns delivered:false without throwing when the address is missing", async () => {
		findUser.mockResolvedValue({ email: null });
		const result = await sendNotificationEmailActivity({
			notificationId: "n1",
		});
		expect(result).toEqual({
			delivered: false,
			reason: "no-email-address",
		});
		expect(sendEmail).not.toHaveBeenCalled();
	});

	it("returns delivered:false (never throws) when the provider send fails", async () => {
		sendEmail.mockResolvedValue(false);
		const result = await sendNotificationEmailActivity({
			notificationId: "n1",
		});
		expect(result).toEqual({ delivered: false, reason: "send-failed" });
	});
});

describe("buildWebhookPayload", () => {
	it("includes the documented fields with an absolute deep link (Q2)", () => {
		const payload = buildWebhookPayload(NOTIFICATION as never);
		expect(payload).toMatchObject({
			notificationId: "n1",
			type: "STORY_MENTION",
			category: "MENTION",
			title: "You were mentioned",
			link: "https://app.fabric.test/app/stories/s1",
			actor: { id: "actor1", name: "Ada" },
			createdAt: "2026-06-25T10:00:00.000Z",
			source: {
				projectId: "p1",
				storyId: "s1",
				taskId: null,
				commentId: "c1",
				documentId: null,
			},
		});
	});
});

describe("sendNotificationWebhookActivity", () => {
	it("POSTs a body signed with HMAC-SHA256 in X-Fabric-Signature (AC-3)", async () => {
		(global.fetch as any).mockResolvedValue({ ok: true, status: 200 });

		const result = await sendNotificationWebhookActivity({
			notificationId: "n1",
		});
		expect(result).toEqual({ delivered: true });

		const [url, init] = (global.fetch as any).mock.calls[0];
		expect(url).toBe("https://hooks.example.com/fabric");
		expect(init.method).toBe("POST");
		expect(init.headers["Content-Type"]).toBe("application/json");
		expect(init.headers["X-Fabric-Delivery-Id"]).toBe("n1");
		expect(init.headers["X-Fabric-Event"]).toBe("STORY_MENTION");

		// Signature matches HMAC-SHA256(secret, rawBody).
		const expectedBody = JSON.stringify(
			buildWebhookPayload(NOTIFICATION as never),
		);
		const expectedSig = `sha256=${createHmac("sha256", "topsecret")
			.update(expectedBody)
			.digest("hex")}`;
		expect(init.headers["X-Fabric-Signature"]).toBe(expectedSig);
		expect(init.body).toBe(expectedBody);
	});

	it("throws on a non-2xx response so Temporal retries (AC-6/AC-10)", async () => {
		(global.fetch as any).mockResolvedValue({ ok: false, status: 500 });
		await expect(
			sendNotificationWebhookActivity({ notificationId: "n1" }),
		).rejects.toThrow(/500/);
	});

	it("blocks an unsafe (SSRF) target URL without fetching or throwing", async () => {
		unsafeReason.mockReturnValue("Localhost access is not allowed");
		const result = await sendNotificationWebhookActivity({
			notificationId: "n1",
		});
		expect(result).toEqual({ delivered: false, reason: "unsafe-url" });
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it("skips (no throw) when webhook is no longer configured", async () => {
		getDeliveryPrefs.mockResolvedValue({
			emailEnabled: false,
			webhookEnabled: false,
			encryptedWebhookUrl: null,
			encryptedWebhookSecret: null,
		});
		const result = await sendNotificationWebhookActivity({
			notificationId: "n1",
		});
		expect(result).toEqual({
			delivered: false,
			reason: "webhook-not-configured",
		});
		expect(global.fetch).not.toHaveBeenCalled();
	});
});
