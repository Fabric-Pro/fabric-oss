import { createHash } from "node:crypto";
import type {
	AzureDevOpsSprintCapture,
	AzureDevOpsStorySnapshot,
} from "@repo/connectors";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	workflow: vi.fn(),
	execution: vi.fn(),
	history: vi.fn(),
	connection: vi.fn(),
	assigned: vi.fn(),
	snapshots: vi.fn(),
	sprint: vi.fn(),
	model: vi.fn(),
	generate: vi.fn(),
	evaluator: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	getWorkflowById: mocks.workflow,
	getWorkflowExecutionById: mocks.execution,
	listAdoReviewBaselines: mocks.history,
	getFrameById: vi.fn(),
}));
vi.mock("@repo/mcp/lib/project-pm-read", () => ({
	resolveProjectPmRead: mocks.connection,
}));
vi.mock("@repo/connectors", () => ({
	listAzureDevOpsAssignedStories: mocks.assigned,
	getAzureDevOpsStorySnapshots: mocks.snapshots,
	captureAzureDevOpsSprintStories: mocks.sprint,
	AzureDevOpsProjectReadError: class extends Error {
		constructor(public readonly code: string) {
			super(code);
		}
	},
}));
vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: mocks.model,
	generateText: mocks.generate,
}));
vi.mock("../../../../lib/ado-story-review-evaluator", () => ({
	loadReviewEvaluator: mocks.evaluator,
}));

import { AzureDevOpsProjectReadError } from "@repo/connectors";
import { adoStoryReviewConfigSchema } from "../../../../lib/ado-story-review-config";
import type { StepParams } from "../../../types";
import {
	directReviewCacheSchema,
	reviewCacheSchema,
	selectReviewBaseline,
} from "../../ado-story-review/data";
import { executeAdoStoryReviewStep } from "../mcp-review-ado-stories";

const asOf = "2026-01-02T12:00:00.000Z";
const target = {
	organization: "example-org",
	projectId: "ado-project-1",
	projectName: "Example",
};
const selection = {
	iterationPaths: ["Example\\Sprint 1", "Example\\Sprint 2"],
	assignmentFields: ["Custom.Engineer", "System.AssignedTo"],
	assignedItemTypes: ["Task", "Bug"],
	parentSourceTypes: ["Bug", "Task"],
	relationKinds: ["related", "child"],
	excludedAssignedStates: ["Removed"],
};

function sha256(text: string) {
	return createHash("sha256").update(text).digest("hex");
}

function item(id: number, type = "User Story"): AzureDevOpsStorySnapshot {
	return {
		id,
		rev: 1,
		workItemType: type,
		title: `Item ${id}`,
		state: "Active",
		assignedTo: null,
		changedDate: asOf,
		requirementsAsOf: asOf,
		complete: true,
		requirements: {
			"System.Description": "TBD",
			"Custom.BusinessRules": `Requirement for ${id}`,
		},
		sourceUrl: `https://dev.azure.com/example-org/example/_workitems/edit/${id}`,
		comments: {
			complete: true,
			incompleteReason: null,
			consistency: "two_matching_reads",
			atomicAsOf: false,
			captureStartedAt: asOf,
			capturedAt: asOf,
			comments: [
				{
					id: 1,
					version: 1,
					modifiedDate: asOf,
					isDeleted: false,
					fullText: `PO answer for ${id}`,
					format: "markdown",
				},
			],
		},
	};
}

