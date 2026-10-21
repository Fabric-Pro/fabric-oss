import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	raw: vi.fn(),
	frame: vi.fn(),
	update: vi.fn(),
	graph: vi.fn(),
	audit: vi.fn(),
}));
vi.mock("../prisma/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("../prisma/client")>()),
	db: {
		agentWorkspaceFile: { findFirst: mocks.frame },
		$transaction: async <T>(body: (tx: object) => Promise<T>) =>
			body({
				$queryRaw: mocks.raw,
				agentWorkspaceFile: {
					findFirst: mocks.frame,
					update: mocks.update,
				},
				workflowVersion: { findFirst: mocks.graph },
			}),
	},
}));
vi.mock("../prisma/queries/audit-log", () => ({ recordAuditTx: mocks.audit }));

import {
	getWorkspacePublishedWorkflowGraph,
	getWorkspaceWorkflowGrant,
	listWorkspaceWorkflowHistory,
	mutateWorkspaceWorkflowBinding,
} from "../prisma/queries/workflows/workspace-workflows";
import {
	workspaceWorkflowBindingsSchema,
	type WorkspaceWorkflowRowGuard,
	type WorkspaceWorkflowRunGuard,
} from "../prisma/queries/workflows/workspace-workflow-binding";

const stamp = new Date("2026-01-01T12:00:00Z");
const binding: WorkspaceWorkflowRunGuard = {
	workflowId: "workflow-1",
	userId: "owner-1",
	organizationId: "org-1",
	projectId: "project-1",
	workspaceFrameId: "workspace-1",
	workflowUpdatedAt: stamp,
	frameUpdatedAt: stamp,
	status: "PUBLISHED",
	requirement: { kind: "bound-run", workflowVersion: 2 },
};
const grant = {
	workflowId: binding.workflowId,
	authorizedWorkflowVersion: 2,
	authorizedWorkflowUpdatedAt: stamp.toISOString(),
};
const metadata = {
	surface: "workspace",
	unrelated: { retained: true },
	workflowBindings: { version: 1, workflows: [grant] },
};
const input = {
	binding: {
		...binding,
		requirement: { kind: "row-only" },
	} satisfies WorkspaceWorkflowRowGuard,
	action: "bind" as const,
	workflowVersion: 2,
	auditActor: { userId: binding.userId },
};

beforeEach(() => {
	vi.resetAllMocks();
	mocks.raw.mockImplementation(async (strings: TemplateStringsArray) => {
		const sql = strings.join("?");
		if (sql.includes("FROM workflow_execution")) {
			return [];
		}
		if (sql.includes("FROM workflow")) {
			return [
				{ id: binding.workflowId, version: 2, publishedVersion: 2 },
			];
		}
		if (sql.includes("FROM agent_workspace_file")) {
			return [{ id: binding.workspaceFrameId, metadata }];
		}
		return [{ id: binding.projectId }];
	});
	mocks.frame.mockResolvedValue({
		id: binding.workspaceFrameId,
		userId: binding.userId,
		organizationId: binding.organizationId,
		projectId: binding.projectId,
		updatedAt: stamp,
		metadata,
	});
	mocks.update.mockResolvedValue({
		id: binding.workspaceFrameId,
		updatedAt: stamp,
	});
	mocks.graph.mockResolvedValue({ nodes: [], edges: [], variables: null });
});

