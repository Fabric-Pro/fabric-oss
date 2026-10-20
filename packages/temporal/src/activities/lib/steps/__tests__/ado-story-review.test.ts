import type { AzureDevOpsStorySnapshot } from "@repo/connectors";
import {
	PlanSourceRotatedError,
	SubscriptionPlanExhaustedError,
} from "@repo/agent-types/chatgpt-plan-fetch";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	workflow: vi.fn(),
	execution: vi.fn(),
	history: vi.fn(),
	connection: vi.fn(),
	assigned: vi.fn(),
	snapshots: vi.fn(),
	model: vi.fn(),
	generate: vi.fn(),
	agent: vi.fn(),
	skill: vi.fn(),
	file: vi.fn(),
	frame: vi.fn(),
	members: vi.fn(),
	agentPermission: vi.fn(),
	skillPermission: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	getWorkflowById: mocks.workflow,
	getWorkflowExecutionById: mocks.execution,
	listAdoReviewBaselines: mocks.history,
	getInstanceWithTemplate: mocks.agent,
	getFrameById: mocks.frame,
	canReadOrganizationAgentTemplates: mocks.agentPermission,
	canReadOrganizationSkills: mocks.skillPermission,
}));
vi.mock("@repo/mcp/lib/project-pm-read", () => ({
	resolveProjectPmRead: mocks.connection,
}));
vi.mock("@repo/connectors", () => ({
	listAzureDevOpsAssignedStories: mocks.assigned,
	getAzureDevOpsStorySnapshots: mocks.snapshots,
	listAzureDevOpsProjectMembers: mocks.members,
}));
vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: mocks.model,
	generateText: mocks.generate,
	getCurrentDateContext: () => "Current date: fixture",
}));
vi.mock("@repo/ai/skills", () => ({
	loadSkillBundle: mocks.skill,
	readSkillFile: mocks.file,
}));

import { buildAgentInstructions } from "../../../../lib/agent-instructions";
import { buildSystemPrompt } from "../../../agent-execution-core/context-builder";
import { adoStoryReviewConfigSchema } from "../../../../lib/ado-story-review-config";
import type { StepParams } from "../../../types";
import { executeAdoStoryReviewStep } from "../mcp-review-ado-stories";
import {
	reviewCacheSchema,
	selectReviewBaseline,
} from "../../ado-story-review/data";

const asOf = "2026-01-02T12:00:00.000Z";
const target = {
	organization: "example-org",
	projectId: "ado-project-1",
	projectName: "Example",
};

function story(id = 1): AzureDevOpsStorySnapshot {
	return {
		id,
		rev: 1,
		workItemType: "User Story",
		title: "Story",
		state: "Active",
		assignedTo: {
			uniqueName: "member@example.com",
			displayName: "Example Member",
		},
		changedDate: asOf,
		requirementsAsOf: asOf,
		requirements: {
			"System.Title": "Story",
			"System.Description": "Requirement",
		},
		sourceUrl: `https://dev.azure.com/example-org/example/_workitems/edit/${id}`,
		complete: true,
		comments: {
			complete: true,
			incompleteReason: null,
			consistency: "two_matching_reads",
			atomicAsOf: false,
			captureStartedAt: asOf,
			capturedAt: asOf,
			comments: [
				{
					id: 10,
					version: 1,
					modifiedDate: asOf,
					isDeleted: false,
					fullText: "Context",
					format: "markdown",
				},
			],
		},
	};
}

function params(config: Record<string, unknown> = {}): StepParams {
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
			rubric: "Check clear requirements and acceptance criteria.",
			...config,
		},
	};
}

