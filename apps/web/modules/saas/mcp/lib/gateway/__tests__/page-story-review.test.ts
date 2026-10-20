import { WorkflowCommandError } from "@repo/api/modules/workflows/lib/workflow-command-context";
import { FABRIC_PAGE_TOOL_DEFINITIONS } from "@repo/temporal/fabric-page-tool-definitions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { scopeSatisfied } from "../tool-scope";
import {
	handleConfigureStoryReview,
	handleGetStoryReview,
	handleListStoryReviewRuns,
	handleRunStoryReview,
} from "../tools/page-story-review";
import type { GatewaySession } from "../types";

const mocks = vi.hoisted(() => ({
	frame: vi.fn(),
	access: vi.fn(),
	project: vi.fn(),
	editFrames: vi.fn(),
	read: vi.fn(),
	configure: vi.fn(),
	run: vi.fn(),
	history: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	getAccessibleFrameById: mocks.frame,
	hasProjectAccess: mocks.access,
	canUpdateOrganizationFrames: mocks.editFrames,
	db: { project: { findFirst: mocks.project } },
}));
vi.mock(
	"@repo/api/modules/workflows/lib/workspace-story-review-commands",
	async () => {
		const { z } = await import("zod");
		const { adoStoryReviewConfigFieldsSchema } = await import(
			"@repo/temporal/ado-story-review-config"
		);
		const read = z
			.object({ workflowId: z.string().min(1).max(128) })
			.strict();
		return {
			workspaceStoryReviewReadSchema: read,
			workspaceStoryReviewRunSchema: read
				.extend({
					expectedUpdatedAt: z.string().datetime(),
					idempotencyKey: z.string().min(1).max(128),
					forceReview: z.boolean().default(false),
				})
				.strict(),
			workspaceStoryReviewHistorySchema: read
				.extend({
					limit: z.number().int().min(1).max(20).default(10),
					offset: z.number().int().min(0).max(1000).default(0),
				})
				.strict(),
			runWorkspaceStoryReviewCommand: mocks.run,
			listWorkspaceStoryReviewRunsCommand: mocks.history,
			workspaceStoryReviewEditSchema: read
				.extend({
					expectedUpdatedAt: z.string().datetime({ offset: true }),
					config: adoStoryReviewConfigFieldsSchema
						.omit({ workspaceFrameId: true })
						.strict(),
					schedule: z
						.object({ cron: z.string(), timezone: z.string() })
						.strict(),
				})
				.strict(),
			getWorkspaceStoryReviewCommand: mocks.read,
			configureWorkspaceStoryReviewCommand: mocks.configure,
		};
	},
);

const session: GatewaySession = {
	sessionId: "session-1",
	userId: "owner-1",
	organizationId: "org-1",
	userName: "Example Owner",
	email: "owner@example.com",
	role: "user",
	credential: "session",
	scopes: ["*"],
	createdAt: new Date("2026-01-01"),
	expiresAt: new Date("2026-01-02"),
};
const frame = {
	id: "workspace-1",
	userId: "owner-1",
	organizationId: "org-1",
	surface: "workspace",
	projectId: "project-1",
	updatedAt: new Date("2026-01-01T12:00:00Z"),
};
const args = {
	frameId: "workspace-1",
	workflowId: "workflow-1",
	expectedUpdatedAt: "2026-01-01T12:00:00.000Z",
	config: { assignee: { mode: "current" }, rubric: "Check clarity" },
	schedule: { cron: "0 10 * * *", timezone: "UTC" },
};

beforeEach(() => {
	vi.resetAllMocks();
	mocks.frame.mockResolvedValue(frame);
	mocks.access.mockResolvedValue(true);
	mocks.project.mockResolvedValue({ id: "project-1" });
	mocks.editFrames.mockResolvedValue(true);
	mocks.read.mockResolvedValue({ id: "workflow-1" });
	mocks.configure.mockResolvedValue({
		workflow: { id: "workflow-1" },
		schedule: null,
	});
});

