import { metrics, SpanStatusCode, trace } from "@opentelemetry/api";
import {
	AggregationTemporality,
	InMemoryMetricExporter,
	MeterProvider,
	PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { AiUsageLimitExceededError } from "@repo/payments/lib/ai-usage-limit-error";
import {
	APICallError,
	Experimental_DecisionRefusalError,
	experimental_decide,
	InvalidResponseDataError,
} from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createDecisionCapture,
	decisionAnswerConfidence,
	decisionModelLabel,
	recordDecisionOutcome,
	wrapDecisionModelWithTelemetry,
} from "../decision-telemetry";
import type { DecisionModelInstance } from "../usage-logging-middleware";

const SENTINEL = "SENTINEL-4d1c9b7e-private-content";
const ORGANIZATION_ID = "org-opaque-7f3a";

let spanExporter: InMemorySpanExporter;
let tracerProvider: BasicTracerProvider;
let metricExporter: InMemoryMetricExporter;
let meterProvider: MeterProvider;

beforeEach(() => {
	trace.disable();
	metrics.disable();
	spanExporter = new InMemorySpanExporter();
	tracerProvider = new BasicTracerProvider({
		spanProcessors: [new SimpleSpanProcessor(spanExporter)],
	});
	trace.setGlobalTracerProvider(tracerProvider);
	metricExporter = new InMemoryMetricExporter(
		AggregationTemporality.CUMULATIVE,
	);
	meterProvider = new MeterProvider({
		readers: [
			new PeriodicExportingMetricReader({
				exporter: metricExporter,
				exportIntervalMillis: 60_000,
			}),
		],
	});
	metrics.setGlobalMeterProvider(meterProvider);
});

afterEach(async () => {
	await tracerProvider.shutdown();
	await meterProvider.shutdown();
	trace.disable();
	metrics.disable();
});

type DataPoint = { attributes: Record<string, unknown>; value: unknown };

async function exportedMetrics(): Promise<Map<string, DataPoint[]>> {
	await meterProvider.forceFlush();
	const exports = metricExporter.getMetrics();
	const latest = exports[exports.length - 1];
	const byName = new Map<string, DataPoint[]>();
	for (const metric of latest?.scopeMetrics.flatMap(
		(scope) => scope.metrics,
	) ?? []) {
		byName.set(
			metric.descriptor.name,
			metric.dataPoints.map((point) => ({
				attributes: point.attributes as Record<string, unknown>,
				value: point.value,
			})),
		);
	}
	return byName;
}

/** Everything an exporter could see: span attributes, events and status, metric names and labels. */
async function everythingExported(): Promise<string> {
	const metricData = await exportedMetrics();
	return JSON.stringify({
		spans: spanExporter.getFinishedSpans().map((span) => ({
			name: span.name,
			attributes: span.attributes,
			events: span.events,
			status: span.status,
		})),
		metrics: [...metricData].map(([name, points]) => ({
			name,
			labels: points.map((point) => point.attributes),
		})),
	});
}

const CONTEXT = {
	provider: "VERCEL_GATEWAY",
	requestModelId: "openai/example-luna-decider",
	organizationId: ORGANIZATION_ID,
	projectId: "proj-1",
	featureKey: "maturation",
	jobType: "meeting-transcript-sync",
};

function fakeDecisionModel(
	doDecide: DecisionModelInstance["doDecide"],
): DecisionModelInstance {
	return {
		specificationVersion: "v4",
		provider: "example-provider",
		modelId: "openai/example-luna-decider",
		supportedQuestionTypes: ["choice", "boolean"],
		doDecide,
	};
}

const SENTINEL_CALL = {
	state: { notes: SENTINEL, nested: [SENTINEL] },
	questions: {
		topic: {
			type: "choice" as const,
			instructions: `Decide using ${SENTINEL}`,
			criteria: { [`label-${SENTINEL}`]: `criterion ${SENTINEL}` },
		},
		related: {
			type: "boolean" as const,
			instructions: `Is it related? ${SENTINEL}`,
		},
	},
};