function authorize(input = params()) {
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

function capture(stories = [story()]) {
	mocks.assigned.mockResolvedValue({
		ids: stories.map((item) => item.id),
		requirementsAsOf: asOf,
		complete: true,
	});
	mocks.snapshots.mockImplementation(
		async (_target, _pat, input: { ids: number[] }) => ({
			snapshots: stories.filter((item) => input.ids.includes(item.id)),
			unreadIds: [],
			complete: true,
			requirementsAsOf: asOf,
		}),
	);
}

function generated(ids = [1]) {
	return {
		finishReason: "stop",
		text: JSON.stringify({
			reviews: ids.map((id) => ({
				id,
				verdict: "ready",
				summary: "Clear requirements",
				issues: [],
			})),
		}),
	};
}

function history(output: Record<string, unknown>) {
	const candidate = {
		id: "previous-1",
		completedAt: new Date(asOf),
		cache: output.cache,
	};
	mocks.history.mockImplementation(
		async (options: { evaluatorFingerprint: string }) => ({
			analysis: {
				candidates:
					reviewCacheSchema.safeParse(output.cache).data
						?.evaluatorFingerprint === options.evaluatorFingerprint
						? [candidate]
						: [],
				hasMore: false,
			},
			comparison: { candidates: [candidate], hasMore: false },
		}),
	);
}

function emptyHistory() {
	return {
		analysis: { candidates: [], hasMore: false },
		comparison: { candidates: [], hasMore: false },
	};
}

async function baseline(input = params()) {
	const first = await executeAdoStoryReviewStep(input);
	expect(first.success).toBe(true);
	if (!first.output) {
		throw new Error("Missing initial output");
	}
	history(first.output);
	mocks.generate.mockClear();
	return first.output;
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.agentPermission.mockResolvedValue(true);
	mocks.skillPermission.mockResolvedValue(true);
	authorize();
	mocks.execution.mockResolvedValue({
		id: "execution-1",
		workflowId: "workflow-1",
		userId: "user-1",
		organizationId: "org-1",
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
	capture();
	mocks.history.mockResolvedValue(emptyHistory());
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
	mocks.generate.mockResolvedValue(generated());
	mocks.skill.mockResolvedValue({
		slug: "requirements",
		version: 1,
		skillMd: "Check completeness",
		files: [],
	});
	mocks.members.mockResolvedValue({
		complete: true,
		members: [
			{
				id: "member-1",
				uniqueName: "member@example.com",
				displayName: "Example Member",
			},
		],
	});
});

describe("ADO story review activity core", () => {
	it("reviews fresh input with canonical usage context, no PAT or raw requirements in output", async () => {
		const result = await executeAdoStoryReviewStep(
			params({ model: "selected-model" }),
		);
		// A server node's configuration must agree with the executing step.
		expect(result.success).toBe(false);
		const input = params({ model: "selected-model" });
		authorize(input);
		const reviewed = await executeAdoStoryReviewStep(input);
		expect(reviewed.success).toBe(true);
		expect(reviewed.output?.counts).toEqual({
			total: 1,
			reviewed: 1,
			reused: 0,
			removed: 0,
		});
		expect(mocks.model).toHaveBeenCalledWith(
			{ taskType: "SIMPLE", modelOverride: "selected-model" },
			{
				userId: "user-1",
				organizationId: "org-1",
				projectId: "project-1",
				jobType: "workflow-builder",
				workflowExecutionId: "execution-1",
				featureKey: "workflow",
				agentId: undefined,
				frameId: undefined,
			},
		);
		expect(mocks.generate).toHaveBeenCalledWith(
			expect.objectContaining({ maxRetries: 0, maxOutputTokens: 2_048 }),
		);
		expect(JSON.stringify(reviewed.output)).not.toContain("example-pat");
		expect(JSON.stringify(reviewed.output)).not.toContain(
			'"System.Description":"Requirement"',
		);
		expect(JSON.stringify(reviewed.output)).not.toContain('"fullText"');
	});

	it("reuses a complete unchanged result without inference", async () => {
		await baseline();
		const result = await executeAdoStoryReviewStep(params());
		expect(result.output?.counts).toEqual({
			total: 1,
			reviewed: 0,
			reused: 1,
			removed: 0,
		});
		expect(mocks.generate).not.toHaveBeenCalled();
	});

	it("keeps the daily interval across a changed manual capture while reusing its judgment", async () => {
		const daily = await baseline();
		const changed = story();
		changed.requirements["System.Description"] =
			"Changed after the daily capture";
		capture([changed]);
		mocks.execution.mockResolvedValue({
			id: "execution-1",
			workflowId: "workflow-1",
			userId: "user-1",
			organizationId: "org-1",
			version: 1,
			status: "RUNNING",
			triggerType: "MANUAL",
			triggerInput: {},
		});
		const manual = await executeAdoStoryReviewStep(params());
		expect(manual.success).toBe(true);
		expect(mocks.generate).toHaveBeenCalledTimes(1);
		mocks.history.mockResolvedValue({
			analysis: {
				candidates: [
					{
						id: "manual",
						completedAt: new Date(asOf),
						cache: manual.output?.cache,
					},
				],
				hasMore: false,
			},
			comparison: {
				candidates: [
					{
						id: "daily",
						completedAt: new Date(asOf),
						cache: daily.cache,
					},
				],
				hasMore: false,
			},
		});
		mocks.execution.mockResolvedValue({
			id: "execution-1",
			workflowId: "workflow-1",
			userId: "user-1",
			organizationId: "org-1",
			version: 1,
			status: "RUNNING",
			triggerType: "SCHEDULE",
			triggerInput: {},
		});
		mocks.generate.mockClear();
		const nextDaily = await executeAdoStoryReviewStep(params());
		expect(nextDaily.success).toBe(true);
		expect(mocks.generate).not.toHaveBeenCalled();
		expect(nextDaily.output?.counts).toMatchObject({
			reviewed: 0,
			reused: 1,
		});
		expect(nextDaily.output?.changes).toEqual([
			expect.objectContaining({
				requirementFields: ["System.Description"],
			}),
		]);
		expect(nextDaily.output?.comparison).toMatchObject({
			executionId: "daily",
			requirementsAsOf: asOf,
			status: "available",
		});
		expect(nextDaily.output?.analysisReuse).toMatchObject({
			executionId: "manual",
			status: "available",
		});
		expect(nextDaily.output?.summary).toContain(
			`Changes since the scheduled capture at ${asOf}`,
		);
	});

	it("reuses a complete forced manual review on the following normal run", async () => {
		await baseline();
		mocks.execution.mockResolvedValue({
			id: "execution-1",
			workflowId: "workflow-1",
			userId: "user-1",
			organizationId: "org-1",
			version: 1,
			status: "RUNNING",
			triggerType: "MANUAL",
			triggerInput: { triggerData: { forceReview: true } },
		});
		const forced = await executeAdoStoryReviewStep(params());
		expect(forced.output?.forced).toBe(true);
		expect(mocks.generate).toHaveBeenCalledTimes(1);
		if (!forced.output) {
			throw new Error("Missing forced output");
		}
		history(forced.output);
		mocks.execution.mockResolvedValue({
			id: "execution-1",
			workflowId: "workflow-1",
			userId: "user-1",
			organizationId: "org-1",
			version: 1,
			status: "RUNNING",
			triggerType: "MANUAL",
			triggerInput: {},
		});
		mocks.generate.mockClear();
		const normal = await executeAdoStoryReviewStep(params());
		expect(normal.output?.forced).toBe(false);
		expect(normal.output?.counts).toMatchObject({ reviewed: 0, reused: 1 });
		expect(mocks.generate).not.toHaveBeenCalled();
	});

	it("labels the first scheduled capture as an initial baseline without inventing assignment additions", async () => {
		const result = await executeAdoStoryReviewStep(params());
		expect(result.success).toBe(true);
		expect(result.output?.addedIds).toEqual([]);
		expect(result.output?.dailyChanges).toEqual([]);
		expect(result.output?.comparison).toMatchObject({ status: "missing" });
		expect(result.output?.summary).toContain(
			"Initial baseline: no prior scheduled capture",
		);
	});

	it("reports malformed candidate exhaustion as incomplete history rather than new assignments", async () => {
		mocks.history.mockResolvedValue({
			analysis: {
				candidates: Array.from({ length: 5 }, (_, index) => ({
					id: `invalid-${index}`,
					completedAt: new Date(asOf),
					cache: null,
				})),
				hasMore: true,
			},
			comparison: {
				candidates: Array.from({ length: 5 }, (_, index) => ({
					id: `invalid-${index}`,
					completedAt: new Date(asOf),
					cache: { malformed: true },
				})),
				hasMore: true,
			},
		});
		const result = await executeAdoStoryReviewStep(params());
		expect(result.success).toBe(true);
		expect(result.output?.comparison).toMatchObject({
			status: "incomplete",
			rejectedCandidates: 5,
			hasMore: true,
		});
		expect(result.output?.analysisReuse).toMatchObject({
			status: "incomplete",
			rejectedCandidates: 5,
			hasMore: true,
		});
		expect(result.output?.summary).toContain(
			"Scheduled comparison is incomplete",
		);
		expect(result.output?.summary).toContain(
			"Prior AI judgment reuse is incomplete",
		);
		expect(result.output?.summary).not.toContain("Initial baseline");
		expect(result.output?.addedIds).toEqual([]);
	});

	it("keeps the UTF-16 cache limit and reuses a valid Unicode cache above 600,000 UTF-8 bytes", async () => {
		const first = await baseline();
		const original = reviewCacheSchema.parse(first.cache);
		const source = original.stories[0];
		const unicode = reviewCacheSchema.parse({
			...original,
			stories: Array.from({ length: 50 }, (_, index) => ({
				...source,
				id: index + 1,
				observation: {
					...source.observation,
					title: "界".repeat(3_000),
				},
				review: {
					...source.review,
					id: index + 1,
					summary: "界".repeat(1_000),
					issues: Array.from({ length: 8 }, () => "界".repeat(250)),
				},
			})),
		});
		expect(JSON.stringify(unicode).length).toBeLessThan(600_000);
		expect(Buffer.byteLength(JSON.stringify(unicode))).toBeGreaterThan(
			600_000,
		);
		history({ cache: unicode });
		const result = await executeAdoStoryReviewStep(params());
		expect(result.success).toBe(true);
		expect(result.output?.counts).toMatchObject({ reviewed: 0, reused: 1 });
		expect(mocks.generate).not.toHaveBeenCalled();
	});

	it("rejects a projected future completion and mismatched evaluator before reusing judgments", async () => {
		const first = await baseline();
		const parsed = reviewCacheSchema.parse(first.cache);
		mocks.history.mockResolvedValue({
			analysis: {
				candidates: [
					{
						id: "future-completion",
						completedAt: new Date("9999-01-01"),
						cache: parsed,
					},
					{
						id: "other-evaluator",
						completedAt: new Date(asOf),
						cache: {
							...parsed,
							evaluatorFingerprint: "e".repeat(64),
						},
					},
				],
				hasMore: false,
			},
			comparison: { candidates: [], hasMore: false },
		});
		const result = await executeAdoStoryReviewStep(params());
		expect(result.success).toBe(true);
		expect(mocks.generate).toHaveBeenCalledTimes(1);
		expect(result.output?.analysisReuse).toMatchObject({
			status: "incomplete",
			rejectedCandidates: 2,
		});
	});

	it("uses connected-account @Me rather than inventing a Fabric email filter", async () => {
		await executeAdoStoryReviewStep(params());
		expect(mocks.assigned).toHaveBeenCalledWith(
			target,
			"example-pat",
			expect.objectContaining({ assignee: { mode: "current" } }),
		);
		expect(mocks.members).not.toHaveBeenCalled();
	});

	it("canonicalizes requirement key and comment ordering for reuse", async () => {
		const original = story();
		original.comments.comments.push({
			...original.comments.comments[0],
			id: 11,
		});
		capture([original]);
		await baseline();
		const reordered = {
			...original,
			requirements: {
				"System.Description": "Requirement",
				"System.Title": "Story",
			},
			comments: {
				...original.comments,
				comments: [...original.comments.comments].reverse(),
			},
		};
		capture([reordered]);
		expect((await executeAdoStoryReviewStep(params())).success).toBe(true);
		expect(mocks.generate).not.toHaveBeenCalled();
	});

	it.each([
		"requirement",
		"comment edit",
		"comment delete",
		"comment removal",
	])("invalidates changed %s", async (change) => {
		await baseline();
		const current = story();
		if (change === "requirement") {
			current.requirements["System.Description"] = "New requirement";
		}
		if (change === "comment edit") {
			current.comments.comments[0].fullText = "Changed context";
		}
		if (change === "comment delete") {
			current.comments.comments[0].isDeleted = true;
		}
		if (change === "comment removal") {
			current.comments.comments = [];
		}
		capture([current]);
		const result = await executeAdoStoryReviewStep(params());
		expect(result.success).toBe(true);
		if (change === "requirement") {
			expect(result.output?.changes).toEqual([
				expect.objectContaining({
					requirementFields: ["System.Description"],
				}),
			]);
			expect(result.output?.html).toContain(
				"requirements changed: System.Description",
			);
		} else {
			const action = change === "comment edit" ? "edited" : "deleted";
			expect(result.output?.changes).toEqual([
				expect.objectContaining({
					comments: expect.objectContaining({ [action]: [10] }),
				}),
			]);
			expect(result.output?.html).toContain(`comments ${action}: 10`);
		}
		expect(mocks.generate).toHaveBeenCalledTimes(1);
	});

	it("reuses judgments for state-only changes and describes the transition", async () => {
		await baseline();
		const current = story();
		current.state = "Closed";
		current.rev = 2;
		capture([current]);
		const result = await executeAdoStoryReviewStep(params());
		expect(result.success).toBe(true);
		expect(mocks.generate).not.toHaveBeenCalled();
		expect(result.output?.changes).toEqual([
			expect.objectContaining({
				id: 1,
				before: expect.objectContaining({ state: "Active" }),
				after: expect.objectContaining({ state: "Closed" }),
			}),
		]);
	});

	it("reports assignment-only metadata changes without inference", async () => {
		await baseline();
		const current = story();
		current.assignedTo = null;
		capture([current]);
		const result = await executeAdoStoryReviewStep(params());
		expect(result.success).toBe(true);
		expect(mocks.generate).not.toHaveBeenCalled();
		expect(result.output?.changes).toEqual([
			expect.objectContaining({ metadataFields: ["assignedTo"] }),
		]);
		expect(result.output?.html).toContain(
			"assignedTo: member@example.com → unassigned",
		);
	});

	it("reports added and removed story IDs deterministically", async () => {
		capture([story(1), story(2)]);
		mocks.generate.mockResolvedValue(generated([1, 2]));
		await baseline();
		capture([story(3), story(1)]);
		mocks.generate.mockResolvedValue(generated([3]));
		const result = await executeAdoStoryReviewStep(params());
		expect(result.output?.addedIds).toEqual([3]);
		expect(result.output?.removedIds).toEqual([2]);
		expect(result.output?.changedIds).toEqual([]);
		expect(result.output?.html).toContain("#3: added to assignment");
		expect(result.output?.html).toContain("#2: removed from assignment");
	});

	it("reports an added comment ID without retaining its text", async () => {
		await baseline();
		const current = story();
		current.comments.comments.push({
			...current.comments.comments[0],
			id: 11,
			fullText: "Additional context",
		});
		capture([current]);
		const result = await executeAdoStoryReviewStep(params());
		expect(result.output?.changes).toEqual([
			expect.objectContaining({
				comments: { added: [11], edited: [], deleted: [] },
			}),
		]);
		expect(JSON.stringify(result.output)).not.toContain(
			"Additional context",
		);
	});

	it.each(["rubric", "model"])(
		"retains removal and state history across %s changes",
		async (change) => {
			capture([story(1), story(2)]);
			mocks.generate.mockResolvedValue(generated([1, 2]));
			await baseline();
			const current = story(1);
			current.state = "Closed";
			capture([current]);
			const input = params(
				change === "rubric"
					? { rubric: "New rubric" }
					: { model: "new-model" },
			);
			authorize(input);
			if (change === "model") {
				mocks.model.mockResolvedValue({
					model: {},
					metadata: {
						provider: "OPENAI_DIRECT",
						modelString: "new-model",
					},
				});
			}
			mocks.generate.mockResolvedValue(generated([1]));
			const result = await executeAdoStoryReviewStep(input);
			expect(result.output?.counts).toEqual({
				total: 1,
				reviewed: 1,
				reused: 0,
				removed: 1,
			});
			expect(result.output?.removedIds).toEqual([2]);
			expect(result.output?.changes).toEqual([
				expect.objectContaining({
					id: 1,
					before: expect.objectContaining({ state: "Active" }),
					after: expect.objectContaining({ state: "Closed" }),
				}),
			]);
		},
	);

	it.each(["model", "provider", "rubric", "skill"])(
		"invalidates evaluator %s changes",
		async (change) => {
			const input = params({ skills: [{ slug: "requirements" }] });
			authorize(input);
			await baseline(input);
			if (change === "model" || change === "provider") {
				mocks.model.mockResolvedValue({
					model: {},
					metadata: {
						provider:
							change === "provider" ? "GROQ" : "OPENAI_DIRECT",
						modelString: "new-model",
					},
				});
			}
			if (change === "rubric") {
				input.nodeConfig.rubric = "New rubric";
				authorize(input);
			}
			if (change === "skill") {
				mocks.skill.mockResolvedValue({
					slug: "requirements",
					version: 2,
					skillMd: "New instructions",
					files: [],
				});
			}
			expect((await executeAdoStoryReviewStep(input)).success).toBe(true);
			expect(mocks.generate).toHaveBeenCalledTimes(1);
		},
	);

	it.each(["SCHEDULE", "MANUAL"])(
		"trusts force only on a saved %s trigger",
		async (triggerType) => {
			await baseline();
			mocks.execution.mockResolvedValue({
				id: "execution-1",
				workflowId: "workflow-1",
				userId: "user-1",
				organizationId: "org-1",
				version: 1,
				status: "RUNNING",
				triggerType,
				triggerInput: { triggerData: { forceReview: true } },
			});
			const input = params();
			input.inputs.forceReview = true;
			input.inputs.triggerData = { forceReview: true };
			expect((await executeAdoStoryReviewStep(input)).success).toBe(true);
			expect(mocks.generate).toHaveBeenCalledTimes(
				triggerType === "MANUAL" ? 1 : 0,
			);
		},
	);

	it("ignores forged cache and force in merged inputs", async () => {
		const output = await baseline();
		mocks.history.mockResolvedValue(emptyHistory());
		const input = params();
		input.inputs = { previousReview: output, forceReview: true };
		await executeAdoStoryReviewStep(input);
		expect(mocks.generate).toHaveBeenCalledTimes(1);
	});

	it.each([
		"organizationId",
		"userId",
		"projectId",
		"workflowId",
		"nodeId",
		"selectionFingerprint",
	])("rejects a cache with wrong %s", async (key) => {
		const output = await baseline();
		const cache = reviewCacheSchema.parse(output.cache);
		history({
			...output,
			cache: {
				...cache,
				[key]:
					key === "selectionFingerprint" ? "0".repeat(64) : "other",
			},
		});
		await executeAdoStoryReviewStep(params());
		expect(mocks.generate).toHaveBeenCalledTimes(1);
	});

	it("requests only the dedicated scoped baseline projection", async () => {
		await baseline();
		mocks.history.mockResolvedValue(emptyHistory());
		await executeAdoStoryReviewStep(params());
		expect(mocks.history).toHaveBeenLastCalledWith(
			expect.objectContaining({
				binding: expect.objectContaining({
					userId: "user-1",
					organizationId: "org-1",
					projectId: "project-1",
					workflowId: "workflow-1",
					nodeId: "review-1",
					selectionFingerprint:
						expect.stringMatching(/^[a-f0-9]{64}$/),
				}),
				executionId: "execution-1",
				evaluatorFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
				requirementsAsOf: asOf,
				captureStartedAt: expect.any(String),
			}),
		);
		expect(mocks.generate).toHaveBeenCalledTimes(1);
	});

	it.each(["enumeration", "snapshot", "comments", "limit", "characters"])(
		"fails incomplete/excessive %s before inference",
		async (failure) => {
			if (failure === "enumeration") {
				mocks.assigned.mockResolvedValue({
					complete: false,
					ids: [1],
					requirementsAsOf: asOf,
				});
			}
			if (failure === "snapshot") {
				mocks.snapshots.mockResolvedValue({
					complete: false,
					snapshots: [],
					unreadIds: [1],
				});
			}
			if (failure === "comments") {
				const item = story();
				item.comments.complete = false;
				capture([item]);
			}
			if (failure === "limit") {
				capture(Array.from({ length: 21 }, (_, i) => story(i + 1)));
			}
			if (failure === "characters") {
				const item = story();
				item.requirements["System.Description"] = "x".repeat(120_001);
				capture([item]);
			}
			const result = await executeAdoStoryReviewStep(params());
			expect(result.success).toBe(false);
			expect(result.output).toBeUndefined();
			expect(mocks.generate).not.toHaveBeenCalled();
			expect(mocks.model).not.toHaveBeenCalled();
		},
	);

	it("accepts an empty assignment and reports removed stories with no AI calls", async () => {
		await baseline();
		capture([]);
		mocks.model.mockClear();
		const result = await executeAdoStoryReviewStep(params());
		expect(result.output?.counts).toEqual({
			total: 0,
			reviewed: 0,
			reused: 0,
			removed: 1,
		});
		expect(mocks.generate).not.toHaveBeenCalled();
		expect(mocks.model).not.toHaveBeenCalled();
	});

	it.each(["missing", "duplicate", "foreign", "truncated", "invalid JSON"])(
		"rejects %s model output without returning a baseline",
		async (failure) => {
			if (failure === "missing") {
				mocks.generate.mockResolvedValue(generated([]));
			}
			if (failure === "duplicate") {
				mocks.generate.mockResolvedValue(generated([1, 1]));
			}
			if (failure === "foreign") {
				mocks.generate.mockResolvedValue(generated([2]));
			}
			if (failure === "truncated") {
				mocks.generate.mockResolvedValue({
					...generated(),
					finishReason: "length",
				});
			}
			if (failure === "invalid JSON") {
				mocks.generate.mockResolvedValue({
					finishReason: "stop",
					text: "not JSON",
				});
			}
			const result = await executeAdoStoryReviewStep(params());
			expect(result.success).toBe(false);
			expect(result.output).toBeUndefined();
		},
	);

	it("escapes ADO and model markup in static HTML", async () => {
		const item = story();
		item.title = '<script>alert("title")</script>';
		capture([item]);
		mocks.generate.mockResolvedValue({
			finishReason: "stop",
			text: JSON.stringify({
				reviews: [
					{
						id: 1,
						verdict: "needs_work",
						summary: '<img src=x onerror="x">',
						issues: ["<b>Issue</b>"],
					},
				],
			}),
		});
		const result = await executeAdoStoryReviewStep(params());
		expect(result.output?.html).toContain("&lt;script&gt;");
		expect(result.output?.html).toContain("&lt;img");
		expect(result.output?.html).not.toContain("<script>");
	});

	it("redacts provider and connector exceptions", async () => {
		mocks.generate.mockRejectedValue(
			new Error("example-pat provider-body"),
		);
		const result = await executeAdoStoryReviewStep(params());
		expect(result.success).toBe(false);
		expect(JSON.stringify(result)).not.toContain("example-pat");
	});

	it("preserves the successful baseline after a later generation failure", async () => {
		await baseline();
		const edited = story();
		edited.requirements["System.Description"] = "Edited";
		capture([edited]);
		mocks.generate.mockRejectedValueOnce(new Error("Provider failure"));
		const failed = await executeAdoStoryReviewStep(params());
		expect(failed.success).toBe(false);
		expect(failed.output).toBeUndefined();
		capture();
		mocks.generate.mockClear();
		const unchanged = await executeAdoStoryReviewStep(params());
		expect(unchanged.output?.counts).toEqual({
			total: 1,
			reviewed: 0,
			reused: 1,
			removed: 0,
		});
		expect(mocks.generate).not.toHaveBeenCalled();
	});

	it("rechecks project context after review", async () => {
		mocks.connection
			.mockResolvedValueOnce({
				status: "ready",
				target,
				pat: "example-pat",
			})
			.mockResolvedValueOnce({ status: "forbidden" });
		const result = await executeAdoStoryReviewStep(params());
		expect(result.success).toBe(false);
		expect(result.output).toBeUndefined();
	});

	it("reviews only changed stories and retains other judgments", async () => {
		capture([story(1), story(2)]);
		mocks.generate.mockResolvedValue(generated([1, 2]));
		await baseline();
		const edited = story(2);
		edited.requirements["System.Description"] = "Edited requirement";
		capture([story(1), edited]);
		mocks.generate.mockResolvedValue(generated([2]));
		const result = await executeAdoStoryReviewStep(params());
		expect(result.output?.counts).toEqual({
			total: 2,
			reviewed: 1,
			reused: 1,
			removed: 0,
		});
		expect(
			reviewCacheSchema.parse(result.output?.cache).stories,
		).toHaveLength(2);
		expect(mocks.generate).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: expect.not.stringContaining('"id":1,'),
			}),
		);
	});

	it("reads snapshots in batches of five", async () => {
		capture(Array.from({ length: 6 }, (_, i) => story(i + 1)));
		mocks.generate.mockResolvedValue(generated([1, 2, 3, 4, 5, 6]));
		expect((await executeAdoStoryReviewStep(params())).success).toBe(true);
		expect(
			mocks.snapshots.mock.calls.map((call) => call[2].ids.length),
		).toEqual([5, 1]);
	});

	it("uses the selected uniqueName filter without a project-team roster permission barrier", async () => {
		const input = params({
			assignee: { mode: "selected", uniqueName: "member@example.com" },
		});
		authorize(input);
		mocks.members.mockResolvedValue({ complete: false, members: [] });
		expect((await executeAdoStoryReviewStep(input)).success).toBe(true);
		expect(mocks.members).not.toHaveBeenCalled();
		expect(mocks.assigned).toHaveBeenCalledWith(
			target,
			"example-pat",
			expect.objectContaining({
				assignee: {
					mode: "selected",
					uniqueName: "member@example.com",
				},
			}),
		);
	});

	it.each([
		"missing context",
		"wrong project",
		"wrong owner",
		"wrong run",
		"wrong node",
		"old version",
	])("refuses %s before reading ADO", async (failure) => {
		const input = params();
		if (failure === "missing context") {
			input.projectId = undefined;
		}
		if (
			failure === "wrong project" ||
			failure === "wrong owner" ||
			failure === "old version"
		) {
			mocks.workflow.mockResolvedValue({
				userId: failure === "wrong owner" ? "other" : "user-1",
				organizationId: "org-1",
				projectId: failure === "wrong project" ? "other" : "project-1",
				version: failure === "old version" ? 2 : 1,
				nodes: [],
			});
		}
		if (failure === "wrong run") {
			mocks.execution.mockResolvedValue(null);
		}
		if (failure === "wrong node") {
			input.nodeId = "other";
		}
		expect((await executeAdoStoryReviewStep(input)).success).toBe(false);
		expect(mocks.connection).not.toHaveBeenCalled();
	});

	it.each([
		new SubscriptionPlanExhaustedError("No usage left", null),
		new PlanSourceRotatedError(),
	])("preserves workflow-handled plan refusal: %s", async (refusal) => {
		mocks.generate.mockRejectedValue(refusal);
		await expect(executeAdoStoryReviewStep(params())).rejects.toBe(refusal);
	});
});

