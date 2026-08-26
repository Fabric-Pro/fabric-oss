import { describe, expect, it } from "vitest";
import {
	formatPrimaryTaskLabel,
	getImplementationSessionLinks,
	getVibeLinkState,
	getWorkspaceRuntimeState,
	summarizeTaskSessionVisibility,
} from "../implementation-session-runtime";

describe("implementation-session-runtime helpers", () => {
	it("derives linked Vibe issue and project URLs from session metadata", () => {
		const links = getImplementationSessionLinks({
			provider: "VIBE_WORKSPACE",
			externalUrl:
				"http://127.0.0.1:4242/projects/proj_1/issues/issue_1/workspaces/ws_1",
			providerMetadata: {
				remoteProjectId: "proj_1",
				remoteIssueId: "issue_1",
			},
		});

		expect(links.sessionUrl).toBe(
			"http://127.0.0.1:4242/projects/proj_1/issues/issue_1/workspaces/ws_1",
		);
		expect(links.projectUrl).toBe("http://127.0.0.1:4242/projects/proj_1");
		expect(links.issueUrl).toBe(
			"http://127.0.0.1:4242/projects/proj_1/issues/issue_1",
		);
	});

	it("returns only the session URL for non-workspace providers", () => {
		const links = getImplementationSessionLinks({
			provider: "KANBAN_LOCAL",
			externalUrl: "http://127.0.0.1:3333/tasks/123",
			providerMetadata: {
				remoteProjectId: "ignored",
				remoteIssueId: "ignored",
			},
		});

		expect(links.sessionUrl).toBe("http://127.0.0.1:3333/tasks/123");
		expect(links.projectUrl).toBeNull();
		expect(links.issueUrl).toBeNull();
	});

	it("reports review-required workspace state when approval metadata is present", () => {
		const state = getWorkspaceRuntimeState({
			status: "RUNNING",
			externalStatus: "workspace_linked_to_vibe_issue",
			providerMetadata: {
				hasPendingApproval: true,
				latestProcessStatus: "running",
				prStatus: "draft",
			},
		});

		expect(state.shortLabel).toBe("Review Required");
		expect(state.reviewRequired).toBe(true);
		expect(state.latestProcessStatus).toBe("running");
		expect(state.prStatus).toBe("draft");
	});

	it("parses Vibe linked issue metadata for summary surfaces", () => {
		const state = getVibeLinkState({
			issueLinkingStatus: "linked_remote_issue",
			remoteProjectId: "proj_1",
			remoteProjectName: "Fabric",
			remoteIssueId: "issue_1",
			remoteIssueSimpleId: "FAB-101",
			remoteIssueTitle: "Implement task session badges",
		});

		expect(state.status).toBe("linked");
		expect(state.projectName).toBe("Fabric");
		expect(state.issueSimpleId).toBe("FAB-101");
	});

	it("formats a primary task label for summary and detail emphasis", () => {
		expect(
			formatPrimaryTaskLabel({
				id: "task_1",
				identifier: "TASK-007",
				title: "Polish summary task focus",
			}),
		).toBe("TASK-007 · Polish summary task focus");
	});

	it("summarizes task-scoped visibility across active, review, recent, and workspace sessions", () => {
		const now = new Date("2026-03-27T05:00:00.000Z").getTime();
		const summary = summarizeTaskSessionVisibility(
			[
				{
					latestCodingRun: {
						status: "RUNNING",
						provider: "VIBE_WORKSPACE",
						externalStatus: "workspace_linked_to_vibe_issue",
						providerMetadata: { hasPendingApproval: true },
						createdAt: new Date("2026-03-27T04:45:00.000Z"),
					},
				},
				{
					latestCodingRun: {
						status: "COMPLETED",
						provider: "KANBAN_LOCAL",
						createdAt: new Date("2026-03-27T02:00:00.000Z"),
					},
				},
				{
					latestCodingRun: {
						status: "FAILED",
						provider: "BACKGROUND_AGENTS",
						createdAt: new Date("2026-03-20T02:00:00.000Z"),
					},
				},
			],
			now,
		);

		expect(summary.activeCount).toBe(1);
		expect(summary.reviewCount).toBe(1);
		expect(summary.recentCount).toBe(2);
		expect(summary.workspaceCount).toBe(1);
	});
});
