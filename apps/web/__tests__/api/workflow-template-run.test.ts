// @vitest-environment node
/**
 * The workflow-template run's admission and start, shared by the Deep
 * Research stream route and the agent runtime's deep-researcher engine:
 *
 *   - the stream route's 400, 403 and 404 answers, and no membership check
 *     for a personal run;
 *   - an agent instance's context, and only the workspaces the caller can
 *     open (`filterAccessibleWorkspaceIds`), reach the workflow input;
 *   - the start: `deepResearcherWorkflow` on `fabric-worker` under the
 *     execution id, with the template's defaults and `planEligible`.
 */

import { getTemporalClient } from "@repo/temporal";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	admitWorkflowTemplateRun,
	newWorkflowTemplateExecutionId,
	startDeepResearcherWorkflow,
} from "@/app/api/agents/workflow-templates/workflow-template-run";

const m = vi.hoisted(() => ({
	membership: vi.fn(),
	instance: vi.fn(),
	filterWorkspaces: vi.fn(),
	start: vi.fn(),
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

const USER = "user-example-1";
const ORG = "org-example-1";
const INSTANCE = "instance-example-1";

async function refusal(
	result: Awaited<ReturnType<typeof admitWorkflowTemplateRun>>,
) {
	expect(result).toBeInstanceOf(Response);
	return result instanceof Response
		? { status: result.status, body: await result.json() }
		: null;
}

async function admitted(
	result: Awaited<ReturnType<typeof admitWorkflowTemplateRun>>,
) {
	if (result instanceof Response) {
		throw new Error(`refused: ${result.status} ${await result.text()}`);
	}
	return result;
}

beforeEach(() => {
	vi.clearAllMocks();
	m.membership.mockResolvedValue({ role: "member" });
	m.instance.mockResolvedValue({
		goal: "Track the market",
		description: "Weekly brief",
		customInstructions: {
			role: "Analyst",
			additionalContext: "Focus on pricing",
			constraints: "Cite sources",
		},
		workspaceIds: ["workspace-open", "workspace-closed"],
	});
	m.filterWorkspaces.mockResolvedValue({
		allowed: ["workspace-open"],
		dropped: ["workspace-closed"],
	});
	m.start.mockResolvedValue({ workflowId: "started" });
});

describe("admitWorkflowTemplateRun", () => {
	it("answers 400 for a missing query and NO_WORKFLOW for a template with no workflow", async () => {
		expect(
			await refusal(
				await admitWorkflowTemplateRun(USER, {
					templateSlug: "deep-researcher",
				}),
			),
		).toEqual({
			status: 400,
			body: { error: "templateSlug and query are required" },
		});
		expect(
			await refusal(
				await admitWorkflowTemplateRun(USER, {
					templateSlug: "not-a-workflow-template",
					query: "Q",
				}),
			),
		).toMatchObject({ status: 400, body: { code: "NO_WORKFLOW" } });
		expect(m.membership).not.toHaveBeenCalled();
	});

	it("answers 403 FORBIDDEN when the caller is not a member, checked with (org, user)", async () => {
		m.membership.mockResolvedValue(null);

		expect(
			await refusal(
				await admitWorkflowTemplateRun(USER, {
					templateSlug: "deep-researcher",
					query: "Q",
					organizationId: ORG,
				}),
			),
		).toEqual({
			status: 403,
			body: {
				error: "You are not a member of this organization",
				code: "FORBIDDEN",
			},
		});
		expect(m.membership).toHaveBeenCalledWith(ORG, USER);
		expect(m.instance).not.toHaveBeenCalled();
	});

	it("checks no membership for a personal run", async () => {
		const run = await admitted(
			await admitWorkflowTemplateRun(USER, {
				templateSlug: "deep-researcher",
				query: "Q",
				organizationId: null,
			}),
		);

		expect(m.membership).not.toHaveBeenCalled();
		expect(run.input.organizationId).toBeUndefined();
	});

	it("answers 404 INSTANCE_NOT_FOUND for an instance the caller cannot read", async () => {
		m.instance.mockResolvedValue(null);

		expect(
			await refusal(
				await admitWorkflowTemplateRun(USER, {
					templateSlug: "deep-researcher",
					query: "Q",
					organizationId: ORG,
					instanceId: INSTANCE,
				}),
			),
		).toMatchObject({ status: 404, body: { code: "INSTANCE_NOT_FOUND" } });
		expect(m.instance).toHaveBeenCalledWith(INSTANCE, USER, ORG);
	});

	it("joins an instance's goal, notes and instructions as the context, with blank lines", async () => {
		const run = await admitted(
			await admitWorkflowTemplateRun(USER, {
				templateSlug: "deep-researcher",
				query: "Q",
				organizationId: ORG,
				instanceId: INSTANCE,
			}),
		);

		expect(run.input.context).toBe(
			[
				"Goal: Track the market",
				"Instance Notes: Weekly brief",
				"Custom Role Instructions: Analyst",
				"Additional Context: Focus on pricing",
				"Constraints: Cite sources",
			].join("\n\n"),
		);
	});

	it("an instance's workspaces the caller cannot open are kept out of the input", async () => {
		const run = await admitted(
			await admitWorkflowTemplateRun(USER, {
				templateSlug: "deep-researcher",
				query: "Q",
				organizationId: ORG,
				instanceId: INSTANCE,
			}),
		);

		expect(m.filterWorkspaces).toHaveBeenCalledWith({
			workspaceIds: ["workspace-open", "workspace-closed"],
			userId: USER,
			organizationId: ORG,
		});
		expect(run.input.workspaceIds).toEqual(["workspace-open"]);
	});

	it("builds the input with the template's defaults", async () => {
		const run = await admitted(
			await admitWorkflowTemplateRun(USER, {
				templateSlug: "deep-researcher",
				query: "What changed?",
				organizationId: ORG,
				reasoningEffort: "high",
			}),
		);

		expect(run.templateSlug).toBe("deep-researcher");
		expect(run.input).toEqual({
			query: "What changed?",
			userId: USER,
			organizationId: ORG,
			instanceId: undefined,
			context: undefined,
			maxSubAgents: 6,
			maxIterations: 3,
			successCriteria: undefined,
			reasoningEffort: "high",
			workspaceIds: undefined,
		});
	});
});

describe("starting a run", () => {
	it("starts deepResearcherWorkflow on fabric-worker under the execution id, with planEligible", async () => {
		const run = await admitted(
			await admitWorkflowTemplateRun(USER, {
				templateSlug: "deep-researcher",
				query: "What changed?",
				organizationId: ORG,
			}),
		);
		const executionId = newWorkflowTemplateExecutionId(
			USER,
			"deep-researcher",
		);

		await startDeepResearcherWorkflow(
			await getTemporalClient(),
			run,
			executionId,
		);

		expect(m.start).toHaveBeenCalledWith("deepResearcherWorkflow", {
			taskQueue: "fabric-worker",
			workflowId: executionId,
			args: [
				{
					...run.input,
					executionId,
					planEligible: true,
					maxSubAgents: 6,
					maxIterations: 3,
				},
			],
		});
	});

	it("names an execution wf-<user>-<template>-<uuid>", () => {
		expect(newWorkflowTemplateExecutionId(USER, "deep-researcher")).toMatch(
			/^wf-user-example-1-deep-researcher-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	});
});