describe("trusted Workspace workflow metadata", () => {
	it("accepts both existing Workspace document kinds", async () => {
		await getWorkspaceWorkflowGrant({
			frameId: binding.workspaceFrameId,
			workflowId: binding.workflowId,
			userId: binding.userId,
			organizationId: binding.organizationId,
		});
		expect(mocks.frame.mock.calls[0]?.[0].where.fileType).toEqual({
			in: ["FRAME", "SLIDESHOW"],
		});
	});
	it("preserves arbitrary row metadata and audits binding in the same transaction", async () => {
		await mutateWorkspaceWorkflowBinding(input);
		expect(mocks.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: binding.workspaceFrameId, updatedAt: stamp },
				data: { metadata },
			}),
		);
		expect(mocks.audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "activity.mcp.fabric_bind_workspace_workflow",
				resource: {
					type: "agent_workspace_file",
					id: binding.workspaceFrameId,
				},
				metadata: {
					workflowId: binding.workflowId,
					operation: "bind",
					workflowVersion: 2,
					workflowUpdatedAt: stamp.toISOString(),
				},
			}),
		);
	});
	it("can grant a workflow that is not already bound", async () => {
		mocks.frame.mockResolvedValueOnce({
			metadata: { surface: "workspace", retained: 1 },
		});
		await mutateWorkspaceWorkflowBinding(input);
		expect(mocks.update.mock.calls[0]?.[0].data.metadata).toEqual({
			surface: "workspace",
			retained: 1,
			workflowBindings: { version: 1, workflows: [grant] },
		});
	});
	it("removes stale grants without requiring a live published version", async () => {
		await mutateWorkspaceWorkflowBinding({
			...input,
			binding: {
				...binding,
				status: "PAUSED",
				requirement: { kind: "row-only" },
			},
			action: "unbind",
		});
		expect(
			mocks.update.mock.calls[0]?.[0].data.metadata.workflowBindings
				.workflows,
		).toEqual([]);
	});
	it.each([0, 1, 2])(
		"fails closed when guarded workflow/frame/project read %i no longer matches",
		async (failedIndex) => {
			let guardedReads = 0;
			mocks.raw.mockImplementation(
				async (strings: TemplateStringsArray) => {
					const sql = strings.join("?");
					if (
						sql.includes("FOR SHARE") &&
						(sql.includes("AND status") ||
							sql.includes("metadata->>'surface'") ||
							sql.includes('AND "deletedAt"'))
					) {
						if (guardedReads++ === failedIndex) {
							return [];
						}
					}
					return [
						{
							id: "row",
							version: 2,
							publishedVersion: 2,
							metadata,
						},
					];
				},
			);
			await expect(mutateWorkspaceWorkflowBinding(input)).rejects.toThrow(
				"The Workspace or workflow changed",
			);
			expect(mocks.update).not.toHaveBeenCalled();
			expect(mocks.audit).not.toHaveBeenCalled();
		},
	);
	it("locks and filters exact owner, org, project, timestamps and nondeleted project", async () => {
		await mutateWorkspaceWorkflowBinding(input);
		const queries = mocks.raw.mock.calls.map(([strings, ...values]) => ({
			sql: strings.join("?"),
			values,
		}));
		expect(
			queries.find(
				(query) =>
					query.sql.includes("AND status") &&
					query.sql.includes("FROM workflow"),
			),
		).toMatchObject({
			values: [
				binding.workflowId,
				binding.userId,
				binding.organizationId,
				binding.projectId,
				stamp,
				binding.status,
			],
		});
		expect(
			queries.find(
				(query) =>
					query.sql.includes("metadata->>'surface'") &&
					query.sql.includes("FROM agent_workspace_file"),
			),
		).toMatchObject({
			values: [
				binding.workspaceFrameId,
				binding.userId,
				binding.organizationId,
				binding.projectId,
				stamp,
			],
		});
		expect(
			queries.some((query) => query.sql.includes('"deletedAt" IS NULL')),
		).toBe(true);
		expect(queries[1]?.sql).toContain("FOR UPDATE");
	});
	it("does not treat content metadata or a forged document as a row grant", async () => {
		mocks.frame.mockResolvedValueOnce({
			projectId: "project-1",
			metadata: { surface: "workspace" },
			content: JSON.stringify({ metadata }),
		});
		expect(
			await getWorkspaceWorkflowGrant({
				frameId: binding.workspaceFrameId,
				workflowId: binding.workflowId,
				userId: binding.userId,
				organizationId: binding.organizationId,
			}),
		).toBeNull();
	});
	it("refuses a missing, stale or malformed trusted grant for graph access", async () => {
		mocks.raw
			.mockResolvedValueOnce([
				{ id: binding.workflowId, version: 2, publishedVersion: 2 },
			])
			.mockResolvedValueOnce([
				{
					id: binding.workspaceFrameId,
					metadata: {
						surface: "workspace",
						workflowBindings: {
							version: 1,
							workflows: [
								{ ...grant, authorizedWorkflowVersion: 1 },
							],
						},
					},
				},
			]);
		await expect(
			getWorkspacePublishedWorkflowGraph(binding),
		).rejects.toThrow("The Workspace or workflow changed");
		expect(mocks.graph).not.toHaveBeenCalled();
	});
	it("allows a stale grant to read history but still requires its trusted bound ID", async () => {
		const readBinding = {
			...binding,
			requirement: { kind: "bound-read" as const },
		};
		mocks.raw
			.mockResolvedValueOnce([
				{ id: binding.workflowId, version: 3, publishedVersion: 2 },
			])
			.mockResolvedValueOnce([
				{ id: binding.workspaceFrameId, metadata },
			]);
		expect(
			await listWorkspaceWorkflowHistory({
				binding: readBinding,
				limit: 1,
				offset: 0,
			}),
		).toMatchObject({ runs: [] });
		mocks.raw
			.mockResolvedValueOnce([
				{ id: binding.workflowId, version: 3, publishedVersion: 2 },
			])
			.mockResolvedValueOnce([
				{
					id: binding.workspaceFrameId,
					metadata: {
						surface: "workspace",
						workflowBindings: { version: 1, workflows: [] },
					},
				},
			]);
		await expect(
			listWorkspaceWorkflowHistory({
				binding: readBinding,
				limit: 1,
				offset: 0,
			}),
		).rejects.toThrow("The Workspace or workflow changed");
	});
	it("bounds grant count and rejects duplicate IDs", () => {
		expect(
			workspaceWorkflowBindingsSchema.safeParse({
				version: 1,
				workflows: [grant, grant],
			}).success,
		).toBe(false);
		expect(
			workspaceWorkflowBindingsSchema.safeParse({
				version: 1,
				workflows: Array.from({ length: 21 }, (_, index) => ({
					...grant,
					workflowId: `workflow-${index}`,
				})),
			}).success,
		).toBe(false);
	});
	it("reads only the scoped published version fields", async () => {
		await getWorkspacePublishedWorkflowGraph(binding);
		expect(mocks.graph).toHaveBeenCalledWith({
			where: {
				workflowId: binding.workflowId,
				version: 2,
				isPublished: true,
				userId: binding.userId,
				organizationId: binding.organizationId,
			},
			select: { nodes: true, edges: true, variables: true },
		});
	});
	it("projects bounded history and artifacts without raw output or provider errors", async () => {
		await listWorkspaceWorkflowHistory({
			binding,
			limit: 20,
			offset: 1000,
		});
		const query = mocks.raw.mock.calls.find(([strings]) =>
			strings.join("?").includes("FROM workflow_execution"),
		);
		expect(query).toBeDefined();
		const sql = query?.[0].join("?");
		expect(sql).toContain('e.error IS NOT NULL AS "hasError"');
		expect(sql).toContain(
			"JOIN agent_workspace_file f ON f.id = node.value->>'frameId'",
		);
		expect(sql).toContain("f.metadata->>'sourceNodeId' = node.key");
		expect(sql).not.toContain("SELECT e.output");
		expect(query?.slice(-2)).toEqual([21, 1000]);
	});
	it("refuses history bounds before any database operation", async () => {
		await expect(
			listWorkspaceWorkflowHistory({ binding, limit: 21, offset: 0 }),
		).rejects.toThrow(RangeError);
		await expect(
			listWorkspaceWorkflowHistory({ binding, limit: 1, offset: 1001 }),
		).rejects.toThrow(RangeError);
		expect(mocks.raw).not.toHaveBeenCalled();
	});
});
