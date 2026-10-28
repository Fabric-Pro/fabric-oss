import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	analyzePlanForApproval,
	checkAutoApproval,
	inferApprovalOperation,
	loadTrustConfiguration,
	recordTrustOutcome,
	type TrustConfiguration,
} from "../src/activities/orchestrator/approval/trust-manager";
import {
	classifyIntegrationAccessLevel,
	MUTATING_TOKENS,
} from "../src/activities/orchestrator/execution/authority-gate";
import { detectOperationRisk } from "../src/activities/orchestrator/planning/operation-risk-detector";
import { presentPlan } from "../src/activities/orchestrator/presentation/plan-presenter";
import { PLAN_RISK_SCORE } from "../src/workflows/orchestrator/orchestrator-config";
import { executePlanningPhase } from "../src/workflows/orchestrator/phases/planning";
import type {
	ExecutionModeConfig,
	OrchestratorWorkflowInput,
	RoutingDecision,
	TaskPlan,
	TaskStep,
	WorkflowState,
} from "../src/workflows/orchestrator/types";

// Frozen copy of the old classifier at 671178b67, used as an oracle.
function baseInferOperationType(step: TaskStep): string {
	const descLower = step.description.toLowerCase();

	if (descLower.includes("delete") || descLower.includes("remove")) {
		return "delete";
	}
	if (
		descLower.includes("create") ||
		descLower.includes("add") ||
		descLower.includes("new")
	) {
		return "create";
	}
	if (
		descLower.includes("update") ||
		descLower.includes("modify") ||
		descLower.includes("edit")
	) {
		return "update";
	}
	if (descLower.includes("search") || descLower.includes("find")) {
		return "search";
	}
	if (descLower.includes("list") || descLower.includes("show all")) {
		return "list";
	}
	if (
		descLower.includes("get") ||
		descLower.includes("retrieve") ||
		descLower.includes("fetch")
	) {
		return "read";
	}

	return step.type || "unknown";
}

const researchNames = [
	"firecrawl_search",
	"firecrawl-search",
	"web_search",
	"search",
	"google_search",
	"bing_search",
	"firecrawl_scrape",
	"firecrawl-scrape",
	"firecrawl_scrape_url",
	"scrape_url",
	"scrape",
	"fetch_url",
];

vi.mock("@repo/database", () => ({
	db: {
		userOrchestratorPreferences: {
			findUnique: vi.fn().mockResolvedValue(null),
		},
	},
}));

const activities = vi.hoisted(() => ({
	analyzeAndRoute: vi.fn(),
	createTaskPlan: vi.fn(),
	validatePlan: vi.fn(async () => ({ isValid: true })),
	inferAndValidateContractsActivity: vi.fn(async () => ({
		validation: { errors: [], warnings: [] },
	})),
	analyzePlanApprovalActivity: vi.fn(),
	createOrchestratorApprovalRequest: vi.fn(async () => ({
		approvalId: "example-approval",
	})),
	updateApprovalTaskStatus: vi.fn(),
	recordApprovalOutcomeActivity: vi.fn(),
}));
vi.mock("@temporalio/workflow", () => ({
	log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
	proxyActivities: () => activities,
}));

const routing: RoutingDecision = {
	primaryAgent: "example-agent",
	secondaryAgents: [],
	confidence: 1,
	reasoning: "Read public information",
	riskLevel: "medium",
	riskFactors: [],
	suggestedStrategy: "research",
};

function step(overrides: Partial<TaskStep> = {}): TaskStep {
	const task: TaskStep = {
		id: "example-step",
		description: "Read the record",
		type: "api",
		status: "pending",
		order: 1,
		riskLevel: "low",
		...overrides,
	};
	return task;
}

function plan(
	steps: TaskStep[],
	riskLevel: TaskPlan["riskLevel"] = "low",
): TaskPlan {
	return {
		id: "example-plan",
		description: "Look up vehicle details",
		steps,
		riskLevel,
		strategy: "research",
		createdAt: "2026-01-01T00:00:00Z",
	};
}

