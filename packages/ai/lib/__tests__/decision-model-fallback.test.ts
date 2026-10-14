import { AiUsageLimitExceededError } from "@repo/payments/lib/ai-usage-limit-error";
import { APICallError, experimental_decide, RetryError } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type DecisionModelFallback,
	getDecisionModelFallbacks,
	withDecisionUsageLimits,
} from "../decision-model-fallback";

const CALL = {
	state: "example state",
	questions: {
		kind: {
			type: "boolean" as const,
			instructions: "Is it?",
		},
	},
};

function fakeModel() {
	const doDecide = vi.fn().mockResolvedValue({ answers: {}, warnings: [] });
	return {
		doDecide,
		model: {
			specificationVersion: "v4" as const,
			provider: "gateway",
			modelId: "openai/gpt-6-luna-decisions",
			supportedQuestionTypes: ["boolean" as const, "choice" as const],
			doDecide,
		},
	};
}

describe("getDecisionModelFallbacks", () => {
	it("offers Jev only for Luna reached through the system default", () => {
		expect(
			getDecisionModelFallbacks({
				selectionSource: "system_default",
				canonicalName: "gpt-6-luna-decisions",
			}).map((fallback) => fallback.providerModelId),
		).toEqual(["typesafe-ai/jev"]);
		expect(
			getDecisionModelFallbacks({
				selectionSource: "org_override",
				canonicalName: "gpt-6-luna-decisions",
			}),
		).toEqual([]);
		expect(
			getDecisionModelFallbacks({
				selectionSource: "system_default",
				canonicalName: "typesafe-ai-jev",
			}),
		).toEqual([]);
	});
});

function limitError(canonicalName: string) {
	return new AiUsageLimitExceededError({
		message: `AI usage limit exceeded for ${canonicalName}`,
		limitId: `limit-${canonicalName}`,
		dimension: "TOKENS" as never,
		window: "MONTHLY" as never,
		used: BigInt(10),
		max: BigInt(10),
		manageLimitsUrl: "https://example.com/limits",
	});
}

const PRIMARY = "gpt-6-luna-decisions";
const JEV: DecisionModelFallback = {
	providerModelId: "typesafe-ai/jev",
	canonicalName: "typesafe-ai-jev",
};

function limited(
	model: unknown,
	options: {
		fallbacks?: readonly DecisionModelFallback[];
		assertWithinLimits?: (name: string) => Promise<void>;
	} = {},
) {
	const assertWithinLimits = vi.fn(
		options.assertWithinLimits ?? (async () => {}),
	);
	return {
		assertWithinLimits,
		wrapped: withDecisionUsageLimits(model as any, {
			primaryCanonicalName: PRIMARY,
			fallbacks: options.fallbacks ?? [JEV],
			assertWithinLimits,
			organizationId: "org-1",
		}),
	};
}

