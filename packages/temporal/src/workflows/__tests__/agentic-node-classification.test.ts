/**
 * The agent-task and publish-frame nodes run unattended. How they are
 * classified decides whether Read-only mode blocks them, whether the run waits
 * for a human, and whether Temporal retries them — so each choice is pinned.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	db: {},
}));
vi.mock("@repo/database/prisma/queries/approvals", () => ({
	createApproval: vi.fn(),
	getApprovalStatus: vi.fn(),
}));

import { preflightValidation } from "../../activities/preflight-validation";
import { stepRegistry } from "../../activities/lib/step-registry";
import {
	ADO_STORY_REVIEW_NODE_TYPE,
	AGENT_TASK_NODE_TYPE,
	PUBLISH_FRAME_NODE_TYPE,
} from "../../lib/workflow-node-types";
import {
	EXTERNAL_WRITE_NODE_TYPES,
	isAgentTaskNodeType,
	isExternalWriteNodeType,
	isNonRetryableNodeType,
} from "../lib/workflow-builder-nodes";

describe("agentic node classification", () => {
	it("keeps Workspace data writes internal while disabling retries", () => {
		expect(isNonRetryableNodeType("workspace-data-write")).toBe(true);
		expect(isNonRetryableNodeType("workspace-data-read")).toBe(false);
		expect(isExternalWriteNodeType("workspace-data-write")).toBe(false);
	});

	it("registers executors for agent tasks, story review and publishing", () => {
		expect(AGENT_TASK_NODE_TYPE in stepRegistry).toBe(true);
		expect(PUBLISH_FRAME_NODE_TYPE in stepRegistry).toBe(true);
		expect(stepRegistry[ADO_STORY_REVIEW_NODE_TYPE]?.name).toBe(
			"Review ADO Stories",
		);
	});

	it("recognises the agent node by the type the preset builds", () => {
		expect(isAgentTaskNodeType(AGENT_TASK_NODE_TYPE)).toBe(true);
		expect(isAgentTaskNodeType(PUBLISH_FRAME_NODE_TYPE)).toBe(false);
		expect(isAgentTaskNodeType("mcp-tool")).toBe(false);
	});

	it("is not an external write: Read-only mode gates the agent's tools, not the step", () => {
		expect(isExternalWriteNodeType(AGENT_TASK_NODE_TYPE)).toBe(false);
		expect(EXTERNAL_WRITE_NODE_TYPES.has(AGENT_TASK_NODE_TYPE)).toBe(false);
	});

	it("publishes only inside Fabric, so it is not an external write either", () => {
		expect(isExternalWriteNodeType(PUBLISH_FRAME_NODE_TYPE)).toBe(false);
	});

	it("never retries an agent turn, which would spend a second run", () => {
		expect(isNonRetryableNodeType(AGENT_TASK_NODE_TYPE)).toBe(true);
	});

	it("retries publishing, which is idempotent per run", () => {
		expect(isNonRetryableNodeType(PUBLISH_FRAME_NODE_TYPE)).toBe(false);
	});

	it("does not retry story review inference or classify it as a source write or full agent turn", () => {
		expect(isNonRetryableNodeType(ADO_STORY_REVIEW_NODE_TYPE)).toBe(true);
		expect(isExternalWriteNodeType(ADO_STORY_REVIEW_NODE_TYPE)).toBe(false);
		expect(isAgentTaskNodeType(ADO_STORY_REVIEW_NODE_TYPE)).toBe(false);
	});

	it.each([
		AGENT_TASK_NODE_TYPE,
		PUBLISH_FRAME_NODE_TYPE,
		ADO_STORY_REVIEW_NODE_TYPE,
	])(
		"%s never pauses an unattended run for human approval",
		async (stepType) => {
			const result = await preflightValidation({
				executionId: "exec-1",
				stepId: "node-1",
				stepType,
				stepConfig: {},
				userId: "user-1",
				organizationId: "org-1",
				requireApprovalForHighRisk: true,
				approvalThreshold: 1,
			});

			expect(result.requiresApproval).toBe(false);
			expect(result.riskAssessment?.score).toBe(0);
		},
	);
});
