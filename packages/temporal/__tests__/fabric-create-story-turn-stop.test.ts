/**
 * `fabric_create_story` inside a chat turn creates nothing once the turn has
 * stopped or used its token allowance.
 *
 * The tool runs as the Advisor runs it: inside the turn's dispatch guard
 * (`runWithTurnDispatch`, as the activity interceptor installs it) in an
 * activity context, with the REAL story creation path — the supplied-title
 * branch (no title generator), the work-item classifier and the drafting
 * call — sending through a factory-wrapped model (dispatch guard + turn
 * budget middleware). Only the stores and the provider are mocked.
 *
 * Before, each of those model calls sat behind a catch that turned the
 * refusal into a fallback (the classifier's FEATURE fallback, the drafting
 * failure's raw-field story), so the story was created and only the
 * activity's return-time backstop then failed the turn.
 */

import { wrapModelWithDispatchGuard } from "@repo/ai/lib/dispatch-guard-middleware";
import { wrapModelWithTurnBudget } from "@repo/ai/lib/turn-budget-middleware";
import { ApplicationFailure, CancelledFailure } from "@temporalio/common";
import { MockActivityEnvironment } from "@temporalio/testing";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	model: { current: undefined as unknown },
	checkDispatchable: vi.fn(),
	reserve: vi.fn(),
	createStory: vi.fn(),
	createFeatureVersion: vi.fn(),
	userStoryUpdate: vi.fn(),
	dispatchLifecycleEvent: vi.fn(),
	triggerDuplicateDetection: vi.fn(),
	enqueuePmSyncFromActivity: vi.fn(),
	resolveOpenAiApiKey: vi.fn(),
	logAiUsageAsync: vi.fn(),
	uploadFile: vi.fn(),
	providerCalls: 0,
	onProviderCall: undefined as undefined | ((call: number) => void),
}));

vi.mock("@repo/ai", async () => {
	const ai = await import("ai");
	class AIProviderNotConfiguredError extends Error {}
	return {
		tool: (definition: unknown) => definition,
		AUDIO_PROVIDER_REQUIRED: { textToSpeech: "text-to-speech refused" },
		resolveOpenAiApiKey: h.resolveOpenAiApiKey,
		AIProviderNotConfiguredError,
		createDecisionCapture: () => ({ run: (fn: () => unknown) => fn() }),
		experimental_decide: vi.fn(),
		// No organization decision model: the language classifier runs.
		getAIDecisionModelWithMetadata: vi.fn(async () => {
			throw new Error("no decision model configured");
		}),
		recordDecisionOutcome: vi.fn(),
		getAIModelWithMetadata: vi.fn(async () => ({
			model: h.model.current,
			metadata: { provider: "example" },
			trackUsage: vi.fn(),
		})),
		generateObject: ai.generateObject,
		logModelUsageAsync: vi.fn(),
	};
});

vi.mock("@repo/ai/lib/story-title-generator", () => ({
	generateStoryTitleFromDescription: vi.fn(async () => {
		throw new Error("a supplied title never calls the title generator");
	}),
	mapStoryTitleSourceToEnum: () => null,
	mapCreationSource: () => "API",
}));

vi.mock("@repo/database", () => ({
	logAiUsageAsync: h.logAiUsageAsync,
	// The turn guard and its ledger.
	checkConversationTurnDispatchable: h.checkDispatchable,
	reserveConversationTurnAttempt: h.reserve,
	settleConversationTurnAttempt: vi.fn(async () => ({
		outcome: "settled",
		status: "SETTLED",
	})),
	getConversationTurnLedgerSnapshot: vi.fn(async () => null),
	// The tool and story creation.
	canCreateProjectStory: vi.fn(async () => true),
	db: {
		organization: { findUnique: vi.fn(async () => ({ slug: "example" })) },
		userStory: { update: h.userStoryUpdate },
		project: {
			findUnique: vi.fn(async () => ({
				name: "Example project",
				description: null,
				projectManagementMcpConfigId: null,
				projectManagementContainerId: null,
			})),
		},
		promptVersion: { findFirst: vi.fn(async () => null) },
	},
	getMergedSearchProviderConfigs: vi.fn(),
	getSearchProviderConfig: vi.fn(),
	incrementOrganizationSearchProviderUsage: vi.fn(),
	incrementUserSearchProviderUsage: vi.fn(),
	buildBacklogDedupGuard: vi.fn(async () => ({
		findCollision: () => null,
	})),
	inferDedupFamily: () => "FEATURE",
	getBoundPromptForAgent: vi.fn(async (args: { agentName: string }) =>
		args.agentName === "work_item_classifier"
			? {
					key: "bug_classifier",
					format: "MARKDOWN",
					version: { content: "Classify this work item." },
				}
			: {
					key: "clean_spec_feature",
					format: "MARKDOWN",
					version: { content: "Draft this feature." },
				},
	),
	getPromptById: vi.fn(async () => null),
	createStory: h.createStory,
	createFeatureVersion: h.createFeatureVersion,
}));