function isLlmOnlyAnswer(task: TaskStep): boolean {
	return (
		task.capability === "llm" &&
		!task.executor &&
		!task.toolsToUse?.length &&
		!task.app &&
		!["delete", "update"].includes(baseInferOperationType(task))
	);
}
function independentWriteEvidence(task: TaskStep): boolean {
	const names = [...(task.toolsToUse ?? []), ...(task.app ? [task.app] : [])];
	const identifierWrite = names.some((name) => {
		const tokens = name
			.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
			.toLowerCase()
			.split(/[^a-z0-9]+/);
		return tokens.some(
			(token) =>
				MUTATING_TOKENS.has(token) ||
				["delete", "create", "update"].includes(
					detectOperationRisk({ description: token }).operationType,
				) ||
				[
					"email",
					"notify",
					"write",
					"replace",
					"duplicate",
					"submit",
					"cancel",
				].includes(token),
		);
	});
	return (
		identifierWrite ||
		(task.capability === "integration" &&
			(typeof task.inputs?.operation !== "string" ||
				classifyIntegrationAccessLevel(
					task.inputs.operation,
					String(task.inputs.integrationProvider ?? task.app ?? ""),
				) === "WRITE"))
	);
}
const reviewerPhrasings = [
	"List my assigned issues",
	"Get the approved pull requests",
	"List the PRs that are ready to merge",
	"Find all failing jobs and re-run them",
	"List the overdue tasks, closing each one",
];
const writeTools = [
	"slack_send_message",
	"jira_update_issue",
	"fizzy_mark_notification_read",
	"github_delete_branch",
];
function approvalCorpus(): TaskStep[] {
	const corpus: TaskStep[] = [];
	for (const capability of [
		"agent",
		"workflow",
		"integration",
		"web",
		"mcp_tool",
		"llm",
	] as const) {
		for (const description of [
			...reviewerPhrasings,
			"Get the record",
			"Create the record",
			"Delete the record",
			"Update the record",
			"Answer with the decoded VIN details and the official source",
			"Review the most recently created pull request",
			"Verify the VIN with the official source",
			"Write the final answer with the official source",
			"Attach the summary to the team drive",
		]) {
			corpus.push(step({ capability, description }));
		}
		for (const tool of [
			...researchNames,
			...writeTools,
			"get_merge_request",
			"get_workflow_run",
			"githubMergePullRequest",
			"slack-reply-thread",
			"get_insert_record",
			"get_cancel_record",
			"opaque_tool",
		]) {
			for (const description of [
				"Get the record",
				"List the open items",
				"Find the record",
			]) {
				for (const source of ["app", "toolsToUse"] as const) {
					corpus.push(
						step({
							capability,
							description,
							...(source === "app"
								? { app: tool }
								: { toolsToUse: [tool] }),
						}),
					);
				}
			}
		}
	}
	for (const app of ["slack", "NHTSA_VPIC"]) {
		for (const operation of [
			undefined,
			42,
			"send_message",
			"decode_vin",
			"get_issue",
			"opaque_operation",
		]) {
			for (const description of [
				"Get the record",
				"List the open items",
				"Process the record",
			]) {
				corpus.push(
					step({
						capability: "integration",
						app,
						description,
						inputs: { operation },
					}),
				);
			}
		}
	}
	corpus.push(
		step({
			capability: "llm",
			executor: "example-agent",
			description: "Answer the question",
		}),
	);
	return corpus;
}

