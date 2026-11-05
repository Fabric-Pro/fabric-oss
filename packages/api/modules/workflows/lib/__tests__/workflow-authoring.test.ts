import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	read: vi.fn(),
	load: vi.fn(),
	create: vi.fn(),
	ai: vi.fn(),
	connection: vi.fn(),
	audit: vi.fn(),
	plan: vi.fn(),
	problems: vi.fn(),
}));
vi.mock("@repo/ai", () => ({ chatGptPlanServesCall: m.plan }));
vi.mock("../agentic-publish-validation", () => ({
	findAgenticPublishProblems: m.problems,
}));
vi.mock("@repo/database", () => ({
	getAiProviderApiKey: m.ai,
	resolveWorkflowIntegrationForProvider: m.connection,
	recordAudit: m.audit,
}));
vi.mock("../workflow-command-context", () => ({
	requireReadAccess: m.read,
	loadReadableWorkflow: m.load,
}));
vi.mock("../workflow-commands", () => ({ createWorkflowCommand: m.create }));

import {
	checkWorkflowReadiness,
	createWorkflowFromStarter,
	listWorkflowStarters,
} from "../workflow-authoring";

const actor = { userId: "example-user", organizationId: "example-org" };
const node = (
	id: string,
	type: string,
	config: Record<string, unknown> = {},
) => ({ id, type, position: { x: 0, y: 0 }, data: { label: id, config } });
beforeEach(() => {
	vi.clearAllMocks();
	m.plan.mockResolvedValue(false);
	m.problems.mockResolvedValue({ problems: [] });
	m.read.mockResolvedValue(undefined);
	m.load.mockResolvedValue({
		nodes: [
			node("start", "trigger"),
			node("draft", "ai-generate-text", { aiPrompt: "Summarize" }),
		],
		edges: [{ id: "e", source: "start", target: "draft" }],
	});
	m.ai.mockResolvedValue({
		apiKey: "example-secret",
		provider: "OPENAI_DIRECT",
	});
	m.create.mockImplementation(async (_actor, input) => ({
		id: "example-workflow",
		...input,
		status: "DRAFT",
	}));
});
it("requires current read authority before returning the starter catalog", async () => {
	m.read.mockRejectedValue(new Error("Current permission required"));
	await expect(listWorkflowStarters(actor)).rejects.toThrow(
		"Current permission",
	);
	expect(m.create).not.toHaveBeenCalled();
});
it.each([
	"delivery-brief",
	"action-plan",
	"release-notes",
	"decision-digest",
	"risk-review",
])(
	"creates %s as an authorized draft without activating it",
	async (starterId) => {
		const result = await createWorkflowFromStarter(actor, { starterId });
		expect(m.create).toHaveBeenCalledWith(
			actor,
			expect.objectContaining({
				settings: { deliveryStarterId: starterId },
			}),
		);
		expect(result.workflow.status).toBe("DRAFT");
		expect(result.workflow.nodes[1].data.config.aiPrompt).toContain(
			"{{$start.data.notes}}",
		);
		expect(m.audit).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: actor.organizationId,
				resource: { type: "workflow", id: "example-workflow" },
			}),
		);
	},
);
it("rejects actor overrides, unknown starters and invalid names before a mutation", async () => {
	for (const input of [
		{ starterId: "unknown" },
		{ starterId: "action-plan", organizationId: "other-org" },
		{ starterId: "action-plan", name: " " },
	])
		await expect(createWorkflowFromStarter(actor, input)).rejects.toThrow();
	expect(m.create).not.toHaveBeenCalled();
});
it("returns safe configuration status without credentials or external calls", async () => {
	const r = await checkWorkflowReadiness(actor, { id: "example-workflow" });
	expect(r.ready).toBe(true);
	expect(r.checks.find((c) => c.nodeId === "draft")?.status).toBe(
		"configured",
	);
	expect(JSON.stringify(r)).not.toContain("example-secret");
	expect(r.limitation).toContain("not been live-tested");
	expect(m.ai).toHaveBeenCalledWith(actor);
});
it("finds missing AI setup and required fields", async () => {
	m.ai.mockResolvedValue({ apiKey: null });
	expect(
		(await checkWorkflowReadiness(actor, { id: "example-workflow" })).ready,
	).toBe(false);
	m.load.mockResolvedValue({
		nodes: [node("start", "trigger"), node("draft", "ai-generate-text")],
		edges: [{ id: "e", source: "start", target: "draft" }],
	});
	expect(
		(await checkWorkflowReadiness(actor, { id: "example-workflow" }))
			.checks,
	).toContainEqual(
		expect.objectContaining({
			nodeId: "draft",
			status: "needs-setup",
			message: expect.stringContaining("Prompt"),
		}),
	);
});
it("uses the same accessible connection resolver as execution and never exposes connection details", async () => {
	m.load.mockResolvedValue({
		nodes: [
			node("start", "trigger"),
			node("send", "slack-send", {
				slackChannel: "example",
				slackMessage: "Hello",
			}),
		],
		edges: [{ id: "e", source: "start", target: "send" }],
	});
	m.connection.mockResolvedValue({
		id: "private-connection",
		credentials: { token: "example-secret" },
	});
	const r = await checkWorkflowReadiness(actor, { id: "example-workflow" });
	expect(m.connection).toHaveBeenCalledWith(
		"SLACK",
		actor.userId,
		actor.organizationId,
	);
	expect(JSON.stringify(r)).not.toMatch(/private-connection|example-secret/);
	m.connection.mockResolvedValue(null);
	expect(
		(await checkWorkflowReadiness(actor, { id: "example-workflow" })).ready,
	).toBe(false);
});
it("does not load providers after object access is refused", async () => {
	m.load.mockRejectedValue(new Error("Workflow not found"));
	await expect(
		checkWorkflowReadiness(actor, { id: "other-workflow" }),
	).rejects.toThrow("not found");
	expect(m.ai).not.toHaveBeenCalled();
	expect(m.connection).not.toHaveBeenCalled();
});

it("recognizes a configured eligible ChatGPT plan without a provider key", async () => {
	m.ai.mockResolvedValue({ apiKey: null });
	m.plan.mockResolvedValue(true);
	expect(
		(await checkWorkflowReadiness(actor, { id: "example-workflow" })).ready,
	).toBe(true);
	expect(m.plan).toHaveBeenCalledWith(
		expect.objectContaining({
			jobType: "workflow-builder",
			organizationId: actor.organizationId,
		}),
	);
});
it("uses the publication validator for static agent schemas", async () => {
	m.problems.mockResolvedValue({
		problems: ["Agent Task: prompt is required"],
	});
	const r = await checkWorkflowReadiness(actor, { id: "example-workflow" });
	expect(r.ready).toBe(false);
	expect(r.errors).toContain("Agent Task: prompt is required");
});
