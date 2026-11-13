/**
 * Email/webhook delivery for notifications a Temporal activity wrote itself.
 *
 * Pins the API chokepoint's rule: a recipient on in-app only starts nothing, a
 * webhook without an endpoint counts as off, the workflow id is the one the API
 * uses, and nothing it does can throw into the work that wrote the rows.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getDeliveryPreferences: vi.fn(),
	start: vi.fn(),
	getTemporalClient: vi.fn(),
	warn: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getDeliveryPreferences: mocks.getDeliveryPreferences,
}));

vi.mock("../../../client", () => ({
	getTemporalClient: mocks.getTemporalClient,
}));

vi.mock("../activity-logger", () => ({
	activityLogger: { info: vi.fn(), warn: mocks.warn, error: vi.fn() },
}));

import { startExternalNotificationDelivery } from "../notification-delivery-start";

const inAppOnly = {
	emailEnabled: false,
	webhookEnabled: false,
	encryptedWebhookUrl: null,
	encryptedWebhookSecret: null,
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getDeliveryPreferences.mockResolvedValue(inAppOnly);
	mocks.start.mockResolvedValue({ workflowId: "wf" });
	mocks.getTemporalClient.mockResolvedValue({
		workflow: { start: mocks.start },
	});
});

describe("startExternalNotificationDelivery", () => {
	it("starts the delivery workflow for each recipient who opted into a channel", async () => {
		mocks.getDeliveryPreferences.mockImplementation(
			async (userId: string) =>
				userId === "member"
					? { ...inAppOnly, emailEnabled: true }
					: {
							...inAppOnly,
							webhookEnabled: true,
							encryptedWebhookUrl: "enc-url",
						},
		);

		await startExternalNotificationDelivery([
			{ id: "n-1", userId: "member" },
			{ id: "n-2", userId: "owner" },
		]);

		expect(mocks.start).toHaveBeenCalledTimes(2);
		expect(mocks.start).toHaveBeenCalledWith(
			"notificationDeliveryWorkflow",
			{
				taskQueue: "fabric-worker",
				workflowId: "notification-delivery-n-1",
				workflowIdReusePolicy: "ALLOW_DUPLICATE",
				args: [
					{
						notificationId: "n-1",
						channels: { email: true, webhook: false },
					},
				],
			},
		);
		expect(mocks.start).toHaveBeenCalledWith(
			"notificationDeliveryWorkflow",
			expect.objectContaining({
				workflowId: "notification-delivery-n-2",
				args: [
					{
						notificationId: "n-2",
						channels: { email: false, webhook: true },
					},
				],
			}),
		);
	});

	it("starts nothing for a recipient on in-app only, or with a webhook but no endpoint", async () => {
		mocks.getDeliveryPreferences
			.mockResolvedValueOnce(inAppOnly)
			.mockResolvedValueOnce({ ...inAppOnly, webhookEnabled: true });

		await startExternalNotificationDelivery([
			{ id: "n-1", userId: "member" },
			{ id: "n-2", userId: "owner" },
		]);

		expect(mocks.getTemporalClient).not.toHaveBeenCalled();
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("never throws: one failed start is logged and the others still start", async () => {
		mocks.getDeliveryPreferences.mockResolvedValue({
			...inAppOnly,
			emailEnabled: true,
		});
		mocks.start
			.mockRejectedValueOnce(new Error("temporal unreachable"))
			.mockResolvedValueOnce({ workflowId: "wf" });

		await expect(
			startExternalNotificationDelivery([
				{ id: "n-1", userId: "member" },
				{ id: "n-2", userId: "owner" },
			]),
		).resolves.toBeUndefined();

		expect(mocks.start).toHaveBeenCalledTimes(2);
		expect(mocks.warn).toHaveBeenCalledTimes(1);
	});

	it("never throws when the preferences cannot be read", async () => {
		mocks.getDeliveryPreferences.mockRejectedValue(new Error("db down"));

		await expect(
			startExternalNotificationDelivery([
				{ id: "n-1", userId: "member" },
			]),
		).resolves.toBeUndefined();
		expect(mocks.warn).toHaveBeenCalledTimes(1);
	});
});
