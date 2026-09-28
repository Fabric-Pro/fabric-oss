import type {
	AiUsageLimitDimension,
	AiUsageLimitEnforcement,
	AiUsageLimitWindow,
} from "@repo/database";

export interface AiUsageThresholdNotifierInput {
	limitId: string;
	organizationId: string | null;
	userId: string | null;
	createdById: string;
	windowStartIso: string;
	threshold: 80 | 100;
	dimension: AiUsageLimitDimension;
	window: AiUsageLimitWindow;
	enforcement: AiUsageLimitEnforcement;
	used: bigint;
	max: bigint;
	limitName: string | null;
}

export type AiUsageThresholdNotifier = (
	input: AiUsageThresholdNotifierInput,
) => Promise<void>;

let aiUsageThresholdNotifier: AiUsageThresholdNotifier | null = null;

export function setAiUsageThresholdNotifier(
	notifier: AiUsageThresholdNotifier | null,
): void {
	aiUsageThresholdNotifier = notifier;
}

export function getAiUsageThresholdNotifier(): AiUsageThresholdNotifier | null {
	return aiUsageThresholdNotifier;
}