describe("wrapDecisionModelWithTelemetry", () => {
	it("opens one llm.decide span per doDecide with tokens, models, counts and org id", async () => {
		const result = {
			answers: {
				topic: {
					type: "choice" as const,
					choice: "a",
					probabilities: { a: 0.95, b: 0.05 },
				},
				related: { type: "refusal" as const },
			},
			usage: { inputTokens: 120, outputTokens: 9 },
			warnings: [],
			response: { modelId: "typesafe-ai/jev" },
		};
		const doDecide = vi.fn().mockResolvedValue(result);
		const wrapped = wrapDecisionModelWithTelemetry(
			fakeDecisionModel(doDecide),
			CONTEXT,
		);

		await expect(wrapped.doDecide(SENTINEL_CALL)).resolves.toBe(result);

		expect(doDecide).toHaveBeenCalledTimes(1);
		const spans = spanExporter.getFinishedSpans();
		expect(spans).toHaveLength(1);
		expect(spans[0].name).toBe("llm.decide");
		expect(spans[0].status.code).toBe(SpanStatusCode.OK);
		expect(spans[0].attributes).toEqual({
			"gen_ai.system": "VERCEL_GATEWAY",
			"gen_ai.request.model": "openai/example-luna-decider",
			"gen_ai.response.model": "typesafe-ai/jev",
			"gen_ai.usage.input_tokens": 120,
			"gen_ai.usage.output_tokens": 9,
			"llm.outcome": "success",
			"fabric.organization.id": ORGANIZATION_ID,
			"fabric.project.id": "proj-1",
			"fabric.feature_key": "maturation",
			"fabric.job_type": "meeting-transcript-sync",
			"llm.decision.question_count": 2,
			"llm.decision.refusal_count": 1,
		});

		const metricData = await exportedMetrics();
		expect(metricData.get("llm.requests")?.[0].attributes).toEqual({
			provider: "VERCEL_GATEWAY",
			model: "openai/example-luna-decider",
			operation: "decide",
			status: "success",
		});
		const tokenPoints = metricData.get("llm.tokens") ?? [];
		expect(
			tokenPoints.map((point) => [point.attributes.type, point.value]),
		).toEqual(
			expect.arrayContaining([
				["input", 120],
				["output", 9],
			]),
		);
		// organizationId is a span attribute only.
		expect(JSON.stringify([...metricData])).not.toContain(ORGANIZATION_ID);
	});

	it("records a thrown error as an error span and rethrows the same error", async () => {
		class ExampleGatewayError extends Error {}
		const error = new ExampleGatewayError(`gateway said ${SENTINEL}`);
		const wrapped = wrapDecisionModelWithTelemetry(
			fakeDecisionModel(vi.fn().mockRejectedValue(error)),
			CONTEXT,
		);

		await expect(wrapped.doDecide(SENTINEL_CALL)).rejects.toBe(error);

		const [span] = spanExporter.getFinishedSpans();
		expect(span.name).toBe("llm.decide");
		expect(span.status).toEqual({ code: SpanStatusCode.ERROR });
		expect(span.attributes).toMatchObject({
			"error.type": "ExampleGatewayError",
			"llm.outcome": "error",
			"gen_ai.usage.input_tokens": 0,
		});
		const metricData = await exportedMetrics();
		expect(metricData.get("llm.errors")?.[0].attributes).toEqual({
			provider: "VERCEL_GATEWAY",
			model: "openai/example-luna-decider",
			operation: "decide",
			error_type: "ExampleGatewayError",
		});
	});

	it("preserves the decision-model contract fields, including a prototype getter", () => {
		class GetterModel {
			readonly specificationVersion = "v4" as const;
			readonly modelId = "openai/example-luna-decider";
			readonly supportedQuestionTypes = ["choice" as const];
			get provider() {
				return "example-getter-provider";
			}
			async doDecide() {
				return { answers: {}, warnings: [] };
			}
		}
		const wrapped = wrapDecisionModelWithTelemetry(
			new GetterModel() as unknown as DecisionModelInstance,
			CONTEXT,
		);
		expect(wrapped.specificationVersion).toBe("v4");
		expect(wrapped.provider).toBe("example-getter-provider");
		expect(wrapped.modelId).toBe("openai/example-luna-decider");
		expect(wrapped.supportedQuestionTypes).toEqual(["choice"]);
	});

	it("passes a model without doDecide through unchanged", () => {
		const notAModel = { type: "not-a-decision-model" };
		expect(
			wrapDecisionModelWithTelemetry(
				notAModel as unknown as DecisionModelInstance,
				CONTEXT,
			),
		).toBe(notAModel);
	});

	it("returns the result untouched when it carries no usage, response or answers", async () => {
		const result = { warnings: [] };
		const wrapped = wrapDecisionModelWithTelemetry(
			fakeDecisionModel(vi.fn().mockResolvedValue(result)),
			CONTEXT,
		);
		await expect(wrapped.doDecide(SENTINEL_CALL)).resolves.toBe(result);
		const [span] = spanExporter.getFinishedSpans();
		expect(span.attributes["gen_ai.usage.input_tokens"]).toBe(0);
		expect(span.attributes).not.toHaveProperty("gen_ai.response.model");
	});

	it("never exports state, questions, labels, answers, or error messages", async () => {
		const wrapped = wrapDecisionModelWithTelemetry(
			fakeDecisionModel(
				vi
					.fn()
					.mockResolvedValueOnce({
						answers: {
							topic: {
								type: "choice",
								choice: `label-${SENTINEL}`,
								probabilities: { [`label-${SENTINEL}`]: 0.97 },
							},
							related: { type: "refusal" },
						},
						usage: { inputTokens: 5, outputTokens: 1 },
						warnings: [{ type: "other", message: SENTINEL }],
						response: { modelId: "typesafe-ai/jev" },
					})
					.mockRejectedValueOnce(
						new Error(`provider echoed ${SENTINEL}`),
					),
			),
			CONTEXT,
		);

		await wrapped.doDecide(SENTINEL_CALL);
		await expect(wrapped.doDecide(SENTINEL_CALL)).rejects.toThrow();

		expect(spanExporter.getFinishedSpans()).toHaveLength(2);
		const exported = await everythingExported();
		expect(exported).not.toContain(SENTINEL);
		// Sanity: the check above is looking at real telemetry.
		expect(exported).toContain("llm.decide");
		expect(exported).toContain(ORGANIZATION_ID);
	});
});