describe("review configuration and instruction boundaries", () => {
	it("does not reuse a completed review after skill-read permission is revoked", async () => {
		const input = params({
			skills: [{ slug: "requirements", textFiles: [] }],
		});
		authorize(input);
		await baseline(input);
		mocks.skill.mockClear();
		mocks.skillPermission.mockResolvedValue(false);
		expect((await executeAdoStoryReviewStep(input)).success).toBe(false);
		expect(mocks.skill).not.toHaveBeenCalled();
		expect(mocks.generate).not.toHaveBeenCalled();
	});
	it.each(["agent", "skill"])(
		"rechecks revoked %s read permission before using instructions",
		async (selection) => {
			const input = params(
				selection === "agent"
					? { agentInstructionsInstanceId: "instance-1" }
					: { skills: [{ slug: "requirements", textFiles: [] }] },
			);
			authorize(input);
			if (selection === "agent") {
				mocks.agentPermission.mockResolvedValue(false);
			} else {
				mocks.skillPermission.mockResolvedValue(false);
			}
			expect((await executeAdoStoryReviewStep(input)).success).toBe(
				false,
			);
			expect(mocks.agent).not.toHaveBeenCalled();
			expect(mocks.skill).not.toHaveBeenCalled();
			expect(mocks.generate).not.toHaveBeenCalled();
		},
	);
	it("uses accessible agent instructions/model and invalidates actual instruction changes", async () => {
		const input = params({ agentInstructionsInstanceId: "instance-1" });
		authorize(input);
		const instance = {
			id: "instance-1",
			organizationId: "org-1",
			version: 1,
			status: "ACTIVE",
			description: null,
			customInstructions: { role: "Reviewer" },
			modelOverride: "agent-model",
			template: {
				displayName: "Reviewer",
				description: "Reviews stories.",
				instructions: "Original",
				suggestedModel: null,
			},
		};
		mocks.agent.mockResolvedValue(instance);
		await baseline(input);
		expect(mocks.agent).toHaveBeenCalledWith(
			"instance-1",
			"user-1",
			"org-1",
		);
		expect(mocks.model).toHaveBeenCalledWith(
			{ taskType: "SIMPLE", modelOverride: "agent-model" },
			expect.objectContaining({ agentId: "instance-1" }),
		);
		mocks.agent.mockResolvedValue({
			...instance,
			version: 2,
			template: { ...instance.template, instructions: "Changed" },
		});
		expect((await executeAdoStoryReviewStep(input)).success).toBe(true);
		expect(mocks.generate).toHaveBeenCalledTimes(1);
	});

	it("refuses inaccessible agent instructions", async () => {
		const input = params({ agentInstructionsInstanceId: "instance-1" });
		authorize(input);
		mocks.agent.mockResolvedValue(null);
		expect((await executeAdoStoryReviewStep(input)).success).toBe(false);
		expect(mocks.generate).not.toHaveBeenCalled();
	});

	it("fingerprints actual selected skill text file content", async () => {
		const input = params({
			skills: [
				{ slug: "requirements", textFiles: ["references/rubric.md"] },
			],
		});
		authorize(input);
		mocks.skill.mockResolvedValue({
			slug: "requirements",
			version: 1,
			skillMd: "Read references/rubric.md",
			files: [
				{
					path: "references/rubric.md",
					sizeBytes: 10,
					contentType: "text/markdown",
				},
			],
		});
		mocks.file.mockResolvedValue({ encoding: "utf-8", data: "Original" });
		await baseline(input);
		expect(mocks.skill).toHaveBeenCalledWith(
			"requirements",
			expect.objectContaining({
				userId: "user-1",
				organizationId: "org-1",
			}),
			{ fresh: true },
		);
		expect(mocks.file).toHaveBeenCalledWith(
			"requirements",
			"references/rubric.md",
			expect.objectContaining({ organizationId: "org-1" }),
			{ fresh: true, expectedVersion: 1 },
		);
		mocks.file.mockResolvedValue({ encoding: "utf-8", data: "Changed" });
		expect((await executeAdoStoryReviewStep(input)).success).toBe(true);
		expect(mocks.generate).toHaveBeenCalledTimes(1);
	});

	it.each([
		null,
		{ userId: "other" },
		{ projectId: "other" },
		{ surface: "page" },
	])(
		"refuses an unavailable or wrong-scope Workspace: %s",
		async (override) => {
			const input = params({ workspaceFrameId: "workspace-1" });
			authorize(input);
			mocks.frame.mockResolvedValue(
				override && {
					id: "workspace-1",
					userId: "user-1",
					organizationId: "org-1",
					projectId: "project-1",
					surface: "workspace",
					...override,
				},
			);
			expect((await executeAdoStoryReviewStep(input)).success).toBe(
				false,
			);
			expect(mocks.model).not.toHaveBeenCalled();
		},
	);

	function controllerRun() {
		const input = params({ workspaceFrameId: "workspace-1" });
		authorize(input);
		const marker = {
			kind: "workspace-story-review",
			version: 1,
			workflowId: input.workflowId,
			workspaceFrameId: "workspace-1",
			projectId: input.projectId,
			nodeId: input.nodeId,
			workflowUpdatedAt: asOf,
			frameUpdatedAt: asOf,
			forceReview: false,
		};
		const execution = {
			id: input.executionId,
			workflowId: input.workflowId,
			userId: input.userId,
			organizationId: input.organizationId,
			version: 1,
			status: "RUNNING",
			triggerType: "MANUAL",
			triggerInput: {
				source: "workspace-story-review",
				triggerData: { forceReview: false },
				workspaceReviewBinding: marker,
			},
		};
		const frame = {
			id: "workspace-1",
			userId: input.userId,
			organizationId: input.organizationId,
			projectId: input.projectId,
			surface: "workspace",
			updatedAt: new Date(asOf),
		};
		mocks.execution.mockResolvedValue(execution);
		mocks.frame.mockResolvedValue(frame);
		return { input, marker, execution, frame };
	}

	it("accepts a strongly parsed controller marker and rechecks it at the output checkpoint", async () => {
		const { input } = controllerRun();
		const result = await executeAdoStoryReviewStep(input);
		expect(result.success).toBe(true);
		expect(result.output?.selection).toEqual({
			assignee: { mode: "current" },
			workItemTypes: ["User Story"],
		});
		expect(mocks.frame).toHaveBeenCalledTimes(2);
	});

	it.each([
		"unattached",
		"changed-stamp",
		"changed-project",
		"string-marker",
		"changed-force",
	])("rejects controller %s before inference", async (change) => {
		const { input, execution, frame } = controllerRun();
		if (change === "unattached")
			mocks.frame.mockResolvedValue({ ...frame, projectId: null });
		if (change === "changed-stamp")
			mocks.frame.mockResolvedValue({
				...frame,
				updatedAt: new Date("2026-01-03T12:00:00Z"),
			});
		if (change === "changed-project")
			mocks.frame.mockResolvedValue({
				...frame,
				projectId: "other-project",
			});
		if (change === "string-marker")
			mocks.execution.mockResolvedValue({
				...execution,
				triggerInput: {
					...execution.triggerInput,
					workspaceReviewBinding: "workspace-story-review",
				},
			});
		if (change === "changed-force")
			mocks.execution.mockResolvedValue({
				...execution,
				triggerInput: {
					...execution.triggerInput,
					triggerData: { forceReview: true },
				},
			});
		expect((await executeAdoStoryReviewStep(input)).success).toBe(false);
		expect(mocks.generate).not.toHaveBeenCalled();
	});

	it("rejects a controller binding removed during inference instead of accepting the output", async () => {
		const { input, frame } = controllerRun();
		mocks.frame
			.mockResolvedValueOnce(frame)
			.mockResolvedValueOnce({ ...frame, projectId: null });
		const result = await executeAdoStoryReviewStep(input);
		expect(mocks.generate).toHaveBeenCalledOnce();
		expect(result.success).toBe(false);
		expect(result).not.toHaveProperty("output");
	});

	it("attributes usage only to an authorized parent Workspace", async () => {
		const input = params({ workspaceFrameId: "workspace-1" });
		authorize(input);
		mocks.frame.mockResolvedValue({
			id: "workspace-1",
			userId: "user-1",
			organizationId: "org-1",
			projectId: null,
			surface: "workspace",
		});
		expect((await executeAdoStoryReviewStep(input)).success).toBe(true);
		expect(mocks.frame).toHaveBeenCalledWith({
			id: "workspace-1",
			userId: "user-1",
			organizationId: "org-1",
		});
		expect(mocks.model).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ frameId: "workspace-1" }),
		);
	});

	it("normalizes selected fields and prevents persistent force configuration", () => {
		const config = adoStoryReviewConfigSchema.parse({
			...params().nodeConfig,
			forceReview: true,
			workItemTypes: ["Task", "User Story", "Task"],
		});
		expect(config.workItemTypes).toEqual(["Task", "User Story"]);
		expect(config).not.toHaveProperty("forceReview");
	});

	it("preserves canonical prompt bytes while extracting tool-free base instructions", () => {
		const template = {
			id: "template-1",
			name: "reviewer",
			displayName: "Reviewer",
			description: "Reviews stories.",
			instructions: " Check requirements. ",
			tools: [],
			knowledgeSources: [],
			suggestedModel: null,
		};
		const instance = {
			id: "instance-1",
			name: "Review",
			description: "Notes",
			customInstructions: {
				role: "Role",
				additionalContext: "Context",
				constraints: "Constraints",
			},
			modelOverride: null,
			modelConfig: null,
		};
		const base =
			"# Reviewer\n\nReviews stories.\n\nCheck requirements.\n\n## Custom Role Instructions\nRole\n\n## Additional Context\nContext\n\n## Constraints\nConstraints\n\n## Instance Notes\nNotes";
		expect(buildAgentInstructions(template, instance)).toBe(base);
		expect(buildSystemPrompt(template, instance)).toBe(
			`${base}\n\nCurrent date: fixture`,
		);
		expect(
			buildSystemPrompt(
				{ ...template, tools: ["discover-tools"] },
				instance,
			),
		).toContain("## Tool Discovery");
		expect(buildAgentInstructions(template, instance)).not.toContain(
			"Tool Discovery",
		);
	});

	it("does not rewind the baseline watermark when a run completed late", async () => {
		const output = await baseline();
		const cache = reviewCacheSchema.parse(output.cache);
		const binding = {
			userId: cache.userId,
			organizationId: cache.organizationId,
			projectId: cache.projectId,
			workflowId: cache.workflowId,
			nodeId: cache.nodeId,
			selectionFingerprint: cache.selectionFingerprint,
		};
		const earlier = {
			...cache,
			requirementsAsOf: "2026-01-01T12:00:00.000Z",
		};
		const future = {
			...cache,
			requirementsAsOf: "2026-01-03T12:00:00.000Z",
		};
		expect(
			selectReviewBaseline(
				{
					candidates: [
						{
							id: "earlier-late",
							cache: earlier,
							completedAt: new Date("2026-01-04"),
						},
						{
							id: "current",
							cache,
							completedAt: new Date(asOf),
						},
						{
							id: "future",
							cache: future,
							completedAt: new Date("2026-01-03"),
						},
					],
					hasMore: false,
				},
				binding,
				asOf,
				"2026-01-05T00:00:00Z",
			).cache?.requirementsAsOf,
		).toBe(asOf);
		const preciseAsOf = "2026-01-02T12:00:00.1000002Z";
		expect(
			selectReviewBaseline(
				{
					candidates: [
						{
							id: "earlier-fraction",
							completedAt: new Date("2026-01-04"),
							cache: {
								...cache,
								requirementsAsOf:
									"2026-01-02T12:00:00.1000001Z",
							},
						},
						{
							id: "newer-fraction",
							completedAt: new Date(asOf),
							cache: { ...cache, requirementsAsOf: preciseAsOf },
						},
						{
							id: "future-fraction",
							completedAt: new Date(asOf),
							cache: {
								...cache,
								requirementsAsOf:
									"2026-01-02T12:00:00.1000003Z",
							},
						},
					],
					hasMore: false,
				},
				binding,
				preciseAsOf,
				"2026-01-05T00:00:00Z",
			).cache?.requirementsAsOf,
		).toBe(preciseAsOf);
		const offset = selectReviewBaseline(
			{
				candidates: [
					{
						id: "offset-form",
						completedAt: new Date(asOf),
						cache: {
							...cache,
							requirementsAsOf: "2026-01-02T14:00:00+02:00",
						},
					},
				],
				hasMore: false,
			},
			binding,
			asOf,
			"2026-01-05T00:00:00Z",
		);
		expect(offset.cache).toBeUndefined();
		expect(offset.status).toBe("incomplete");
	});
});
