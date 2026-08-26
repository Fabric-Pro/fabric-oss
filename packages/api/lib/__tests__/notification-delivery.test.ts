/**
 * Tests for `dispatchExternalDelivery` — the chokepoint's fire-and-forget
 * fan-out trigger.
 *
 * Must:
 *  - short-circuit (no Temporal call) when the recipient has no external
 *    channel enabled (AC-1 — the common in-app-only case);
 *  - start the delivery workflow with the correct enabled-channel flags when
 *    email and/or a fully-configured webhook is enabled (AC-2/AC-3);
 *  - treat webhook-enabled-without-URL as off.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDeliveryPrefs, start, getClient } = vi.hoisted(() => {
	const startFn = vi.fn();
	return {
		getDeliveryPrefs: vi.fn(),
		start: startFn,
		getClient: vi.fn(async () => ({ workflow: { start: startFn } })),
	};
});

vi.mock("@repo/database", () => ({
	getDeliveryPreferences: getDeliveryPrefs,
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: getClient,
}));
vi.mock("./temporal-correlation", () => ({
	withCorrelationMemo: (opts: unknown) => opts,
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { dispatchExternalDelivery } from "../notification-delivery";

const notification = { id: "n1", userId: "u1" };

beforeEach(() => {
	vi.clearAllMocks();
});

describe("dispatchExternalDelivery", () => {
	it("does NOT start a workflow when no external channel is enabled (AC-1)", async () => {
		getDeliveryPrefs.mockResolvedValue({
			emailEnabled: false,
			webhookEnabled: false,
			encryptedWebhookUrl: null,
			encryptedWebhookSecret: null,
		});
		await dispatchExternalDelivery(notification);
		expect(getClient).not.toHaveBeenCalled();
		expect(start).not.toHaveBeenCalled();
	});

	it("starts the delivery workflow with email-only channels (AC-2)", async () => {
		getDeliveryPrefs.mockResolvedValue({
			emailEnabled: true,
			webhookEnabled: false,
			encryptedWebhookUrl: null,
			encryptedWebhookSecret: null,
		});
		await dispatchExternalDelivery(notification);
		expect(start).toHaveBeenCalledTimes(1);
		const [workflowName, options] = start.mock.calls[0];
		expect(workflowName).toBe("notificationDeliveryWorkflow");
		expect(options.taskQueue).toBe("fabric-worker");
		expect(options.workflowId).toBe("notification-delivery-n1");
		expect(options.args[0]).toEqual({
			notificationId: "n1",
			channels: { email: true, webhook: false },
		});
	});

	it("treats webhook-enabled-without-URL as off (no dispatch)", async () => {
		getDeliveryPrefs.mockResolvedValue({
			emailEnabled: false,
			webhookEnabled: true,
			encryptedWebhookUrl: null,
			encryptedWebhookSecret: null,
		});
		await dispatchExternalDelivery(notification);
		expect(start).not.toHaveBeenCalled();
	});

	it("starts with webhook channel when a URL is configured (AC-3)", async () => {
		getDeliveryPrefs.mockResolvedValue({
			emailEnabled: false,
			webhookEnabled: true,
			encryptedWebhookUrl: "enc-url",
			encryptedWebhookSecret: "enc-secret",
		});
		await dispatchExternalDelivery(notification);
		expect(start).toHaveBeenCalledTimes(1);
		expect(start.mock.calls[0][1].args[0].channels).toEqual({
			email: false,
			webhook: true,
		});
	});
});