function graph(): AzureDevOpsSprintCapture {
	return {
		requirementsAsOf: asOf,
		discoveryComplete: true,
		complete: true,
		incompleteReason: null,
		unreadItemIds: [],
		assignedItems: [
			{
				id: 10,
				workItemType: "Task",
				state: "Active",
				assignedTo: null,
				engineer: "member@example.com",
				iterationPath: "Example\\Sprint 1",
				sourceUrl: item(10).sourceUrl,
				discovery: {
					reason: "assignment_query",
					assignmentFields: ["Custom.Engineer", "System.AssignedTo"],
					matchedAssignmentFields: ["Custom.Engineer"],
				},
				parentResolution: "parent_followed",
				parentCandidates: [
					{ id: 1, workItemType: "User Story", included: true },
				],
				storyIds: [1],
			},
		],
		stories: [
			{
				story: item(1),
				discoverySources: [{ assignedItemId: 10, kind: "parent" }],
				contextItems: [item(2, "AA Task"), item(3, "Task")],
				edges: [
					{ sourceId: 1, targetId: 2, kind: "child" },
					{ sourceId: 1, targetId: 3, kind: "related" },
				],
			},
		],
	};
}

function params(sprintContext: unknown = selection): StepParams {
	return {
		userId: "user-1",
		organizationId: "org-1",
		projectId: "project-1",
		workflowId: "workflow-1",
		executionId: "execution-1",
		nodeId: "review-1",
		jobType: "workflow-builder",
		inputs: {},
		nodeConfig: {
			assignee: { mode: "current" },
			rubric: "Check completeness.",
			requirementFields: ["Custom.BusinessRules", "System.Description"],
			...(sprintContext === undefined ? {} : { sprintContext }),
		},
	};
}

function authorize(input: StepParams) {
	mocks.workflow.mockResolvedValue({
		id: input.workflowId,
		userId: input.userId,
		organizationId: input.organizationId,
		projectId: input.projectId,
		version: 1,
		updatedAt: new Date(asOf),
		nodes: [
			{
				id: input.nodeId,
				type: "mcp-review-ado-stories",
				data: { config: input.nodeConfig },
			},
		],
	});
}

function useBaseline(cache: unknown, comparison: unknown = cache) {
	const candidate = (value: unknown) => ({
		id: "previous-1",
		completedAt: new Date(asOf),
		cache: value,
	});
	mocks.history.mockResolvedValue({
		analysis: { candidates: [candidate(cache)], hasMore: false },
		comparison: {
			candidates: comparison ? [candidate(comparison)] : [],
			hasMore: false,
		},
	});
	mocks.generate.mockClear();
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.evaluator.mockResolvedValue({ agent: null, skills: [] });
	authorize(params());
	mocks.execution.mockResolvedValue({
		userId: "user-1",
		organizationId: "org-1",
		workflowId: "workflow-1",
		version: 1,
		status: "RUNNING",
		triggerType: "SCHEDULE",
		triggerInput: {},
	});
	mocks.connection.mockResolvedValue({
		status: "ready",
		target,
		pat: "example-pat",
	});
	mocks.history.mockResolvedValue({
		analysis: { candidates: [], hasMore: false },
		comparison: { candidates: [], hasMore: false },
	});
	mocks.sprint.mockResolvedValue(graph());
	mocks.model.mockResolvedValue({
		model: {},
		metadata: {
			provider: "OPENAI_DIRECT",
			modelString: "example-model",
			canonicalName: "example-model",
			configId: "provider-1",
			maxOutputTokens: 16_384,
			contextWindow: 128_000,
		},
	});
	mocks.generate.mockResolvedValue({
		finishReason: "stop",
		text: JSON.stringify({
			reviews: [
				{ id: 1, verdict: "ready", summary: "Clear", issues: [] },
			],
		}),
	});
});