describe("Planner approval risk", () => {
	let trust: TrustConfiguration;
	beforeEach(async () => {
		trust = await loadTrustConfiguration("example-user", "example-org");
	});
	// Promoting an operation or bypassing default operation trust breaks this oracle.
	it("satisfies the approval oracle without exceptions", () => {
		const violations: unknown[] = [];
		let baseApproved = 0;
		let approved = 0;
		let denied = 0;
		const corpus = approvalCorpus();
		for (const task of corpus) {
			const base = baseInferOperationType(task);
			const baseAuto = ["read", "list", "search"].includes(base);
			const operation = inferApprovalOperation(task);
			const auto = checkAutoApproval(task, trust).autoApprove;
			if (baseAuto) {
				baseApproved++;
			}
			if (auto) {
				approved++;
			}
			if (baseAuto && !auto) {
				denied++;
			}
			if (
				(auto && !baseAuto) ||
				(["read", "list", "search"].includes(operation) && !baseAuto)
			) {
				violations.push({ task, base, operation, auto });
			}
		}
		process.stdout.write(
			`Approval oracle ${JSON.stringify({ total: corpus.length, baseApproved, approved, denied, violations: violations.length })}\n`,
		);
		expect(violations).toEqual([]);
	});
	// Extending reversibility to list/search, or dropping a structured veto, breaks this oracle.
	it("satisfies the base-plus-LLM display oracle", () => {
		const violations: unknown[] = [];
		const less: TaskStep[] = [];
		let more = 0;
		let reversible = 0;
		let structured = 0;
		const corpus = approvalCorpus();
		for (const task of corpus) {
			const action = analyzePlanForApproval(plan([task]), trust)
				.plannedActions[0];
			const base = ["read", "create"].includes(
				baseInferOperationType(task),
			);
			const write = independentWriteEvidence(task);
			if (write) {
				structured++;
			}
			if (action.reversible) {
				reversible++;
			}
			if (
				action.reversible &&
				((!base && !isLlmOnlyAnswer(task)) || write)
			) {
				violations.push({ task, action });
			}
			if (base && !action.reversible) {
				more++;
			}
			if (!base && action.reversible) {
				less.push(task);
			}
		}
		process.stdout.write(
			`Display oracle ${JSON.stringify({ total: corpus.length, reversible, structured, more, less: less.length, violations: violations.length })}\nLess conservative displays ${JSON.stringify(less)}\n`,
		);
		expect(violations).toEqual([]);
		expect(less.length).toBeGreaterThan(0);
		for (const task of less) {
			expect(isLlmOnlyAnswer(task)).toBe(true);
		}
	});
	// Adding prose vocabulary breaks equality, including deliberately hidden writes.
	it.each(reviewerPhrasings)(
		"retains exactly the base result without structured evidence: %s",
		(description) => {
			const task = step({ capability: "mcp_tool", description });
			const base = baseInferOperationType(task);
			expect(inferApprovalOperation(task)).toBe(base);
			expect(checkAutoApproval(task, trust).autoApprove).toBe(
				["read", "list", "search"].includes(base),
			);
			expect(
				analyzePlanForApproval(plan([task]), trust).plannedActions[0],
			).toMatchObject({
				action: base,
				reversible: ["read", "create"].includes(base),
			});
		},
	);
	// Removing identifier token vetoes breaks these read-step cases.
	it.each(writeTools)(
		"denies structured write tool on a read: %s",
		(tool) => {
			const task = step({
				description: "Get the record",
				toolsToUse: [tool],
			});
			expect(checkAutoApproval(task, trust).autoApprove).toBe(false);
			expect(
				analyzePlanForApproval(plan([task]), trust).plannedActions[0]
					.reversible,
			).toBe(false);
		},
	);
	// Losing operation classification, unknown-operation caution, or base fallback breaks these cases.
	it.each([
		{
			task: step({
				description: "List the open items",
				toolsToUse: ["github_delete_branch"],
			}),
			action: "delete",
			approved: false,
		},
		{
			task: step({
				capability: "integration",
				app: "slack",
				description: "Get the record",
			}),
			action: "write",
			approved: false,
		},
		{
			task: step({
				capability: "integration",
				app: "NHTSA_VPIC",
				description: "Get the record",
				inputs: { operation: "decode_vin" },
			}),
			action: "read",
			approved: true,
		},
		{
			task: step({
				capability: "integration",
				app: "NHTSA_VPIC",
				inputs: { operation: "decode_vin" },
			}),
			action: "api",
			approved: false,
		},
		{
			task: step({
				capability: "integration",
				app: "slack",
				description: "Get the record",
				inputs: { operation: "send_message" },
			}),
			action: "send",
			approved: false,
		},
	])(
		"labels structured evidence: $action $task",
		({ task, action, approved }) => {
			expect(
				analyzePlanForApproval(plan([task]), trust).plannedActions[0],
			).toMatchObject({ action, reversible: action === "read" });
			expect(checkAutoApproval(task, trust).autoApprove).toBe(approved);
		},
	);
	// Dropping LLM precision, scanning prose, or changing base display labels breaks these cases.
	it.each([
		{
			task: step({
				capability: "llm",
				description:
					"Answer with the decoded VIN details and the official source",
			}),
			action: "generate",
			reversible: true,
		},
		{
			task: step({
				description: "Review the most recently created pull request",
			}),
			action: "create",
			reversible: true,
		},
		{
			task: step({
				capability: "web",
				description: "Verify the VIN with the official source",
			}),
			action: "api",
			reversible: false,
		},
		{
			task: step({
				capability: "llm",
				description: "Write the final answer with the official source",
			}),
			action: "generate",
			reversible: true,
		},
		{
			task: step({
				capability: "llm",
				executor: "example-agent",
				description: "Answer the question",
			}),
			action: "api",
			reversible: false,
		},
	])(
		"keeps the card display contract: $task.description",
		({ task, action, reversible }) => {
			const summary = analyzePlanForApproval(plan([task]), trust);
			expect(summary.plannedActions[0]).toEqual({
				action,
				reversible,
				target: task.description,
			});
			expect(
				summary.plannedActions.filter((item) => !item.reversible),
			).toHaveLength(reversible ? 0 : 1);
		},
	);
	it("keeps a low-risk VIN lookup low despite two medium steps", () => {
		const lookup = plan([
			step({
				description:
					"Search the official source for VIN details and the vehicle address",
				capability: "web",
				app: "web_search",
				riskLevel: "medium",
			}),
			step({
				description: "Get the vehicle record",
				toolsToUse: ["service_get_record"],
				riskLevel: "medium",
			}),
			step({
				description:
					"Answer with the decoded VIN details and the official source",
				type: "generate",
				capability: "llm",
			}),
		]);
		const summary = analyzePlanForApproval(lookup, trust);
		expect(summary.overallRisk).toBe("low");
		expect(PLAN_RISK_SCORE[summary.overallRisk]).toBe(20);
		expect(presentPlan(lookup, routing)).toMatch(
			/Overall Risk\*\*: .* LOW/,
		);
		expect(summary.plannedActions).toEqual([
			{
				action: "create",
				target: lookup.steps[0].description,
				reversible: true,
			},
			{
				action: "read",
				target: lookup.steps[1].description,
				reversible: true,
			},
			{
				action: "generate",
				target: lookup.steps[2].description,
				reversible: true,
			},
		]);
	});

	it.each(["high", "critical"] as const)(
		"escalates a low plan for a %s step in approval and presentation",
		(riskLevel) => {
			const elevated = plan([step({ riskLevel })]);
			expect(analyzePlanForApproval(elevated, trust).overallRisk).toBe(
				riskLevel,
			);
			expect(presentPlan(elevated, routing)).toMatch(
				new RegExp(`Overall Risk\\*\\*: .* ${riskLevel.toUpperCase()}`),
			);
		},
	);

	it.each(["low", "medium", "high", "critical"] as const)(
		"uses declared %s risk in approval and presentation",
		(riskLevel) => {
			const declared = plan([step()], riskLevel);
			expect(analyzePlanForApproval(declared, trust).overallRisk).toBe(
				riskLevel,
			);
			expect(presentPlan(declared, routing)).toMatch(
				new RegExp(`Overall Risk\\*\\*: .* ${riskLevel.toUpperCase()}`),
			);
		},
	);

	it("defaults missing plan risk to low and retains the presenter routing fallback", () => {
		const legacy = plan([]);
		Reflect.deleteProperty(legacy, "riskLevel");
		expect(analyzePlanForApproval(legacy, trust).overallRisk).toBe("low");
		expect(presentPlan(legacy, routing)).toMatch(
			/Overall Risk\*\*: .* MEDIUM/,
		);
	});

	it("trims a full description at a word boundary", () => {
		const description =
			"Read the official vehicle record with supporting details from the public registry and return the complete source reference";
		expect(
			analyzePlanForApproval(plan([step({ description })]), trust)
				.plannedActions[0].target,
		).toBe(
			"Read the official vehicle record with supporting details from the public…",
		);
		expect(
			analyzePlanForApproval(
				plan([step({ description: "  VIN  " })]),
				trust,
			).plannedActions[0].target,
		).toBe("VIN");
	});

	it.each([
		["Delete the record", "Data will be permanently deleted"],
		["Create the record", "New resources will be created"],
		["Update the record", "Existing data will be modified"],
		["Send a message", "External communications will be sent"],
	])("retains whole-word impact: %s", (description, impact) => {
		expect(
			analyzePlanForApproval(
				plan([step({ description, riskLevel: "high" })]),
				trust,
			).highRiskSteps[0].impact,
		).toBe(impact);
	});

	it.each([
		["low", 20],
		["medium", 50],
		["high", 80],
		["critical", 95],
	] as const)("sends %s approval risk with score %i", async (risk, score) => {
		const taskPlan = plan(
			[
				step({
					capability: "llm",
					type: "generate",
					description: "Answer the question",
				}),
			],
			risk,
		);
		const summary = analyzePlanForApproval(taskPlan, trust);
		activities.analyzeAndRoute.mockResolvedValue(routing);
		activities.createTaskPlan.mockResolvedValue(taskPlan);
		activities.analyzePlanApprovalActivity.mockResolvedValue({
			requiresApproval: true,
			autoApprovedStepIds: [],
			pendingApprovalStepIds: ["example-step"],
			summary,
		});
		activities.createOrchestratorApprovalRequest.mockClear();
		const state = {
			executionId: "example-execution",
			enrichedMessage: "Answer the question",
			variables: {},
			planningAudit: { contextSources: [], decisions: [] },
			approvalHistory: [],
		} as unknown as WorkflowState;
		const result = await executePlanningPhase(
			state,
			{
				message: "Answer the question",
				userId: "example-user",
				organizationId: "example-org",
				history: [],
			} as unknown as OrchestratorWorkflowInput,
			{ taskDecomposition: true } as ExecutionModeConfig,
			vi.fn(),
			async () => {
				expect(state.pendingApproval?.reason).toContain(
					`${risk.toUpperCase()} RISK PLAN`,
				);
				expect(state.pendingApproval?.reason).not.toContain(
					"Irreversible actions",
				);
				return { approved: true };
			},
		);
		expect(result.success).toBe(true);
		expect(
			activities.createOrchestratorApprovalRequest,
		).toHaveBeenCalledWith(
			expect.objectContaining({ riskLevel: risk, riskScore: score }),
		);
	});

	it.each([
		["low", 20],
		["medium", 50],
		["high", 80],
		["critical", 95],
	] as const)("scores %s risk as %i", (risk, score) => {
		expect(PLAN_RISK_SCORE).toMatchObject({ [risk]: score });
	});

	it.each([
		["Deletes the merged branches", "Data will be permanently deleted"],
		["Removing stale tags", "Data will be permanently deleted"],
		["Sends the report", "External communications will be sent"],
		["Updates each ticket", "Existing data will be modified"],
		["Adding tags", "New resources will be created"],
		["Editing tags", "Existing data will be modified"],
		["Modifying tags", "Existing data will be modified"],
		["Read the address", "Standard operation"],
	])("describes inflected impact: %s", (description, impact) => {
		expect(
			analyzePlanForApproval(
				plan([step({ description, riskLevel: "high" })]),
				trust,
			).highRiskSteps[0].impact,
		).toBe(impact);
	});
	it("uses approval inference for agent scope and learned history", () => {
		const task = step({
			executor: "example-agent",
			description: "Get the record",
			toolsToUse: ["get_cancel_record"],
		});
		trust.agentTrust.set("example-agent", {
			agentId: "example-agent",
			level: "full",
			scope: ["read"],
			usageCount: 0,
			grantedAt: new Date(),
			grantedBy: "example-user",
		});
		for (let index = 0; index < 5; index++) {
			recordTrustOutcome(
				trust,
				step({ ...task, toolsToUse: ["github_get_pull_request"] }),
				true,
				"success",
			);
		}
		expect(checkAutoApproval(task, trust).autoApprove).toBe(false);
		recordTrustOutcome(trust, task, true, "success");
		expect(trust.trustHistory.at(-1)?.operation).toBe("write");
	});

	// Read tools named with noun-like verbs keep the base result, as the authority gate rates them READ.
	it.each([
		"get_page",
		"read_page",
		"getConfluencePage",
		"list_merge_requests",
		"get_merge_request",
		"fabric_get_page_viewer",
		"fabric_list_page_tools",
		"fabric_get_workflow_run",
		"get_order",
		"get_schedule",
		"get_share_link",
	])("keeps the base read for read tool %s", (tool) => {
		const task = step({
			capability: "mcp_tool",
			description: "Get the record",
			toolsToUse: [tool],
		});
		expect(inferApprovalOperation(task)).toBe("read");
		expect(checkAutoApproval(task, trust).autoApprove).toBe(true);
		expect(
			analyzePlanForApproval(plan([task]), trust).plannedActions[0],
		).toMatchObject({ action: "read", reversible: true });
	});
	// Removing a token or ignoring app breaks this table.
	it.each([...MUTATING_TOKENS])(
		"denies identifier token in either source: %s",
		(token) => {
			for (const source of ["app", "toolsToUse"] as const) {
				const task = step({
					description: "Get the record",
					capability: "web",
					...(source === "app"
						? { app: `get_${token}_record` }
						: { toolsToUse: [`get_${token}_record`] }),
				});
				expect(inferApprovalOperation(task)).not.toBe("read");
				expect(checkAutoApproval(task, trust).autoApprove).toBe(false);
				expect(
					analyzePlanForApproval(plan([task]), trust)
						.plannedActions[0].reversible,
				).toBe(false);
			}
		},
	);
	it("does not hide a write app behind a read toolsToUse entry", () => {
		const task = step({
			capability: "mcp_tool",
			app: "slack_send_message",
			toolsToUse: ["github_get_pull_request"],
		});
		expect(
			analyzePlanForApproval(plan([task]), trust).plannedActions[0],
		).toMatchObject({ action: "send", reversible: false });
		expect(checkAutoApproval(task, trust).autoApprove).toBe(false);
	});
	it("keeps unknown tools conservative even on an LLM generate step", () => {
		const unknown = step({
			type: "generate",
			capability: "llm",
			toolsToUse: ["opaque_tool"],
		});
		expect(
			analyzePlanForApproval(plan([unknown]), trust).plannedActions[0],
		).toMatchObject({ action: "generate", reversible: false });
		expect(checkAutoApproval(unknown, trust).autoApprove).toBe(false);
	});
	it("does not treat non-LLM generation as reversible", () => {
		const task = step({
			type: "generate",
			description: "Produce the result",
		});
		expect(
			analyzePlanForApproval(plan([task]), trust).plannedActions[0]
				.reversible,
		).toBe(false);
	});
	it("retains created participles in high-risk impact text", () => {
		const summary = analyzePlanForApproval(
			plan([
				step({
					description:
						"Read the most recently created record address",
					riskLevel: "high",
				}),
			]),
			trust,
		);
		expect(summary.highRiskSteps[0].impact).toBe(
			"New resources will be created",
		);
	});
	it("denies registered integration writes and explicit authority tokens only", () => {
		for (const operation of ["send_message", "opaque_operation"]) {
			expect(
				checkAutoApproval(
					step({
						capability: "integration",
						inputs: { operation, integrationProvider: "SLACK" },
						description: "Get history",
					}),
					trust,
				).autoApprove,
			).toBe(false);
		}
		for (const app of ["get_insert_record", "get_cancel_record"]) {
			expect(
				inferApprovalOperation(
					step({ app, description: "Get the record" }),
				),
			).not.toBe("read");
		}
		expect(
			inferApprovalOperation(
				step({ app: "opaque_tool", description: "Get the record" }),
			),
		).toBe("read");
		expect(
			inferApprovalOperation(
				step({
					toolsToUse: ["send_message", "create_card", "delete_card"],
					description: "Get the record",
				}),
			),
		).toBe("delete");
	});
	it.each([
		["Delete the record", "delete"],
		["Update the record", "update"],
	])(
		"keeps the base %s label irreversible on an LLM-only step",
		(description, action) => {
			expect(
				analyzePlanForApproval(
					plan([step({ capability: "llm", description })]),
					trust,
				).plannedActions[0],
			).toMatchObject({ action, reversible: false });
		},
	);
	it("keeps the requested read and LLM answer examples reversible", () => {
		for (const [task, action] of [
			[
				step({
					capability: "mcp_tool",
					app: "github_get_pull_request",
					description: "Get the pull request",
				}),
				"read",
			],
			[
				step({ capability: "llm", description: "Answer the question" }),
				"generate",
			],
		] as const) {
			expect(
				analyzePlanForApproval(plan([task]), trust).plannedActions[0],
			).toMatchObject({ action, reversible: true });
		}
	});
	it("keeps base list for Slack get_issue irreversible", () => {
		const task = step({
			capability: "integration",
			app: "slack",
			description: "Tell #eng the list of blockers",
			inputs: { operation: "get_issue", channel: "#eng", message: "x" },
		});
		expect(
			analyzePlanForApproval(plan([task]), trust).plannedActions[0],
		).toMatchObject({ action: "list", reversible: false });
	});
});
