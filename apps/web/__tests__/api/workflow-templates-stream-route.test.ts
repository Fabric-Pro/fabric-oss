// @vitest-environment node
/**
 * /api/agents/workflow-templates/stream — the Deep Research stream route,
 * characterized from the outside so its admission can move into a shared
 * module without changing what the route answers:
 *
 *   - no session: 401; no query: 400; a member of no such organization: 403,
 *     and nothing is started;
 *   - a run is started under `wf-<user>-deep-researcher-<uuid>` with the
 *     template's defaults and `planEligible`, then streamed as `started`,
 *     each sub-agent's `sub_agent_complete` and `completed` with the
 *     workflow's result fields.
 */
import type { DeepResearcherOutput } from "@repo/temporal";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	getSession: vi.fn(),
	membership: vi.fn(),
	instance: vi.fn(),
	filterWorkspaces: vi.fn(),
	start: vi.fn(),
}));

vi.mock("@saas/auth/lib/server", () => ({ getSession: () => m.getSession() }));
vi.mock("@repo/ai/lib/chatgpt-plan/interactive-context", () => ({
	enterAiInteractiveContext: () => undefined,
}));
vi.mock("@repo/database", async () => {
	const { getTemplateWorkflow } = await import(
		"@repo/database/src/workflow-templates"
	);
	return {
		getTemplateWorkflow,
		getOrganizationMembership: m.membership,
		getInstanceWithTemplate: m.instance,
		filterAccessibleWorkspaceIds: m.filterWorkspaces,
	};
});
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({ workflow: { start: m.start } }),
}));

const { POST } = await import(
	"@/app/api/agents/workflow-templates/stream/route"
);

const USER = "user-example-1";
const ORG = "org-example-1";

const OUTPUT: DeepResearcherOutput = {
	executionId: "ignored",
	status: "completed",
	result: "The full report.",
	summary: "In short.",
	keyFindings: [{ theme: "Theme", findings: ["One"], confidence: 80 }],
	sources: ["https://example.com/a"],
	subAgentResults: [
		{
			subTaskId: "sub-1",
			title: "First angle",
			status: "completed",
			findings: "Found it.",
			sources: ["https://example.com/a"],
			confidence: 80,
			duration: 1200,
		},
	],
	iterations: 1,
	goalAchieved: true,
	duration: 5000,
};

function post(body: unknown) {
	return POST(
		new NextRequest(
			"http://localhost/api/agents/workflow-templates/stream",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			},
		),
	);
}

async function events(response: Response) {
	const text = await response.text();
	return text
		.split("\n\n")
		.filter((chunk) => chunk.startsWith("data: "))
		.map((chunk) => JSON.parse(chunk.slice("data: ".length)));
}

beforeEach(() => {
	vi.clearAllMocks();
	m.getSession.mockResolvedValue({
		user: { id: USER },
		session: { impersonatedBy: null },
	});
	m.membership.mockResolvedValue({ role: "member" });
	m.start.mockImplementation(
		async (_name: string, options: { workflowId: string }) => ({
			workflowId: options.workflowId,
			describe: async () => ({ status: { name: "COMPLETED" } }),
			result: async () => OUTPUT,
			query: async () => null,
		}),
	);
});

describe("POST /api/agents/workflow-templates/stream", () => {
	it("answers 401 without a session", async () => {
		m.getSession.mockResolvedValue(null);

		const response = await post({
			templateSlug: "deep-researcher",
			query: "Q",
		});

		expect(response.status).toBe(401);
		expect(m.start).not.toHaveBeenCalled();
	});

	it("answers 400 without a query", async () => {
		const response = await post({ templateSlug: "deep-researcher" });

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "templateSlug and query are required",
		});
		expect(m.start).not.toHaveBeenCalled();
	});

	it("answers 403 for an organization the caller is not a member of", async () => {
		m.membership.mockResolvedValue(null);

		const response = await post({
			templateSlug: "deep-researcher",
			query: "Q",
			organizationId: ORG,
		});

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "You are not a member of this organization",
			code: "FORBIDDEN",
		});
		expect(m.membership).toHaveBeenCalledWith(ORG, USER);
		expect(m.start).not.toHaveBeenCalled();
	});

	it("starts the research and streams it to its completed result", async () => {
		const response = await post({
			templateSlug: "deep-researcher",
			query: "What changed?",
			organizationId: ORG,
		});

		expect(response.status).toBe(200);
		const list = await events(response);
		const [name, options] = m.start.mock.calls[0] ?? [];
		expect(name).toBe("deepResearcherWorkflow");
		expect(options.taskQueue).toBe("fabric-worker");
		expect(options.workflowId).toMatch(
			/^wf-user-example-1-deep-researcher-[0-9a-f-]{36}$/,
		);
		expect(options.args).toEqual([
			expect.objectContaining({
				executionId: options.workflowId,
				query: "What changed?",
				userId: USER,
				organizationId: ORG,
				maxSubAgents: 6,
				maxIterations: 3,
				planEligible: true,
			}),
		]);
		expect(list.map((event) => event.type)).toEqual([
			"started",
			"sub_agent_complete",
			"completed",
		]);
		expect(list[0]).toEqual({
			type: "started",
			executionId: options.workflowId,
			workflowId: options.workflowId,
			templateSlug: "deep-researcher",
		});
		expect(list[1]).toMatchObject({
			subTaskId: "sub-1",
			title: "First angle",
			findings: "Found it.",
		});
		expect(list[2]).toEqual({
			type: "completed",
			status: "completed",
			result: OUTPUT.result,
			summary: OUTPUT.summary,
			keyFindings: OUTPUT.keyFindings,
			sources: OUTPUT.sources,
			subAgentResults: OUTPUT.subAgentResults,
			iterations: 1,
			goalAchieved: true,
			duration: 5000,
		});
	});
});