describe("decisionModelLabel", () => {
	const decisionModel = {
		metadata: {
			modelString: "openai/example-luna-decider",
			canonicalName: "example-luna-decisions",
		},
	};

	it("uses the requested model's canonical name when no other model answered", () => {
		expect(decisionModelLabel(decisionModel)).toBe(
			"example-luna-decisions",
		);
		expect(
			decisionModelLabel(decisionModel, {
				response: { modelId: "openai/example-luna-decider" },
			}),
		).toBe("example-luna-decisions");
	});

	it("uses the canonical name of a known gateway fallback that answered", () => {
		expect(
			decisionModelLabel(decisionModel, {
				response: { modelId: "typesafe-ai/jev" },
			}),
		).toBe("typesafe-ai-jev");
	});

	it("maps an answering model id that is neither requested nor a known fallback to unknown, and falls back to the model string", () => {
		expect(
			decisionModelLabel(decisionModel, {
				response: { modelId: "vendor/unlisted" },
			}),
		).toBe("unknown");
		// A captured label wins over the result.
		expect(
			decisionModelLabel(
				decisionModel,
				{ response: { modelId: "openai/example-luna-decider" } },
				"typesafe-ai-jev",
			),
		).toBe("typesafe-ai-jev");
		expect(
			decisionModelLabel({
				metadata: { modelString: "openai/example-luna-decider" },
			}),
		).toBe("openai/example-luna-decider");
		expect(decisionModelLabel({})).toBe("unknown");
	});

	it("labels a missing decision model as none", () => {
		expect(decisionModelLabel(undefined)).toBe("none");
	});
});

describe("decisionAnswerConfidence", () => {
	it("reads the chosen option's probability, and the likelier side of a boolean", () => {
		expect(
			decisionAnswerConfidence({
				type: "choice",
				choice: "a",
				probabilities: { a: 0.93, b: 0.07 },
			}),
		).toBe(0.93);
		expect(
			decisionAnswerConfidence({ type: "boolean", probability: 0.04 }),
		).toBeCloseTo(0.96);
		expect(
			decisionAnswerConfidence({ type: "boolean", probability: 0.8 }),
		).toBe(0.8);
	});

	it("returns undefined for anything unreadable", () => {
		for (const answer of [
			undefined,
			null,
			"text",
			{ type: "refusal" },
			{ type: "score", score: 1 },
			{ type: "choice", choice: "a" },
			{ type: "choice", choice: "z", probabilities: { a: 1 } },
			{ type: "choice", choice: "a", probabilities: { a: 1.2 } },
			{ type: "boolean", probability: Number.NaN },
		]) {
			expect(decisionAnswerConfidence(answer)).toBeUndefined();
		}
	});
});