describe("page-bound review commands", () => {
	it("runs only the authorized Workspace binding with a one-off force flag", async () => {
		mocks.run.mockResolvedValueOnce({
			executionId: "run-1",
			startStatus: "unconfirmed",
		});
		const result = await handleRunStoryReview(
			{
				frameId: "workspace-1",
				workflowId: "workflow-1",
				expectedUpdatedAt: frame.updatedAt.toISOString(),
				idempotencyKey: "click-1",
				forceReview: true,
			},
			session,
		);
		expect(result.isError).not.toBe(true);
		expect(mocks.run).toHaveBeenCalledWith(
			{ userId: session.userId, organizationId: session.organizationId },
			{
				id: frame.id,
				userId: frame.userId,
				organizationId: frame.organizationId,
				projectId: frame.projectId,
				updatedAt: frame.updatedAt,
			},
			expect.objectContaining({
				idempotencyKey: "click-1",
				forceReview: true,
			}),
		);
	});

	it("rejects forged run metadata and unbounded history before opening the page", async () => {
		expect(
			(
				await handleRunStoryReview(
					{
						frameId: "workspace-1",
						workflowId: "workflow-1",
						expectedUpdatedAt: frame.updatedAt.toISOString(),
						idempotencyKey: "click-1",
						workspaceReviewBinding: {},
					},
					session,
				)
			).isError,
		).toBe(true);
		expect(
			(
				await handleListStoryReviewRuns(
					{
						frameId: "workspace-1",
						workflowId: "workflow-1",
						limit: 21,
					},
					session,
				)
			).isError,
		).toBe(true);
		expect(mocks.frame).not.toHaveBeenCalled();
		expect(mocks.run).not.toHaveBeenCalled();
		expect(mocks.history).not.toHaveBeenCalled();
	});

	it("makes the run definition require a per-call approval and workflow-run scope", () => {
		const tool = FABRIC_PAGE_TOOL_DEFINITIONS.find(
			(tool) => tool.name === "fabric_page_run_story_review",
		);
		expect(tool).toMatchObject({
			confirm: "always",
			scope: "workflows:run",
			page: "taints",
			annotations: { readOnlyHint: false },
		});
		expect(
			scopeSatisfied(
				["workflows:read"],
				{ scope: "workflows:run", kind: "write" },
				"personal-key",
			),
		).toBe(false);
	});
	it("derives its actor and binding from the currently accessible Workspace", async () => {
		expect(
			(await handleConfigureStoryReview(args, session)).isError,
		).not.toBe(true);
		expect(mocks.frame).toHaveBeenCalledWith({
			id: "workspace-1",
			userId: "owner-1",
			userEmail: "owner@example.com",
			organizationId: "org-1",
		});
		expect(mocks.project).toHaveBeenCalledWith({
			where: {
				id: "project-1",
				organizationId: "org-1",
				deletedAt: null,
			},
			select: { id: true },
		});
		expect(mocks.editFrames).toHaveBeenCalledWith("owner-1", "org-1");
		expect(mocks.configure).toHaveBeenCalledWith(
			{ userId: "owner-1", organizationId: "org-1" },
			{
				id: "workspace-1",
				userId: "owner-1",
				organizationId: "org-1",
				projectId: "project-1",
			},
			expect.objectContaining({ workflowId: "workflow-1" }),
		);
	});

	it("reads without demanding write permission", async () => {
		mocks.editFrames.mockResolvedValue(false);
		const result = await handleGetStoryReview(
			{ frameId: "workspace-1", workflowId: "workflow-1" },
			session,
		);
		expect(result.isError).not.toBe(true);
		expect(mocks.read).toHaveBeenCalledWith(
			{ userId: "owner-1", organizationId: "org-1" },
			{
				id: "workspace-1",
				userId: "owner-1",
				organizationId: "org-1",
				projectId: "project-1",
			},
			"workflow-1",
		);
		expect(mocks.editFrames).not.toHaveBeenCalled();
	});

	it.each([
		{ organizationId: "foreign-org" },
		{ projectId: "foreign-project" },
		{ nodes: [] },
		{ edges: [] },
		{ status: "PUBLISHED" },
		{ forceReview: true },
		{ config: { ...args.config, workspaceFrameId: "foreign-workspace" } },
		{ config: { ...args.config, credentials: "not-accepted" } },
		{ expectedUpdatedAt: undefined },
	])(
		"rejects unsupported page arguments before authority lookup",
		async (patch) => {
			expect(
				(
					await handleConfigureStoryReview(
						{ ...args, ...patch },
						session,
					)
				).isError,
			).toBe(true);
			expect(mocks.frame).not.toHaveBeenCalled();
			expect(mocks.configure).not.toHaveBeenCalled();
		},
	);

	it.each([
		null,
		{ ...frame, userId: "other-owner" },
		{ ...frame, organizationId: "other-org" },
		{ ...frame, surface: "artifact" },
		{ ...frame, projectId: null },
	])(
		"refuses inaccessible, foreign, unbound or non-owner Workspaces",
		async (record) => {
			mocks.frame.mockResolvedValueOnce(record);
			expect(
				(await handleConfigureStoryReview(args, session)).isError,
			).toBe(true);
			expect(mocks.configure).not.toHaveBeenCalled();
		},
	);

	it("refuses current permission loss, inaccessible/deleted projects and foreign project grants", async () => {
		mocks.editFrames.mockResolvedValueOnce(false);
		expect((await handleConfigureStoryReview(args, session)).isError).toBe(
			true,
		);
		mocks.access.mockResolvedValueOnce(false);
		expect((await handleConfigureStoryReview(args, session)).isError).toBe(
			true,
		);
		mocks.project.mockResolvedValueOnce(null);
		expect((await handleConfigureStoryReview(args, session)).isError).toBe(
			true,
		);
		expect(
			(
				await handleConfigureStoryReview(args, {
					...session,
					pinnedProjectId: "other-project",
				})
			).isError,
		).toBe(true);
		expect(mocks.configure).not.toHaveBeenCalled();
	});

	it("returns the real failed scheduler outcome without raw provider details", async () => {
		mocks.configure.mockResolvedValueOnce({
			workflow: { id: "workflow-1" },
			schedule: { outcome: "failed", reason: "private provider detail" },
		});
		const result = await handleConfigureStoryReview(args, session);
		expect(JSON.parse(result.content[0].text)).toMatchObject({
			workflow: { id: "workflow-1" },
			schedule: { outcome: "failed" },
		});
		expect(JSON.stringify(result)).not.toContain("private provider detail");
	});

	it("classifies command conflicts and suppresses unexpected internal errors", async () => {
		mocks.configure.mockRejectedValueOnce(
			new WorkflowCommandError("CONFLICT", "Read current settings."),
		);
		const conflict = await handleConfigureStoryReview(args, session);
		expect(JSON.parse(conflict.content[0].text)).toMatchObject({
			reason: "CONFLICT",
		});
		mocks.configure.mockRejectedValueOnce(
			new Error("private database detail"),
		);
		expect(
			JSON.stringify(await handleConfigureStoryReview(args, session)),
		).not.toContain("private database detail");
	});

	it("declares a write scope that a read-only key cannot satisfy", () => {
		const definition = FABRIC_PAGE_TOOL_DEFINITIONS.find(
			(tool) => tool.name === "fabric_page_configure_story_review",
		);
		expect(definition).toMatchObject({
			scope: "workflows:write",
			confirm: "always",
			annotations: { readOnlyHint: false },
		});
		expect(
			scopeSatisfied(
				["workflows:read"],
				{ scope: "workflows:write", kind: "write" },
				"personal-key",
			),
		).toBe(false);
	});
});
