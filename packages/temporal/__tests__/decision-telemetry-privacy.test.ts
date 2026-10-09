/**
 * Privacy property of AI decision telemetry, end to end through two real
 * decision call sites.
 *
 * The decision model wrapper, the AI SDK's real `experimental_decide`, the
 * call-site recording helper and the real OpenTelemetry instruments all run
 * here; only the network edge (the model's `doDecide`), the database and the
 * language-model fallback are faked. A unique sentinel is planted everywhere
 * the sites put content: the decision `state`, a question's instructions, and
 * a question's criteria, plus in a provider error message. No exported span
 * attribute, span event, span status or metric label may contain it.
 *
 * The same harness also checks attribution: a refusal by a gateway fallback
 * model is labelled with that model although the SDK throws, and an answer
 * the SDK rejects as invalid is `malformed`.
 *
 * Guards: the `llm.decide` span and its attributes
 * (`packages/ai/lib/decision-telemetry.ts` `wrapDecisionModelWithTelemetry`),
 * the span/metric code in `packages/observability/lib/instrumentations/llm.ts`
 * and the recording calls in the two sites.
 */
import { metrics, trace } from "@opentelemetry/api";
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SENTINEL = "SENTINEL-9c2e41f7-private-content";

const { mocks, AIProviderNotConfiguredError } = vi.hoisted(() => {
	class AIProviderNotConfiguredError extends Error {}
	return {
		AIProviderNotConfiguredError,
		mocks: {
			getBoundPromptForAgent: vi.fn(),
			renderTemplate: vi.fn(),
			generateObject: vi.fn(),
			getAIModelWithMetadata: vi.fn(),
			getAIDecisionModelWithMetadata: vi.fn(),
			doDecide: vi.fn(),
			listActiveStories: vi.fn(),
			loggedWarnings: [] as unknown[][],
		},
	};
});

vi.mock("@repo/ai", async () => {
	const telemetry = await vi.importActual<
		typeof import("@repo/ai/lib/decision-telemetry")
	>("@repo/ai/lib/decision-telemetry");
	const sdk = await vi.importActual<typeof import("ai")>("ai");
	return {
		AIProviderNotConfiguredError,
		experimental_decide: sdk.experimental_decide,
		generateObject: mocks.generateObject,
		getAIModelWithMetadata: mocks.getAIModelWithMetadata,
		getAIDecisionModelWithMetadata: mocks.getAIDecisionModelWithMetadata,
		resolveModelWithProvider: vi.fn(),
		recordDecisionOutcome: telemetry.recordDecisionOutcome,
		createDecisionCapture: telemetry.createDecisionCapture,
	};
});