describe("recordDecisionOutcome", () => {
	const decisionModel = {
		metadata: {
			modelString: "openai/example-luna-decider",
			canonicalName: "example-luna-decisions",
		},
	};
	const answered = {
		type: "choice",
		choice: "a",
		probabilities: { a: 0.97, b: 0.03 },
	};

	async function recordedOutcomes(): Promise<
		Array<{ site: string; outcome: string; model: string; count: unknown }>
	> {
		const metricData = await exportedMetrics();
		return (metricData.get("llm.decision.outcomes") ?? []).map((point) => ({
			site: String(point.attributes.site),
			outcome: String(point.attributes.outcome),
			model: String(point.attributes.model),
			count: point.value,
		}));
	}

	it("records an accepted outcome with the answering model and a confidence sample", async () => {
		recordDecisionOutcome({
			site: "classify-work-item",
			outcome: "accepted",
			decisionModel,
			result: { response: { modelId: "typesafe-ai/jev" } },
			answers: [answered],
		});

		expect(await recordedOutcomes()).toEqual([
			{
				site: "classify-work-item",
				outcome: "accepted",
				model: "typesafe-ai-jev",
				count: 1,
			},
		]);
		const confidence =
			(await exportedMetrics()).get("llm.decision.confidence") ?? [];
		expect(confidence[0].attributes).toEqual({
			site: "classify-work-item",
			model: "typesafe-ai-jev",
		});
		expect(confidence[0].value).toMatchObject({ count: 1, max: 0.97 });
	});

	it("derives the outcome from the error that ended the call", async () => {
		recordDecisionOutcome({
			site: "classify-work-item",
			decisionModel,
			error: new AiUsageLimitExceededError({
				message: "limit",
				limitId: "limit-1",
				dimension: "COST_USD" as never,
				window: "MONTHLY" as never,
				used: BigInt(1),
				max: BigInt(1),
				manageLimitsUrl: "https://example.com/limits",
			}),
		});
		recordDecisionOutcome({
			site: "classify-work-item",
			decisionModel,
			error: new Experimental_DecisionRefusalError({
				questionIds: ["q"],
				provider: "example-provider",
				modelId: "m",
			}),
		});
		recordDecisionOutcome({
			site: "classify-work-item",
			decisionModel,
			error: new Error(`boom ${SENTINEL}`),
		});

		const outcomes = (await recordedOutcomes()).map(
			(point) => point.outcome,
		);
		expect(outcomes.sort()).toEqual([
			"failed",
			"limit_exceeded",
			"refused",
		]);
		expect(await everythingExported()).not.toContain(SENTINEL);
	});

	it("treats an error before any decision model was resolved as unavailable, but keeps a usage limit", async () => {
		recordDecisionOutcome({
			site: "classify-work-item",
			error: new Error("no gateway"),
		});
		recordDecisionOutcome({
			site: "classify-work-item",
			error: new AiUsageLimitExceededError({
				message: "limit",
				limitId: "limit-1",
				dimension: "COST_USD" as never,
				window: "MONTHLY" as never,
				used: BigInt(1),
				max: BigInt(1),
				manageLimitsUrl: "https://example.com/limits",
			}),
		});

		const points = await recordedOutcomes();
		expect(points.map((point) => point.outcome).sort()).toEqual([
			"limit_exceeded",
			"unavailable",
		]);
		expect(points.every((point) => point.model === "none")).toBe(true);
	});

	it("records a below-threshold outcome with no readable confidence as malformed", async () => {
		recordDecisionOutcome({
			site: "classify-work-item",
			outcome: "below_threshold",
			decisionModel,
			answers: [{ type: "choice", choice: "a" }],
		});
		recordDecisionOutcome({
			site: "classify-work-item",
			outcome: "below_threshold",
			decisionModel,
			answers: [{ ...answered, probabilities: { a: 0.6 } }],
		});

		const outcomes = (await recordedOutcomes()).map(
			(point) => point.outcome,
		);
		expect(outcomes.sort()).toEqual(["below_threshold", "malformed"]);
	});

	it("adds the count for a batch that fell back as a whole", async () => {
		recordDecisionOutcome({
			site: "classify-work-item",
			outcome: "unavailable",
			count: 4,
		});
		const [point] = await recordedOutcomes();
		expect(point).toMatchObject({ outcome: "unavailable", count: 4 });
	});

	it("never throws on malformed input", () => {
		expect(() =>
			recordDecisionOutcome({
				site: "classify-work-item",
				outcome: "accepted",
				decisionModel: { metadata: null },
				result: { response: { modelId: 12 } },
				answers: [undefined, null, 5, { type: "choice" }],
			}),
		).not.toThrow();
		expect(() => recordDecisionOutcome(undefined as never)).not.toThrow();
	});
});