describe("withDecisionUsageLimits", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps the caller's other gateway options when adding the fallback list", async () => {
		const { model, doDecide } = fakeModel();
		const { wrapped } = limited(model);

		await wrapped.doDecide({
			...CALL,
			providerOptions: {
				gateway: { tags: ["example"] },
				other: { flag: true },
			},
		} as any);

		expect(doDecide.mock.calls[0][0].providerOptions).toEqual({
			gateway: { tags: ["example"], models: ["typesafe-ai/jev"] },
			other: { flag: true },
		});
		expect(wrapped.modelId).toBe("openai/gpt-6-luna-decisions");
	});

	it("rejects a caller's own models list without checking or dispatching", async () => {
		const { model, doDecide } = fakeModel();
		const { wrapped, assertWithinLimits } = limited(model);

		await expect(
			wrapped.doDecide({
				...CALL,
				providerOptions: { gateway: { models: ["typesafe-ai/jev"] } },
			} as any),
		).rejects.toThrow(/caller-supplied gateway models list/);

		expect(doDecide).not.toHaveBeenCalled();
		expect(assertWithinLimits).not.toHaveBeenCalled();
	});

	it("adds no models key when there is no fallback, and still checks the primary on every call", async () => {
		const { model, doDecide } = fakeModel();
		const { wrapped, assertWithinLimits } = limited(model, {
			fallbacks: [],
		});

		await wrapped.doDecide(CALL as any);
		await wrapped.doDecide(CALL as any);

		expect(doDecide).toHaveBeenCalledTimes(2);
		for (const [sent] of doDecide.mock.calls) {
			expect(sent).toBe(CALL);
		}
		expect(assertWithinLimits.mock.calls.map(([name]) => name)).toEqual([
			PRIMARY,
			PRIMARY,
		]);
	});

	it("copies the contract fields even when the model exposes provider through a prototype getter", () => {
		class GetterModel {
			specificationVersion = "v4" as const;
			modelId = "openai/gpt-6-luna-decisions";
			supportedQuestionTypes = ["boolean" as const];
			get provider() {
				return "gateway";
			}
			doDecide = vi.fn();
		}
		const { wrapped } = limited(new GetterModel());

		expect(wrapped.provider).toBe("gateway");
		expect(wrapped.specificationVersion).toBe("v4");
		expect(wrapped.supportedQuestionTypes).toEqual(["boolean"]);
	});

	it("refuses a later call of a reused model once its limit is reached, and dispatches nothing then", async () => {
		const { model, doDecide } = fakeModel();
		const exhausted = limitError(PRIMARY);
		let checks = 0;
		const { wrapped } = limited(model, {
			fallbacks: [],
			assertWithinLimits: async () => {
				checks += 1;
				if (checks > 1) {
					throw exhausted;
				}
			},
		});

		await wrapped.doDecide(CALL as any);
		await expect(wrapped.doDecide(CALL as any)).rejects.toBe(exhausted);

		expect(doDecide).toHaveBeenCalledOnce();
	});

	it("propagates a non-limit failure of the primary's check without dispatching", async () => {
		const { model, doDecide } = fakeModel();
		const failure = new Error("limit store unavailable");
		const { wrapped, assertWithinLimits } = limited(model, {
			assertWithinLimits: async () => {
				throw failure;
			},
		});

		await expect(wrapped.doDecide(CALL as any)).rejects.toBe(failure);

		expect(doDecide).not.toHaveBeenCalled();
		// The fallback is never reached once the primary is refused.
		expect(assertWithinLimits).toHaveBeenCalledOnce();
	});

	it("drops a fallback whose limit is reached mid-run from that call only, and the primary still dispatches", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { model, doDecide } = fakeModel();
		let jevChecks = 0;
		const { wrapped } = limited(model, {
			assertWithinLimits: async (name) => {
				if (name === JEV.canonicalName) {
					jevChecks += 1;
					if (jevChecks > 1) {
						throw limitError(name);
					}
				}
			},
		});

		await wrapped.doDecide(CALL as any);
		await wrapped.doDecide(CALL as any);

		expect(doDecide).toHaveBeenCalledTimes(2);
		expect(doDecide.mock.calls[0][0].providerOptions).toEqual({
			gateway: { models: ["typesafe-ai/jev"] },
		});
		expect(doDecide.mock.calls[1][0]).toBe(CALL);
		expect("providerOptions" in doDecide.mock.calls[1][0]).toBe(false);
		expect(warn).toHaveBeenCalledOnce();
		expect(warn.mock.calls[0][1]).toEqual({
			organizationId: "org-1",
			fallbackCanonicalName: "typesafe-ai-jev",
			limitId: "limit-typesafe-ai-jev",
		});
	});

	it("propagates a non-limit failure of a fallback's check and dispatches nothing", async () => {
		const { model, doDecide } = fakeModel();
		const { wrapped } = limited(model, {
			assertWithinLimits: async (name) => {
				if (name === JEV.canonicalName) {
					throw new Error("limit store unavailable");
				}
			},
		});

		await expect(wrapped.doDecide(CALL as any)).rejects.toThrow(
			"limit store unavailable",
		);

		expect(doDecide).not.toHaveBeenCalled();
	});

	describe("with the real experimental_decide", () => {
		const QUESTIONS = {
			topic: {
				type: "choice" as const,
				instructions: "Which?",
				criteria: { a: "A", b: "B" },
			},
		};
		const ANSWER = {
			answers: {
				topic: {
					type: "choice" as const,
					choice: "a",
					probabilities: { a: 0.9, b: 0.1 },
				},
			},
			warnings: [],
		};
		const retryableFailure = () =>
			new APICallError({
				message: "gateway busy",
				url: "https://example.com",
				requestBodyValues: {},
				statusCode: 503,
				isRetryable: true,
				responseHeaders: { "retry-after-ms": "1" },
			});

		it("surfaces a decide-time limit error unwrapped, with retries enabled and no dispatch", async () => {
			const { model, doDecide } = fakeModel();
			const exhausted = limitError(PRIMARY);
			const { wrapped, assertWithinLimits } = limited(model, {
				assertWithinLimits: async () => {
					throw exhausted;
				},
			});

			const error = await experimental_decide({
				model: wrapped as any,
				state: "state",
				questions: QUESTIONS,
				maxRetries: 2,
			}).catch((caught: unknown) => caught);

			expect(error).toBe(exhausted);
			expect(error).toBeInstanceOf(AiUsageLimitExceededError);
			expect(doDecide).not.toHaveBeenCalled();
			// A non-retryable error is not retried by the SDK.
			expect(assertWithinLimits).toHaveBeenCalledOnce();
		});

		it("runs the limit check before each attempt of a retried call", async () => {
			const { model, doDecide } = fakeModel();
			const order: string[] = [];
			doDecide
				.mockImplementationOnce(async () => {
					order.push("dispatch");
					throw retryableFailure();
				})
				.mockImplementationOnce(async () => {
					order.push("dispatch");
					return ANSWER;
				});
			const { wrapped } = limited(model, {
				fallbacks: [],
				assertWithinLimits: async () => {
					order.push("check");
				},
			});

			await experimental_decide({
				model: wrapped as any,
				state: "state",
				questions: QUESTIONS,
				maxRetries: 2,
			});

			expect(order).toEqual(["check", "dispatch", "check", "dispatch"]);
		});

		// The SDK wraps any non-retryable error from attempt two onwards in a
		// RetryError (reason "errorNotRetryable"); only the first attempt's error
		// is rethrown as is. A bare `instanceof AiUsageLimitExceededError` on the
		// thrown value does not see a limit reached on a retry, which is why the
		// decision sites classify with `findAiUsageLimitError`. This test pins the
		// SDK behavior so a change to it is noticed.
		it("wraps a limit error refused on a retry in a RetryError whose last error is the limit error, with no second dispatch", async () => {
			const { model, doDecide } = fakeModel();
			const exhausted = limitError(PRIMARY);
			doDecide.mockRejectedValue(retryableFailure());
			let checks = 0;
			const { wrapped } = limited(model, {
				fallbacks: [],
				assertWithinLimits: async () => {
					checks += 1;
					if (checks > 1) {
						throw exhausted;
					}
				},
			});

			const error = await experimental_decide({
				model: wrapped as any,
				state: "state",
				questions: QUESTIONS,
				maxRetries: 2,
			}).catch((caught: unknown) => caught);

			expect(RetryError.isInstance(error)).toBe(true);
			expect((error as RetryError).reason).toBe("errorNotRetryable");
			expect((error as RetryError).lastError).toBe(exhausted);
			expect(doDecide).toHaveBeenCalledOnce();
		});
	});
});