vi.mock("@repo/payments/lib/ai-usage-limit-error", () => ({
	AiUsageLimitExceededError: class AiUsageLimitExceededError extends Error {},
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/utils", () => ({ renderTemplate: mocks.renderTemplate }));

vi.mock("@repo/rag", () => ({ generateEmbeddings: vi.fn() }));

vi.mock("@repo/database", async () => {
	const pure = await vi.importActual<
		typeof import("@repo/database/prisma/queries/projects/action-item-routing")
	>("@repo/database/prisma/queries/projects/action-item-routing");
	const detection = await vi.importActual<
		typeof import("@repo/database/prisma/queries/projects/duplicate-detection")
	>("@repo/database/prisma/queries/projects/duplicate-detection");
	return {
		...detection,
		...pure,
		setAiUsageRecorder: vi.fn(),
		db: {},
		getBoundPromptForAgent: mocks.getBoundPromptForAgent,
		listActiveStoriesForDetection: mocks.listActiveStories,
		listStoryDuplicateEmbeddingMetadata: vi.fn(),
		listStoryDuplicateEmbeddings: vi.fn(),
		upsertStoryDuplicateEmbeddings: vi.fn(),
	};
});

import { wrapDecisionModelWithTelemetry } from "@repo/ai/lib/decision-telemetry";
import { judgeRoutingItem } from "../src/lib/backlog-routing-core";
import { classifyWorkItem } from "../src/lib/classify-work-item";

let spanExporter: InMemorySpanExporter;
let tracerProvider: BasicTracerProvider;
let metricExporter: InMemoryMetricExporter;
let meterProvider: MeterProvider;

const METADATA = {
	provider: "VERCEL_GATEWAY",
	modelString: "openai/example-decider",
	canonicalName: "example-decider",
};

/** A decision model resolved the way production resolves one: telemetry-wrapped. */
function resolvedDecisionModel() {
	const model = wrapDecisionModelWithTelemetry(
		{
			specificationVersion: "v4",
			provider: "example-provider",
			modelId: METADATA.modelString,
			supportedQuestionTypes: ["choice", "score", "boolean"],
			doDecide: mocks.doDecide,
		},
		{
			provider: METADATA.provider,
			requestModelId: METADATA.modelString,
			requestModelLabel: METADATA.canonicalName,
			organizationId: "org-opaque-1",
			projectId: "proj-1",
		},
	);
	return { model, metadata: METADATA, trackUsage: vi.fn() };
}

async function everythingExported(): Promise<string> {
	await meterProvider.forceFlush();
	const exports = metricExporter.getMetrics();
	const latest = exports[exports.length - 1];
	return JSON.stringify({
		spans: spanExporter.getFinishedSpans().map((span) => ({
			name: span.name,
			attributes: span.attributes,
			events: span.events,
			status: span.status,
			links: span.links,
		})),
		metrics: (latest?.scopeMetrics ?? [])
			.flatMap((scope) => scope.metrics)
			.map((metric) => ({
				name: metric.descriptor.name,
				description: metric.descriptor.description,
				labels: metric.dataPoints.map((point) => point.attributes),
			})),
	});
}

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

	vi.clearAllMocks();
	mocks.getBoundPromptForAgent.mockResolvedValue({
		key: "bug_classifier",
		format: "MARKDOWN",
		version: { content: "template" },
	});
	mocks.renderTemplate.mockResolvedValue({
		rendered: `policy mentioning ${SENTINEL}`,
		error: null,
	});
	mocks.getAIModelWithMetadata.mockResolvedValue({
		model: {},
		metadata: undefined,
		trackUsage: vi.fn(),
	});
	mocks.generateObject.mockResolvedValue({
		object: { decision: "create", confidence: 1 },
		usage: {},
	});
	mocks.getAIDecisionModelWithMetadata.mockImplementation(async () =>
		resolvedDecisionModel(),
	);
});

afterEach(async () => {
	await tracerProvider.shutdown();
	await meterProvider.shutdown();
	trace.disable();
	metrics.disable();
});

const WORK_ITEM = {
	reporterText: `Bug report ${SENTINEL}`,
	additionalContext: `Context ${SENTINEL}`,
	creationSource: "MANUAL" as const,
	userId: "user-1",
	organizationId: "org-opaque-1",
	projectId: "proj-1",
};

const TICKET = {
	id: "story-a",
	identifier: "F-1",
	title: `Ticket title ${SENTINEL}`,
	description: `Ticket body ${SENTINEL}`,
	acceptanceCriteria: null,
	createdAt: new Date("2026-01-01"),
	tasks: [],
};

async function routeItem(
	decisionModel: ReturnType<typeof resolvedDecisionModel>,
) {
	return judgeRoutingItem({
		itemText: `Action item ${SENTINEL}`,
		analyzerReasoning: `Reasoning ${SENTINEL}`,
		itemEmbedding: [1, 0],
		candidateVectors: [
			{ id: TICKET.id, identifier: TICKET.identifier, embedding: [1, 0] },
		],
		storyById: new Map([[TICKET.id, TICKET]]) as never,
		textByStoryId: new Map([
			[TICKET.id, `${TICKET.title}\n${TICKET.description}`],
		]),
		judge: {
			model: {} as never,
			metadata: undefined as never,
			trackUsage: vi.fn(),
		},
		decisionModel: decisionModel as never,
		threshold: 0.7,
		userId: "user-1",
		organizationId: "org-opaque-1",
		projectId: "proj-1",
		logPrefix: "[Test]",
	});
}

describe("decision telemetry privacy", () => {
	it("exports no state, instruction, criterion, answer or error text from an accepted work-item classification", async () => {
		mocks.doDecide.mockResolvedValue({
			answers: {
				workItemKind: {
					type: "choice",
					choice: "BUG",
					probabilities: { BUG: 0.96, FEATURE: 0.04 },
				},
			},
			usage: { inputTokens: 80, outputTokens: 5 },
			warnings: [],
			response: { modelId: METADATA.modelString },
		});

		const result = await classifyWorkItem(WORK_ITEM);

		expect(result.rationale).toBe("decision_evaluation");
		// The sentinel really did reach the model call: it is in the state.
		const sent = JSON.stringify(mocks.doDecide.mock.calls[0][0]);
		expect(sent).toContain(SENTINEL);

		const exported = await everythingExported();
		expect(exported).not.toContain(SENTINEL);
		// Positive controls: the telemetry under test is present.
		expect(exported).toContain("llm.decide");
		expect(exported).toContain("llm.decision.outcomes");
		expect(exported).toContain("classify-work-item");
		expect(exported).toContain("llm.decision.confidence");
	});

	it("exports no content from a routing decision whose criteria and state carry the sentinel, across success, fallback and error", async () => {
		// 1. A confident enrich: target criteria carry ticket title and body.
		mocks.doDecide.mockResolvedValueOnce({
			answers: {
				routing: {
					type: "choice",
					choice: "enrich",
					probabilities: { create: 0.02, enrich: 0.98 },
				},
				target: {
					type: "choice",
					choice: "F-1",
					probabilities: { "F-1": 1 },
				},
			},
			usage: { inputTokens: 200, outputTokens: 8 },
			warnings: [],
			response: { modelId: "typesafe-ai/jev" },
		});
		const accepted = await routeItem(resolvedDecisionModel());
		expect(accepted.kind).toBe("enrich");

		// 2. An uncertain answer: the language judge runs.
		mocks.doDecide.mockResolvedValueOnce({
			answers: {
				routing: {
					type: "choice",
					choice: "create",
					probabilities: { create: 0.55, enrich: 0.45 },
				},
				target: {
					type: "choice",
					choice: "F-1",
					probabilities: { "F-1": 1 },
				},
			},
			usage: { inputTokens: 200, outputTokens: 8 },
			warnings: [],
		});
		await routeItem(resolvedDecisionModel());

		// 3. A provider error whose message echoes the sentinel.
		mocks.doDecide.mockRejectedValueOnce(
			new Error(`provider echoed ${SENTINEL}`),
		);
		await routeItem(resolvedDecisionModel());

		const criteriaSent = JSON.stringify(
			(mocks.doDecide.mock.calls[0][0] as { questions: unknown })
				.questions,
		);
		expect(criteriaSent).toContain(SENTINEL);

		const exported = await everythingExported();
		expect(exported).not.toContain(SENTINEL);
		expect(exported).toContain("backlog-routing");
		expect(exported).toContain("below_threshold");
		expect(exported).toContain("failed");
		// Sanity: three model round trips, three spans.
		expect(
			spanExporter
				.getFinishedSpans()
				.filter((span) => span.name === "llm.decide"),
		).toHaveLength(3);
	});

	it("the sentinel check can fail: a span attribute carrying decision state is caught", async () => {
		// Control for the assertions above: prove the harness would notice a
		// leak, so a pass is not an artifact of looking in the wrong place.
		const span = trace.getTracer("control").startSpan("control");
		span.setAttribute("leaked", `state ${SENTINEL}`);
		span.end();

		expect(await everythingExported()).toContain(SENTINEL);
	});
});

describe("decision outcome attribution through the real SDK", () => {
	async function outcomes() {
		await meterProvider.forceFlush();
		const exports = metricExporter.getMetrics();
		const latest = exports[exports.length - 1];
		return (latest?.scopeMetrics ?? [])
			.flatMap((scope) => scope.metrics)
			.filter(
				(metric) => metric.descriptor.name === "llm.decision.outcomes",
			)
			.flatMap((metric) =>
				(
					metric.dataPoints as Array<{
						attributes: object;
						value: unknown;
					}>
				).map((point) => ({ ...point.attributes, count: point.value })),
			);
	}

	it("labels a refusal by the gateway fallback model with that model, even though the SDK throws", async () => {
		mocks.doDecide.mockResolvedValue({
			answers: { workItemKind: { type: "refusal" } },
			warnings: [],
			response: { modelId: "typesafe-ai/jev" },
		});

		await classifyWorkItem(WORK_ITEM);

		expect(await outcomes()).toEqual([
			{
				site: "classify-work-item",
				outcome: "refused",
				model: "typesafe-ai-jev",
				count: 1,
			},
		]);
	});

	it("records an answer the SDK rejects as invalid as malformed, labelled with the model that answered", async () => {
		mocks.doDecide.mockResolvedValue({
			answers: {
				workItemKind: { type: "choice", choice: "NOT_AN_OPTION" },
			},
			warnings: [],
			response: { modelId: METADATA.modelString },
		});

		await classifyWorkItem(WORK_ITEM);

		expect(await outcomes()).toEqual([
			{
				site: "classify-work-item",
				outcome: "malformed",
				model: "example-decider",
				count: 1,
			},
		]);
	});

	it("attributes a routing refusal by the fallback model to that model", async () => {
		mocks.doDecide.mockResolvedValue({
			answers: {
				routing: { type: "refusal" },
				target: { type: "refusal" },
			},
			warnings: [],
			response: { modelId: "typesafe-ai/jev" },
		});

		await routeItem(resolvedDecisionModel());

		expect(await outcomes()).toEqual([
			{
				site: "backlog-routing",
				outcome: "refused",
				model: "typesafe-ai-jev",
				count: 1,
			},
		]);
	});
});
