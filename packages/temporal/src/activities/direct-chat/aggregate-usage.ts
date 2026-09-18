/**
 * Tracks finished SDK steps so a later stream failure can still charge the
 * completed provider calls as one Direct Chat turn.
 */

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
	let startedSteps = 0;
	const steps: { providerMetadata?: unknown }[] = [];

	return {
		startStep(): void {
			startedSteps++;
		},
		addCompletedStep(step: CompletedStep): void {
			aggregate = sumUsage(aggregate ?? {}, usage(step.usage));
			steps.push({ providerMetadata: step.providerMetadata });
		},
		partialAggregate(): {
			usage: Usage | undefined;
			steps: { providerMetadata?: unknown }[];
		} {
			return {
				usage: aggregate,
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