vi.mock("@repo/rag", () => ({
	retrieveProjectContexts: vi.fn(async () => []),
	formatContextsForPrompt: vi.fn(() => ""),
}));
vi.mock("@repo/rag/lib/project-contexts/live-integration-context", () => ({
	fetchLiveIntegrationContext: vi.fn(async () => ({})),
	formatLiveContextForPrompt: vi.fn(() => null),
}));
vi.mock("@repo/search", () => ({ createProvider: vi.fn() }));
vi.mock("@repo/storage", () => ({ uploadFile: h.uploadFile }));
vi.mock("../src/lib/lifecycle-dispatcher", () => ({
	dispatchLifecycleEvent: h.dispatchLifecycleEvent,
}));
vi.mock("../src/lib/trigger-duplicate-detection", () => ({
	triggerDuplicateDetection: h.triggerDuplicateDetection,
}));
vi.mock("../src/lib/enqueue-pm-sync-from-activity", () => ({
	enqueuePmSyncFromActivity: h.enqueuePmSyncFromActivity,
}));
vi.mock("../src/client", () => ({ getTemporalClient: vi.fn() }));
vi.mock("../src/activities/direct-chat/rag-retrieval", () => ({
	retrieveWorkspaceDocumentsActivity: vi.fn(),
}));
vi.mock("../src/activities/orchestrator/utils", () => ({
	jsonSchemaToZod: () => ({}),
}));

const { createBuiltInTools } = await import(
	"../src/activities/direct-chat/built-in-tools"
);
const { runWithTurnDispatch, TURN_BUDGET_EXHAUSTED, TURN_NOT_DISPATCHABLE } =
	await import("../src/activities/orchestrator/turn-dispatch");

const SCOPE = {
	turnId: "turn-example-1",
	executionId: "orch-00000000-0000-4000-8000-000000000001",
	userId: "user-example-1",
	organizationId: "org-example-1",
	generation: 1,
	budgetContractVersion: 1,
};

const CLASSIFICATION = JSON.stringify({
	kind: "FEATURE",
	confidence: "High",
	fallback_used: false,
	primary_signals: ["new capability"],
	rationale: "asks for something new",
});
const DRAFT = JSON.stringify({
	description: "## Summary\nSaved searches.",
	acceptanceCriteria: "- A search can be saved",
});

const EXHAUSTED = {
	outcome: "exhausted",
	snapshot: {
		contractVersion: 1,
		allowance: 100_000,
		finalizationReserve: 8_000,
		measured: 92_000,
		outstanding: 0,
		enforcement: "ENFORCED",
	},
	room: 0,
	needed: 5_000,
};

let reservations = 0;
function reserved() {
	reservations += 1;
	return {
		outcome: "reserved",
		attemptId: `attempt-${reservations}`,
		reservedTokens: 3_000,
		outputCap: 2_000,
	};
}

