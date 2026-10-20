/**
 * Tracks finished SDK steps and Anthropic stream-start usage so Direct Chat
 * retains measured spend on Stop and in-stream provider errors.
 */

import { streamStartUsageOf } from "@repo/ai/lib/usage-logging-middleware";

type UsageDetails = {
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	reasoningTokens?: number;
};

type Usage = {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	inputTokenDetails?: UsageDetails;
	outputTokenDetails?: UsageDetails;
};

type CompletedStep = {
	usage: unknown;
	providerMetadata?: unknown;
};

function number(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usage(value: unknown): Usage {
	return value && typeof value === "object" ? (value as Usage) : {};
}

function hasTokenCounts(value: Usage): boolean {
	return [
		value.inputTokens,
		value.outputTokens,
		value.totalTokens,
		...Object.values(value.inputTokenDetails ?? {}),
		...Object.values(value.outputTokenDetails ?? {}),
	].some((count) => typeof count === "number" && Number.isFinite(count));
}

function sumUsage(current: Usage, next: Usage): Usage {
	return {
		inputTokens: number(current.inputTokens) + number(next.inputTokens),
		outputTokens: number(current.outputTokens) + number(next.outputTokens),
		totalTokens: number(current.totalTokens) + number(next.totalTokens),
		inputTokenDetails: {
			cacheReadTokens:
				number(current.inputTokenDetails?.cacheReadTokens) +
				number(next.inputTokenDetails?.cacheReadTokens),
			cacheWriteTokens:
				number(current.inputTokenDetails?.cacheWriteTokens) +
				number(next.inputTokenDetails?.cacheWriteTokens),
		},
		outputTokenDetails: {
			reasoningTokens:
				number(current.outputTokenDetails?.reasoningTokens) +
				number(next.outputTokenDetails?.reasoningTokens),
		},
	};
}

export function createDirectChatAggregateUsageTracker() {
	let aggregate: Usage | undefined;
	let pendingStreamStartUsage: Usage | undefined;
	let usedStreamStartUsage = false;
	let startedSteps = 0;
	const steps: { providerMetadata?: unknown }[] = [];

	return {
		startStep(): void {
			startedSteps++;
			pendingStreamStartUsage = undefined;
		},
		addStreamStartUsage(part: Record<string, unknown>): void {
			const reported = streamStartUsageOf(part);
			if (reported) {
				pendingStreamStartUsage = {
					inputTokens: reported.inputTokens.total,
					outputTokens: reported.outputTokens.total,
					totalTokens:
						reported.inputTokens.total +
						reported.outputTokens.total,
					inputTokenDetails: {
						cacheReadTokens: reported.inputTokens.cacheRead,
						cacheWriteTokens: reported.inputTokens.cacheWrite,
					},
				};
			}
		},
		addCompletedStep(step: CompletedStep): void {
			const completedUsage = usage(step.usage);
			if (pendingStreamStartUsage && !hasTokenCounts(completedUsage)) {
				aggregate = sumUsage(aggregate ?? {}, pendingStreamStartUsage);
				usedStreamStartUsage = true;
			} else {
				aggregate = sumUsage(aggregate ?? {}, completedUsage);
			}
			pendingStreamStartUsage = undefined;
			steps.push({ providerMetadata: step.providerMetadata });
		},
		partialAggregate(): {
			usage: Usage | undefined;
			usageReportedAt?: "stream_start";
			steps: { providerMetadata?: unknown }[];
		} {
			return {
				usage: pendingStreamStartUsage
					? sumUsage(aggregate ?? {}, pendingStreamStartUsage)
					: aggregate,
				// The row includes at least one step counted from stream-start usage;
				// output after that point for those steps is not counted.
				...((usedStreamStartUsage || pendingStreamStartUsage) && {
					usageReportedAt: "stream_start" as const,
				}),
				// A failed started step has no metadata, but it still makes the
				// whole turn multi-step. Keep a placeholder so callers cannot bind
				// the aggregate to a completed step's gateway generation id.
				steps: [
					...steps,
					...Array.from(
						{ length: Math.max(0, startedSteps - steps.length) },
						() => ({}),
					),
				],
			};
		},
	};
}
