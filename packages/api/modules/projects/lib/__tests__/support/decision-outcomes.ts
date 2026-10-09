/**
 * Capture of decision-site telemetry for tests that mock `@repo/ai`.
 *
 * A decision call site reports through `recordDecisionOutcome` from
 * `@repo/ai`. These tests mock that package, so by default the report would
 * go nowhere. Instead the `@repo/ai` mock hands the site the REAL helper (via
 * the `@repo/ai/lib/decision-telemetry` subpath, which the root mock does not
 * cover), and the `@repo/observability/llm` mock below captures what the real
 * helper would have exported. A test therefore asserts the outcome, model and
 * confidence samples that would actually reach the metrics, not just that the
 * site called a function.
 *
 * Wire it in a test file with:
 *
 *   vi.mock("@repo/observability/llm", async () =>
 *     (await import("./test-helpers/decision-outcomes")).observabilityLlmMock());
 *   vi.mock("@repo/ai", async () => ({
 *     ...,
 *     recordDecisionOutcome: await realRecordDecisionOutcome(),
 *   }));
 */
import { vi } from "vitest";

export interface CapturedDecisionOutcome {
	site: string;
	outcome: string;
	model: string;
	confidences?: readonly number[];
	count?: number;
}

/** Every record the real helper passed to the instrumentation, in call order. */
export const capturedDecisionOutcomes: CapturedDecisionOutcome[] = [];

export function resetCapturedDecisionOutcomes(): void {
	capturedDecisionOutcomes.length = 0;
}

export function observabilityLlmMock() {
	return {
		llmInstrumentation: {
			startInvocation: () => ({
				succeed: () => {},
				fail: () => {},
				cancel: () => {},
			}),
			recordDecisionOutcome: (record: CapturedDecisionOutcome) => {
				capturedDecisionOutcomes.push(record);
			},
		},
	};
}

export async function realRecordDecisionOutcome() {
	const actual = await vi.importActual<
		typeof import("@repo/ai/lib/decision-telemetry")
	>("@repo/ai/lib/decision-telemetry");
	return actual.recordDecisionOutcome;
}

export async function realCreateDecisionCapture() {
	const actual = await vi.importActual<
		typeof import("@repo/ai/lib/decision-telemetry")
	>("@repo/ai/lib/decision-telemetry");
	return actual.createDecisionCapture;
}

/**
 * Drop-in `experimental_decide` mock: the real SDK decides against a
 * telemetry-wrapped model that was asked for `openai/example-decider` but
 * whose gateway fell back to Jev, which refuses. The SDK throws its refusal
 * error, so the call site gets no result; only the request-scoped capture
 * knows Jev answered.
 */
export async function decideWithFallbackRefusal(
	args: Parameters<typeof import("ai").experimental_decide>[0],
) {
	const telemetry = await vi.importActual<
		typeof import("@repo/ai/lib/decision-telemetry")
	>("@repo/ai/lib/decision-telemetry");
	const sdk = await vi.importActual<typeof import("ai")>("ai");
	const model = telemetry.wrapDecisionModelWithTelemetry(
		{
			specificationVersion: "v4",
			provider: "example-provider",
			modelId: "openai/example-decider",
			supportedQuestionTypes: ["choice", "score", "boolean"],
			doDecide: async ({ questions }) => ({
				answers: Object.fromEntries(
					Object.keys(questions).map((id) => [
						id,
						{ type: "refusal" as const },
					]),
				),
				warnings: [],
				response: { modelId: "typesafe-ai/jev" },
			}),
		},
		{
			provider: "VERCEL_GATEWAY",
			requestModelId: "openai/example-decider",
			requestModelLabel: "example-decider",
		},
	);
	return sdk.experimental_decide({ ...args, model });
}