beforeEach(() => {
	reservations = 0;
	h.providerCalls = 0;
	h.onProviderCall = undefined;
	for (const mock of [
		h.checkDispatchable,
		h.reserve,
		h.createStory,
		h.createFeatureVersion,
		h.userStoryUpdate,
		h.dispatchLifecycleEvent,
		h.triggerDuplicateDetection,
		h.enqueuePmSyncFromActivity,
	]) {
		mock.mockReset();
	}
	h.checkDispatchable.mockResolvedValue({ ok: true });
	h.reserve.mockImplementation(async () => reserved());
	h.createStory.mockResolvedValue({
		id: "story-example-1",
		identifier: "F-1",
		title: "Saved searches",
		statusId: "status-1",
		kind: "FEATURE",
	});
	h.createFeatureVersion.mockResolvedValue({ id: "version-1" });
	h.dispatchLifecycleEvent.mockResolvedValue({});
	h.triggerDuplicateDetection.mockResolvedValue({});
	h.model.current = wrapModelWithDispatchGuard(
		wrapModelWithTurnBudget(
			new MockLanguageModelV4({
				doGenerate: async () => {
					h.providerCalls += 1;
					h.onProviderCall?.(h.providerCalls);
					return {
						content: [
							{
								type: "text" as const,
								text:
									h.providerCalls === 1
										? CLASSIFICATION
										: DRAFT,
							},
						],
						finishReason: {
							unified: "stop" as const,
							raw: undefined,
						},
						usage: {
							inputTokens: {
								total: 40,
								noCache: 40,
								cacheRead: 0,
								cacheWrite: 0,
							},
							outputTokens: { total: 10, text: 10, reasoning: 0 },
						},
						warnings: [],
					};
				},
			}),
			{ enforcesOutputCap: true },
		),
	);
});

type Execute = (args: Record<string, unknown>) => Promise<unknown>;

/** Runs the tool with a supplied title, as a turn's activity runs it. */
async function createWithSuppliedTitle(
	onEnv?: (env: MockActivityEnvironment) => void,
): Promise<unknown> {
	const env = new MockActivityEnvironment();
	onEnv?.(env);
	const tools = (await createBuiltInTools({
		userId: SCOPE.userId,
		organizationId: SCOPE.organizationId,
		projectId: "project-example-1",
		enabledFabricToolIds: ["fabric_create_story"],
	})) as Record<string, { execute: Execute }>;
	return env
		.run(() =>
			runWithTurnDispatch(SCOPE, () =>
				tools.fabric_create_story.execute({
					title: "Saved searches",
					request: "Let people save a search and rerun it later.",
				}),
			),
		)
		.then(
			(value) => ({ resolvedWith: value }),
			(error: unknown) => error,
		);
}

function expectNothingCreated() {
	expect(h.createStory).not.toHaveBeenCalled();
	expect(h.createFeatureVersion).not.toHaveBeenCalled();
	expect(h.userStoryUpdate).not.toHaveBeenCalled();
	expect(h.dispatchLifecycleEvent).not.toHaveBeenCalled();
	expect(h.enqueuePmSyncFromActivity).not.toHaveBeenCalled();
	expect(h.triggerDuplicateDetection).not.toHaveBeenCalled();
}

function failureType(outcome: unknown): string | undefined {
	return outcome instanceof ApplicationFailure
		? (outcome.type ?? undefined)
		: undefined;
}

