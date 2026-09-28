import { setAiUsageThresholdNotifier } from "@repo/payments/ai-usage-threshold-notifier";

setAiUsageThresholdNotifier(async (input) => {
	const { fanOut } = await import("@repo/api/lib/notification-service");
	await fanOut.aiUsageThreshold(input);
});