describe("sprint story review", () => {
	it("quotes actual AA and Related content and roles, with separate current comment timestamps", async () => {
		const result = await executeAdoStoryReviewStep(params());
		expect(result.success).toBe(true);
		expect(mocks.assigned).not.toHaveBeenCalled();
		expect(mocks.sprint).toHaveBeenCalledWith(
			target,
			"example-pat",
			expect.objectContaining({
				targetStoryTypes: ["User Story"],
				selection: adoStoryReviewConfigSchema.parse(params().nodeConfig)
					.sprintContext,
			}),
		);
		const prompt = JSON.parse(mocks.generate.mock.calls[0]?.[0].prompt);
		expect(prompt.quotedStories[0]).toMatchObject({
			requirements: { "Custom.BusinessRules": "Requirement for 1" },
			contextItems: [
				{
					id: 2,
					workItemType: "AA Task",
					relationRoles: ["child"],
					comments: [{ fullText: "PO answer for 2" }],
				},
				{
					id: 3,
					relationRoles: ["related"],
					comments: [{ fullText: "PO answer for 3" }],
				},
			],
		});
		expect(result.output?.capture).toMatchObject({
			commentsAtomicAsOf: false,
			comments: [
				{ id: 1, consistency: "two_matching_reads" },
				{ id: 2 },
				{ id: 3 },
			],
		});
		expect(result.output?.selection).toMatchObject({
			sprintContext: { assignedItemTypes: ["Bug", "Task"] },
		});
		expect(JSON.stringify(result.output)).not.toContain("PO answer");
		expect(JSON.stringify(result.output)).not.toContain("example-pat");
	});

	it.each([
		"item_limit",
		"request_limit",
		"input_limit",
		"story_limit",
		"edge_limit",
		"invalid_response",
		"concurrent_changes",
		"unavailable",
	] as const)(
		"fails before inference on incomplete %s graph",
		async (incompleteReason) => {
			mocks.sprint.mockResolvedValue({
				...graph(),
				complete: false,
				stories: [],
				unreadItemIds: [1],
				incompleteReason,
			});
			const result = await executeAdoStoryReviewStep(params());
			expect(result.success).toBe(false);
			expect(result.error).toContain(
				`Capture reason: ${incompleteReason}.`,
			);
			expect(result.output).toBeUndefined();
			expect(mocks.model).not.toHaveBeenCalled();
			expect(mocks.generate).not.toHaveBeenCalled();
		},
	);

	it("rejects inconsistent context comments before inference", async () => {
		const capture = graph();
		capture.stories[0]!.contextItems[0]!.comments.complete = false;
		mocks.sprint.mockResolvedValue(capture);
		expect((await executeAdoStoryReviewStep(params())).success).toBe(false);
		expect(mocks.generate).not.toHaveBeenCalled();
	});

	it("offers exact identity selection when Custom.Engineer cannot use current account", async () => {
		mocks.sprint.mockRejectedValue(
			new AzureDevOpsProjectReadError("unsupported_current_predicate"),
		);
		const result = await executeAdoStoryReviewStep(params());
		expect(result.error).toContain(
			"Select an exact ADO member unique name",
		);
		expect(mocks.generate).not.toHaveBeenCalled();
	});

	it.each([
		"project_mismatch",
		"authentication",
		"permission",
		"invalid_response",
	] as const)(
		"stops before inference on connector error %s",
		async (code) => {
			mocks.sprint.mockRejectedValue(
				new AzureDevOpsProjectReadError(code),
			);
			const result = await executeAdoStoryReviewStep(params());
			expect(result.success).toBe(false);
			expect(mocks.generate).not.toHaveBeenCalled();
		},
	);

	it("rejects a claimed complete graph with unresolved selected story IDs", async () => {
		const capture = graph();
		capture.stories = [];
		mocks.sprint.mockResolvedValue(capture);
		expect((await executeAdoStoryReviewStep(params())).success).toBe(false);
		expect(mocks.generate).not.toHaveBeenCalled();
	});

	it.each([
		{
			name: "duplicate assigned item",
			corrupt(capture: AzureDevOpsSprintCapture) {
				capture.assignedItems.push(capture.assignedItems[0]!);
			},
		},
		{
			name: "foreign edge source",
			corrupt(capture: AzureDevOpsSprintCapture) {
				capture.stories[0]!.edges[0]!.sourceId = 99;
			},
		},
		{
			name: "unknown discovery source",
			corrupt(capture: AzureDevOpsSprintCapture) {
				capture.stories[0]!.discoverySources[0]!.assignedItemId = 99;
			},
		},
	])(
		"rejects $name in the normalized graph before model selection",
		async ({ corrupt }) => {
			const capture = graph();
			corrupt(capture);
			mocks.sprint.mockResolvedValue(capture);
			expect((await executeAdoStoryReviewStep(params())).success).toBe(
				false,
			);
			expect(mocks.model).not.toHaveBeenCalled();
			expect(mocks.generate).not.toHaveBeenCalled();
		},
	);

	it("reuses unchanged graph judgment and keeps manual reuse independent of the scheduled baseline", async () => {
		const first = await executeAdoStoryReviewStep(params());
		expect(first.success).toBe(true);
		useBaseline(first.output?.cache, null);
		const result = await executeAdoStoryReviewStep(params());
		expect(result.success).toBe(true);
		expect(mocks.history).toHaveBeenLastCalledWith(
			expect.objectContaining({ cacheVersion: 2 }),
		);
		expect(mocks.generate).not.toHaveBeenCalled();
		expect(result.output?.counts).toMatchObject({ reviewed: 0, reused: 1 });
		expect(result.output?.comparison).toMatchObject({ status: "missing" });
		expect(result.output?.analysisReuse).toMatchObject({
			status: "available",
		});
	});

	it("names who a story was picked for and says a first capture has nothing to compare with", async () => {
		const first = await executeAdoStoryReviewStep(params());
		const html = first.output?.html ?? "";
		expect(html).toContain("assigned: member@example.com");
		expect(html).not.toContain("assigned: unassigned");
		expect(html).toContain("No earlier capture to compare with yet.");
		expect(html).not.toContain("No changes since the last capture.");

		useBaseline(first.output?.cache);
		const second = await executeAdoStoryReviewStep(params());
		expect(second.output?.html).toContain(
			"No changes since the last capture.",
		);
	});

	it("updates workload and discovery observations without invalidating unchanged requirements and comments", async () => {
		const first = await executeAdoStoryReviewStep(params());
		useBaseline(first.output?.cache);
		const capture = graph();
		capture.assignedItems[0]!.id = 11;
		capture.assignedItems[0]!.sourceUrl = item(11).sourceUrl;
		capture.assignedItems[0]!.state = "Closed";
		capture.assignedItems[0]!.iterationPath = "Example\\Sprint 2";
		capture.assignedItems[0]!.engineer = "other@example.com";
		capture.stories[0]!.story.state = "Resolved";
		capture.stories[0]!.story.assignedTo = {
			uniqueName: "other@example.com",
			displayName: "Other Member",
		};
		capture.stories[0]!.story.rev = 2;
		capture.stories[0]!.story.changedDate = "2026-01-02T12:01:00.000Z";
		capture.stories[0]!.discoverySources = [
			{ assignedItemId: 11, kind: "parent" },
		];
		capture.stories[0]!.contextItems[0]!.state = "Closed";
		mocks.sprint.mockResolvedValue(capture);
		const result = await executeAdoStoryReviewStep(params());
		expect(result.success).toBe(true);
		expect(mocks.generate).not.toHaveBeenCalled();
		expect(result.output?.workloadChanged).toBe(true);
		expect(result.output?.changedIds).toEqual([1]);
		expect(result.output?.html).toContain("Example\\Sprint 2");
		const previousCache = reviewCacheSchema.parse(first.output?.cache);
		const currentCache = reviewCacheSchema.parse(result.output?.cache);
		expect(currentCache.stories[0]?.sourceFingerprint).toBe(
			previousCache.stories[0]?.sourceFingerprint,
		);
	});

	it("re-evaluates when a linked item's work item type changes its quoted role", async () => {
		const first = await executeAdoStoryReviewStep(params());
		expect(first.success).toBe(true);
		useBaseline(first.output?.cache);
		const capture = graph();
		capture.stories[0]!.contextItems[0]!.workItemType = "QA Task";
		mocks.sprint.mockResolvedValue(capture);
		const result = await executeAdoStoryReviewStep(params());
		expect(result.success).toBe(true);
		expect(mocks.generate).toHaveBeenCalledOnce();
		const previousCache = reviewCacheSchema.parse(first.output?.cache);
		const currentCache = reviewCacheSchema.parse(result.output?.cache);
		expect(currentCache.stories[0]?.sourceFingerprint).not.toBe(
			previousCache.stories[0]?.sourceFingerprint,
		);
		expect(currentCache.stories[0]?.sourceDetails).toMatchObject({
			contextItems: [
				{ id: 2, workItemType: "QA Task" },
				{ id: 3, workItemType: "Task" },
			],
		});
		const prompt = JSON.parse(mocks.generate.mock.calls[0]?.[0].prompt);
		expect(prompt.quotedStories[0].contextItems[0]).toMatchObject({
			id: 2,
			workItemType: "QA Task",
		});
		expect(result.output?.summary).toContain(
			"context #2 type: AA Task → QA Task",
		);
	});

	it.each([
		"AA edit",
		"AA deletion",
		"BusinessRules",
		"relation removal",
		"relation addition",
		"relation kind",
		"context requirement",
	])("invalidates judgment on %s", async (change) => {
		const first = await executeAdoStoryReviewStep(params());
		useBaseline(first.output?.cache);
		const capture = graph();
		const entry = capture.stories[0]!;
		if (change === "AA edit") {
			entry.contextItems[0]!.comments.comments[0]!.fullText =
				"Changed PO answer";
		}
		if (change === "AA deletion") {
			entry.contextItems[0]!.comments.comments = [];
		}
		if (change === "BusinessRules") {
			entry.story.requirements["Custom.BusinessRules"] =
				"Changed specification";
		}
		if (change === "relation removal") {
			entry.edges.pop();
			entry.contextItems.pop();
		}
		if (change === "relation addition") {
			entry.contextItems.push(item(4, "Task"));
			entry.edges.push({ sourceId: 1, targetId: 4, kind: "related" });
		}
		if (change === "relation kind") {
			entry.edges[0]!.kind = "related";
		}
		if (change === "context requirement") {
			entry.contextItems[0]!.requirements["Custom.BusinessRules"] =
				"Changed context specification";
		}
		mocks.sprint.mockResolvedValue(capture);
		const result = await executeAdoStoryReviewStep(params());
		expect(result.success).toBe(true);
		expect(mocks.generate).toHaveBeenCalledOnce();
		expect(result.output?.counts).toMatchObject({ reviewed: 1, reused: 0 });
		expect(result.output?.changedIds).toEqual([1]);
		if (change === "AA edit") {
			expect(result.output?.summary).toContain(
				"context #2 comment 1 edited",
			);
		}
		if (change === "AA deletion") {
			expect(result.output?.summary).toContain(
				"context #2 comment 1 deleted",
			);
		}
	});

	it("escapes provider text and omits executable source links", async () => {
		const capture = graph();
		capture.stories[0]!.story.title = '<script>alert("provider")</script>';
		capture.stories[0]!.contextItems[0]!.title = '<img onerror="provider">';
		capture.stories[0]!.contextItems[0]!.sourceUrl = "javascript:alert(1)";
		mocks.sprint.mockResolvedValue(capture);
		const result = await executeAdoStoryReviewStep(params());
		expect(result.success).toBe(true);
		expect(result.output?.html).not.toContain("<script>");
		expect(result.output?.html).not.toContain("<img");
		expect(result.output?.html).not.toContain('href="javascript:');
		expect(result.output?.html).toContain("&lt;script&gt;");
	});

	it("does not interpret a v1 empty cache as verified empty graph history", async () => {
		const result = await executeAdoStoryReviewStep(params());
		const parsed = reviewCacheSchema.parse(result.output?.cache);
		const direct = directReviewCacheSchema.parse({
			version: 1,
			userId: parsed.userId,
			organizationId: parsed.organizationId,
			projectId: parsed.projectId,
			workflowId: parsed.workflowId,
			nodeId: parsed.nodeId,
			selectionFingerprint: parsed.selectionFingerprint,
			evaluatorFingerprint: parsed.evaluatorFingerprint,
			requirementsAsOf: asOf,
			stories: [],
		});
		const page = {
			candidates: [
				{
					id: "old-direct",
					completedAt: new Date(asOf),
					cache: JSON.parse(JSON.stringify(direct)),
				},
			],
			hasMore: false,
		};
		const selected = selectReviewBaseline(
			page,
			parsed,
			asOf,
			asOf,
			undefined,
			2,
		);
		expect(selected.cache).toBeUndefined();
		expect(selected.status).toBe("incomplete");
	});

	it("preserves direct v1 request, cache, evaluator and selection fingerprint contracts", async () => {
		const input = params();
		delete input.nodeConfig.sprintContext;
		authorize(input);
		mocks.assigned.mockResolvedValue({
			ids: [1],
			requirementsAsOf: asOf,
			complete: true,
		});
		mocks.snapshots.mockResolvedValue({
			snapshots: [item(1)],
			unreadIds: [],
			complete: true,
		});
		const result = await executeAdoStoryReviewStep(input);
		expect(result.success).toBe(true);
		expect(mocks.sprint).not.toHaveBeenCalled();
		const config = adoStoryReviewConfigSchema.parse(input.nodeConfig);
		expect(config).not.toHaveProperty("sprintContext");
		expect(mocks.assigned).toHaveBeenCalledWith(target, "example-pat", {
			assignee: { mode: "current" },
			workItemTypes: ["User Story"],
		});
		expect(mocks.snapshots).toHaveBeenCalledWith(target, "example-pat", {
			ids: [1],
			requirementsAsOf: asOf,
			requirementFields: config.requirementFields,
		});
		const cache = directReviewCacheSchema.parse(result.output?.cache);
		expect(cache.selectionFingerprint).toBe(
			sha256(
				'{"assignee":{"mode":"current"},"requirementFields":["Custom.BusinessRules","System.Description"],"target":{"organization":"example-org","projectId":"ado-project-1","projectName":"Example"},"workItemTypes":["User Story"]}',
			),
		);
		expect(cache.evaluatorFingerprint).toBe(
			sha256(
				'{"contractVersion":1,"evaluator":{"agent":null,"skills":[]},"model":{"canonicalName":"example-model","configId":"provider-1","modelString":"example-model","provider":"OPENAI_DIRECT"},"rubric":"Check completeness."}',
			),
		);
		const commentHash = sha256(
			'{"format":"markdown","fullText":"PO answer for 1","id":1,"isDeleted":false,"modifiedDate":"2026-01-02T12:00:00.000Z","version":1}',
		);
		const businessRulesHash = sha256('"Requirement for 1"');
		const descriptionHash = sha256('"TBD"');
		expect(cache.stories[0]).toEqual({
			id: 1,
			sourceFingerprint: sha256(
				`{"comments":[{"fingerprint":"${commentHash}","id":1,"isDeleted":false,"version":1}],"requirements":{"Custom.BusinessRules":"${businessRulesHash}","System.Description":"${descriptionHash}"}}`,
			),
			sourceDetails: {
				requirements: {
					"Custom.BusinessRules": businessRulesHash,
					"System.Description": descriptionHash,
				},
				comments: [
					{
						id: 1,
						version: 1,
						isDeleted: false,
						fingerprint: commentHash,
					},
				],
			},
			observation: {
				title: "Item 1",
				state: "Active",
				assignedTo: null,
				workItemType: "User Story",
			},
			review: { id: 1, verdict: "ready", summary: "Clear", issues: [] },
		});
		expect(mocks.history.mock.calls[0]?.[0]).not.toHaveProperty(
			"cacheVersion",
		);
	});
});
