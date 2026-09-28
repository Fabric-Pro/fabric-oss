import type { AiUsageThresholdNotifier } from "@repo/payments/ai-usage-threshold-notifier";
import { expect, it, vi } from "vitest";

const { setNotifierMock, loadNotificationServiceMock, fanOutMock } = vi.hoisted(
	() => ({
		setNotifierMock: vi.fn<(notifier: AiUsageThresholdNotifier) => void>(),
		loadNotificationServiceMock: vi.fn(),
		fanOutMock: vi.fn().mockResolvedValue(undefined),
	}),
);

vi.mock("@repo/payments/ai-usage-threshold-notifier", () => ({
	setAiUsageThresholdNotifier: setNotifierMock,
}));
vi.mock("@repo/api/lib/notification-service", () => {
	loadNotificationServiceMock();
	return { fanOut: { aiUsageThreshold: fanOutMock } };
});

it("registers immediately and loads notification delivery on the first threshold", async () => {
	await import("../app/register-ai-usage-threshold-notifier");
	expect(setNotifierMock).toHaveBeenCalledOnce();
	expect(loadNotificationServiceMock).not.toHaveBeenCalled();

	const notifier = setNotifierMock.mock.calls[0]?.[0];
	expect(notifier).toBeDefined();
	const input: Parameters<AiUsageThresholdNotifier>[0] = {
		limitId: "limit-1",
		organizationId: null,
		userId: "user-1",
		createdById: "user-1",
		windowStartIso: "2026-09-28T00:00:00.000Z",
		threshold: 80,
		dimension: "TOKENS",
		window: "MONTHLY",
		enforcement: "HARD",
		used: 80n,
		max: 100n,
		limitName: "Monthly token limit",
	};
	await notifier?.(input);
	expect(loadNotificationServiceMock).toHaveBeenCalledOnce();
	expect(fanOutMock).toHaveBeenCalledWith(input);
});