describe("provider-supplied model ids never become labels or attributes", () => {
	const requestedModel = {
		metadata: {
			modelString: "openai/example-luna-decider",
			canonicalName: "example-luna-decisions",
		},
	};
	const wrapperContext = {
		...CONTEXT,
		requestModelLabel: "example-luna-decisions",
	};

	function modelAnswering(modelId: string | undefined) {
		return fakeDecisionModel(
			vi.fn().mockResolvedValue({
				answers: {
					topic: {
						type: "choice",
						choice: `label-${SENTINEL}`,
						probabilities: { [`label-${SENTINEL}`]: 0.96 },
					},
				},
				usage: { inputTokens: 3, outputTokens: 1 },
				warnings: [],
				response: modelId === undefined ? undefined : { modelId },
			}),
		);
	}

	it("records an unknown response model as unknown on the span, in the capture and in every label", async () => {
		const wrapped = wrapDecisionModelWithTelemetry(
			modelAnswering(`${SENTINEL}-private-model-content`),
			wrapperContext,
		);
		const capture = createDecisionCapture();

		const result = await capture.run(() => wrapped.doDecide(SENTINEL_CALL));
		recordDecisionOutcome({
			site: "classify-work-item",
			outcome: "accepted",
			decisionModel: requestedModel,
			result: result as { response?: { modelId?: unknown } },
			capture,
			answers: [Object.values(result.answers)[0]],
		});

		const [span] = spanExporter.getFinishedSpans();
		expect(span.attributes["gen_ai.response.model"]).toBe("unknown");
		expect(span.attributes["gen_ai.request.model"]).toBe(
			"openai/example-luna-decider",
		);
		expect(capture.answeringModelLabel).toBe("unknown");
		const metricData = await exportedMetrics();
		expect(
			metricData.get("llm.decision.outcomes")?.[0].attributes.model,
		).toBe("unknown");
		expect(
			metricData.get("llm.decision.confidence")?.[0].attributes.model,
		).toBe("unknown");
		expect(await everythingExported()).not.toContain(SENTINEL);
	});

	it("falls back to the result's model when there is no capture, still without passing the id through", async () => {
		recordDecisionOutcome({
			site: "classify-work-item",
			outcome: "accepted",
			decisionModel: requestedModel,
			result: { response: { modelId: `${SENTINEL}-no-capture` } },
		});
		expect(await everythingExported()).not.toContain(SENTINEL);
		expect(
			(await exportedMetrics()).get("llm.decision.outcomes")?.[0]
				.attributes.model,
		).toBe("unknown");
	});

	it("collapses distinct unknown model ids into one series", async () => {
		for (const modelId of ["vendor/one", "vendor/two", `${SENTINEL}-3`]) {
			recordDecisionOutcome({
				site: "delivery-track",
				outcome: "accepted",
				decisionModel: requestedModel,
				result: { response: { modelId } },
				answers: [
					{ type: "choice", choice: "a", probabilities: { a: 0.95 } },
				],
			});
		}

		const metricData = await exportedMetrics();
		const outcomes = metricData.get("llm.decision.outcomes") ?? [];
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0].attributes.model).toBe("unknown");
		expect(outcomes[0].value).toBe(3);
		expect(metricData.get("llm.decision.confidence")).toHaveLength(1);
	});

	it("records the provider id of the requested model or a known fallback, and nothing else, as gen_ai.response.model", async () => {
		for (const modelId of [
			"openai/example-luna-decider",
			"typesafe-ai/jev",
			"vendor/unlisted",
		]) {
			const wrapped = wrapDecisionModelWithTelemetry(
				modelAnswering(modelId),
				wrapperContext,
			);
			await wrapped.doDecide(SENTINEL_CALL);
		}

		expect(
			spanExporter
				.getFinishedSpans()
				.map((span) => span.attributes["gen_ai.response.model"]),
		).toEqual([
			"openai/example-luna-decider",
			"typesafe-ai/jev",
			"unknown",
		]);
	});

	it("maps a site outside the fixed set to unknown", async () => {
		recordDecisionOutcome({
			site: `${SENTINEL}-site` as never,
			outcome: "accepted",
			decisionModel: requestedModel,
		});
		const [point] =
			(await exportedMetrics()).get("llm.decision.outcomes") ?? [];
		expect(point.attributes.site).toBe("unknown");
		expect(await everythingExported()).not.toContain(SENTINEL);
	});
});