describe("fabric_create_story with a supplied title, inside a chat turn", () => {
	it("creates the story when nothing stops the turn", async () => {
		const outcome = await createWithSuppliedTitle();
		expect(outcome).toMatchObject({
			resolvedWith: { storyId: "story-example-1", aiDrafted: true },
		});
		expect(h.createStory).toHaveBeenCalledTimes(1);
	});

	it("creates no story when the classification is refused for the token allowance", async () => {
		h.reserve.mockResolvedValueOnce(EXHAUSTED);
		const outcome = await createWithSuppliedTitle();
		expect(failureType(outcome)).toBe(TURN_BUDGET_EXHAUSTED);
		expect(h.providerCalls).toBe(0);
		expectNothingCreated();
	});

	it("creates no story when the turn is stopped at the classification", async () => {
		h.checkDispatchable.mockResolvedValueOnce({
			ok: false,
			reason: "cancelled",
		});
		const outcome = await createWithSuppliedTitle();
		expect(failureType(outcome)).toBe(TURN_NOT_DISPATCHABLE);
		expectNothingCreated();
	});

	it("creates no story when the activity is cancelled during the classification", async () => {
		const outcome = await createWithSuppliedTitle((env) => {
			h.onProviderCall = (call) => {
				if (call === 1) {
					env.cancel();
					throw new Error("request aborted");
				}
			};
		});
		expect(outcome).toBeInstanceOf(CancelledFailure);
		expectNothingCreated();
	});

	it("creates no story when the activity is cancelled after the draft came back (the check right before the write)", async () => {
		const outcome = await createWithSuppliedTitle((env) => {
			h.onProviderCall = (call) => {
				if (call === 2) {
					// The draft is returned in full; the cancellation lands
					// between it and the write, with no catch in between.
					env.cancel();
				}
			};
		});
		expect(h.providerCalls).toBe(2);
		expect(outcome).toBeInstanceOf(CancelledFailure);
		expectNothingCreated();
	});

	it("creates no story when the drafting request is refused for the token allowance", async () => {
		h.reserve
			.mockImplementationOnce(async () => reserved())
			.mockResolvedValueOnce(EXHAUSTED);
		const outcome = await createWithSuppliedTitle();
		expect(failureType(outcome)).toBe(TURN_BUDGET_EXHAUSTED);
		// The classification ran; the drafting request was never sent.
		expect(h.providerCalls).toBe(1);
		expectNothingCreated();
	});
});

describe("fabric_text_to_speech inside a chat turn", () => {
	const originalFetch = global.fetch;
	const speechFetch = vi.fn(
		async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
	);

	beforeEach(() => {
		speechFetch.mockClear();
		h.uploadFile.mockReset();
		h.uploadFile.mockResolvedValue({});
		h.resolveOpenAiApiKey.mockReset();
		h.resolveOpenAiApiKey.mockResolvedValue("sk-example");
		global.fetch = speechFetch as unknown as typeof fetch;
	});

	afterEach(() => {
		global.fetch = originalFetch;
	});

	async function speak(onEnv?: (env: MockActivityEnvironment) => void) {
		const env = new MockActivityEnvironment();
		onEnv?.(env);
		const tools = (await createBuiltInTools({
			userId: SCOPE.userId,
			organizationId: SCOPE.organizationId,
			projectId: "project-example-1",
			enabledFabricToolIds: ["fabric_text_to_speech"],
		})) as Record<string, { execute: Execute }>;
		return env
			.run(() =>
				runWithTurnDispatch(SCOPE, () =>
					tools.fabric_text_to_speech.execute({
						text: "The launch moved to the 12th.",
					}),
				),
			)
			.then(
				(value) => ({ resolvedWith: value }),
				(error: unknown) => error,
			);
	}

	it("sends the speech request and stores the audio when nothing stops the turn", async () => {
		h.logAiUsageAsync.mockClear();
		const outcome = await speak();
		expect(outcome).toMatchObject({ resolvedWith: { format: "mp3" } });
		expect(speechFetch).toHaveBeenCalledTimes(1);
		expect(h.uploadFile).toHaveBeenCalledTimes(1);
		expect(h.logAiUsageAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				featureKey: "text-to-speech",
				taskType: "AUDIO",
				provider: "OPENAI_DIRECT",
				success: true,
			}),
		);
	});

	it("refuses with the provider message when the organization has no OpenAI key", async () => {
		h.resolveOpenAiApiKey.mockResolvedValue("");
		const outcome = await speak();
		expect(outcome).toEqual({
			resolvedWith: { error: "text-to-speech refused" },
		});
		expect(speechFetch).not.toHaveBeenCalled();
		expect(h.uploadFile).not.toHaveBeenCalled();
	});

	it("sends nothing when the activity is cancelled during the key lookup", async () => {
		const outcome = await speak((env) => {
			h.resolveOpenAiApiKey.mockImplementationOnce(async () => {
				env.cancel();
				return "sk-example";
			});
		});
		expect(outcome).toBeInstanceOf(CancelledFailure);
		expect(speechFetch).not.toHaveBeenCalled();
		expect(h.uploadFile).not.toHaveBeenCalled();
	});
});