describe("with the real experimental_decide", () => {
	const lunaModel = {
		metadata: {
			modelString: "openai/example-luna-decider",
			canonicalName: "example-luna-decisions",
		},
	};
	const context = {
		...CONTEXT,
		requestModelLabel: "example-luna-decisions",
	};
	const BOOLEAN_QUESTION = {
		related: { type: "boolean" as const, instructions: "Related?" },
	};
	const CHOICE_QUESTION = {
		topic: {
			type: "choice" as const,
			instructions: "Which?",
			criteria: { a: "A", b: "B" },
		},
	};

	/** Run the real SDK decide against a model whose only fake is doDecide. */
	async function decide(
		doDecide: DecisionModelInstance["doDecide"],
		questions: Record<string, unknown> = CHOICE_QUESTION,
		state: unknown = "state",
	) {
		const wrapped = wrapDecisionModelWithTelemetry(
			fakeDecisionModel(doDecide),
			context,
		);
		const capture = createDecisionCapture();
		try {
			await capture.run(() =>
				experimental_decide({
					model: wrapped,
					state: state as string,
					questions: questions as typeof CHOICE_QUESTION,
					maxRetries: 0,
				}),
			);
			return { capture, error: undefined };
		} catch (error) {
			return { capture, error };
		}
	}

	async function onlyOutcome() {
		const metricData = await exportedMetrics();
		const points = metricData.get("llm.decision.outcomes") ?? [];
		expect(points).toHaveLength(1);
		return points[0].attributes;
	}

	it("labels a refusal by the gateway fallback model with that model, not the requested one", async () => {
		const { capture, error } = await decide(
			vi.fn().mockResolvedValue({
				answers: { topic: { type: "refusal" } },
				warnings: [],
				response: { modelId: "typesafe-ai/jev" },
			}),
		);

		expect(Experimental_DecisionRefusalError.isInstance(error)).toBe(true);
		recordDecisionOutcome({
			site: "classify-work-item",
			error,
			decisionModel: lunaModel,
			capture,
		});

		expect(await onlyOutcome()).toEqual({
			site: "classify-work-item",
			outcome: "refused",
			model: "typesafe-ai-jev",
		});
	});

	it("without the capture the same refusal would be attributed to the requested model", async () => {
		const { error } = await decide(
			vi.fn().mockResolvedValue({
				answers: { topic: { type: "refusal" } },
				warnings: [],
				response: { modelId: "typesafe-ai/jev" },
			}),
		);
		recordDecisionOutcome({
			site: "classify-work-item",
			error,
			decisionModel: lunaModel,
		});

		expect((await onlyOutcome()).model).toBe("example-luna-decisions");
	});

	it("keeps concurrent decisions' models apart", async () => {
		let releaseFirst: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const answer = (modelId: string) => ({
			answers: { topic: { type: "refusal" as const } },
			warnings: [],
			response: { modelId },
		});
		const wrapped = wrapDecisionModelWithTelemetry(
			fakeDecisionModel(async (options) => {
				if (options.state === "first") {
					await gate;
					return answer("openai/example-luna-decider");
				}
				return answer("typesafe-ai/jev");
			}),
			context,
		);
		const first = createDecisionCapture();
		const second = createDecisionCapture();
		const run = (
			capture: ReturnType<typeof createDecisionCapture>,
			state: string,
		) =>
			capture
				.run(() =>
					experimental_decide({
						model: wrapped,
						state,
						questions: CHOICE_QUESTION,
						maxRetries: 0,
					}),
				)
				.catch(() => undefined);

		const firstRun = run(first, "first");
		await run(second, "second");
		// The second decision has fully finished while the first is in flight.
		expect(second.answeringModelLabel).toBe("typesafe-ai-jev");
		expect(first.answeringModelLabel).toBeUndefined();
		releaseFirst();
		await firstRun;

		expect(first.answeringModelLabel).toBe("example-luna-decisions");
		expect(second.answeringModelLabel).toBe("typesafe-ai-jev");
	});

	it("lets the latest round trip decide the label, so a later attempt that fails does not inherit an earlier model", async () => {
		const doDecide = vi
			.fn()
			.mockResolvedValueOnce({
				answers: { topic: { type: "refusal" } },
				warnings: [],
				response: { modelId: "typesafe-ai/jev" },
			})
			.mockRejectedValueOnce(new Error("gateway unavailable"));
		const wrapped = wrapDecisionModelWithTelemetry(
			fakeDecisionModel(doDecide),
			context,
		);
		const capture = createDecisionCapture();

		await capture.run(async () => {
			await wrapped.doDecide(SENTINEL_CALL);
			expect(capture.answeringModelLabel).toBe("typesafe-ai-jev");
			await expect(wrapped.doDecide(SENTINEL_CALL)).rejects.toThrow();
		});

		expect(capture.answeringModelLabel).toBeUndefined();
	});

	it.each([
		[
			"a boolean answer with no probability",
			BOOLEAN_QUESTION,
			{ related: { type: "boolean" } },
		],
		[
			"a choice outside the options",
			CHOICE_QUESTION,
			{ topic: { type: "choice", choice: "zzz" } },
		],
		[
			"a distribution that does not sum to 1",
			CHOICE_QUESTION,
			{
				topic: {
					type: "choice",
					choice: "a",
					probabilities: { a: 0.6, b: 0.1 },
				},
			},
		],
		["a missing answer", CHOICE_QUESTION, {}],
	])(
		"records %s as malformed, not failed",
		async (_name, questions, answers) => {
			const { capture, error } = await decide(
				vi.fn().mockResolvedValue({
					answers,
					warnings: [],
					response: { modelId: "typesafe-ai/jev" },
				}),
				questions,
			);

			expect(InvalidResponseDataError.isInstance(error)).toBe(true);
			recordDecisionOutcome({
				site: "link-action-items",
				error,
				decisionModel: lunaModel,
				capture,
			});

			expect(await onlyOutcome()).toEqual({
				site: "link-action-items",
				outcome: "malformed",
				model: "typesafe-ai-jev",
			});
		},
	);

	it("keeps transport, HTTP, abort and invalid-input errors as failed", async () => {
		const httpError = new APICallError({
			message: "server error",
			url: "https://example.com/decision-model",
			requestBodyValues: {},
			statusCode: 502,
			isRetryable: false,
		});
		const abort = new DOMException("aborted", "AbortError");
		const cases = [
			await decide(vi.fn().mockRejectedValue(httpError)),
			await decide(
				vi.fn().mockRejectedValue(new Error("socket hang up")),
			),
			await decide(vi.fn().mockRejectedValue(abort)),
			// The SDK rejects the call itself, before any model round trip.
			await decide(vi.fn(), CHOICE_QUESTION, Symbol("not json")),
		];

		for (const { capture, error } of cases) {
			expect(error).toBeDefined();
			expect(InvalidResponseDataError.isInstance(error)).toBe(false);
			recordDecisionOutcome({
				site: "delivery-track",
				error,
				decisionModel: lunaModel,
				capture,
			});
		}

		const points =
			(await exportedMetrics()).get("llm.decision.outcomes") ?? [];
		expect(points.map((point) => point.attributes.outcome)).toEqual([
			"failed",
		]);
		expect(points[0].value).toBe(4);
	});
});
