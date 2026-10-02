/**
 * Unit tests for `resolvePmTarget`.
 *
 * Returns a discriminated descriptor of how a project's PM tool is configured:
 *   - { kind: "mcp", mcpConfigId, mcpConfig } — usable MCPConfig pinned
 *   - { kind: "rest-gitlab", mcpConfigId: null } — gitlab-official server +
 *     active WorkflowIntegration, no MCPConfig (REST fallback path)
 *   - null — nothing resolves
 *
 * Tenant scoping uses XOR (organizationId !== null ? {organizationId,userId} :
 * {organizationId:null,userId}).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	resolvePMConfigForUser: vi.fn(),
	db: {
		mCPServer: { findUnique: vi.fn() },
		workflowIntegration: { findFirst: vi.fn() },
	},
	isPmServerIdKeySentinel: (id: string) => id.startsWith("key:"),
	readPmServerIdKeySentinel: (id: string) => id.slice("key:".length),
}));

import { db, resolvePMConfigForUser } from "@repo/database";
import {
	createWorkflowIntegrationStore,
	type StoredRow,
} from "../../../integrations/__tests__/procedures/workflow-integration-store";
import { resolvePmTarget } from "../resolve-pm-target";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("resolvePmTarget", () => {
	it("returns kind=mcp when mcpConfigId resolves to an enabled config", async () => {
		vi.mocked(resolvePMConfigForUser).mockResolvedValue({
			id: "cfg1",
			enabled: true,
		} as never);

		const result = await resolvePmTarget({
			project: {
				projectManagementMcpServerId: "srv-x",
				projectManagementMcpConfigId: "cfg1",
				organizationId: null,
			},
			userId: "u1",
			organizationId: null,
		});

		expect(result).toMatchObject({
			kind: "mcp",
			mcpConfigId: "cfg1",
		});
	});

	it("returns null when mcpConfigId is set but resolves to a disabled config", async () => {
		vi.mocked(resolvePMConfigForUser).mockResolvedValue({
			id: "cfg1",
			enabled: false,
		} as never);

		const result = await resolvePmTarget({
			project: {
				projectManagementMcpServerId: "srv-x",
				projectManagementMcpConfigId: "cfg1",
				organizationId: null,
			},
			userId: "u1",
			organizationId: null,
		});

		expect(result).toBeNull();
	});

	it("returns null when mcpConfigId is set but resolvePMConfigForUser returns null", async () => {
		vi.mocked(resolvePMConfigForUser).mockResolvedValue(null);

		const result = await resolvePmTarget({
			project: {
				projectManagementMcpServerId: "srv-x",
				projectManagementMcpConfigId: "cfg-missing",
				organizationId: null,
			},
			userId: "u1",
			organizationId: null,
		});

		expect(result).toBeNull();
	});

	it("returns kind=rest-gitlab when configId is null, server is gitlab-official, integration is active", async () => {
		vi.mocked(db.mCPServer.findUnique).mockResolvedValue({
			key: "gitlab-official",
		} as never);
		vi.mocked(db.workflowIntegration.findFirst).mockResolvedValue({
			id: "wi1",
		} as never);

		const result = await resolvePmTarget({
			project: {
				projectManagementMcpServerId: "srv-gl",
				projectManagementMcpConfigId: null,
				organizationId: null,
			},
			userId: "u1",
			organizationId: null,
		});

		expect(result).toEqual({ kind: "rest-gitlab", mcpConfigId: null });
	});

	it("returns null when server is gitlab-official but no active WorkflowIntegration", async () => {
		vi.mocked(db.mCPServer.findUnique).mockResolvedValue({
			key: "gitlab-official",
		} as never);
		vi.mocked(db.workflowIntegration.findFirst).mockResolvedValue(null);

		const result = await resolvePmTarget({
			project: {
				projectManagementMcpServerId: "srv-gl",
				projectManagementMcpConfigId: null,
				organizationId: null,
			},
			userId: "u1",
			organizationId: null,
		});

		expect(result).toBeNull();
	});

	it("returns null when configId is null and server is not gitlab-official", async () => {
		vi.mocked(db.mCPServer.findUnique).mockResolvedValue({
			key: "fizzy",
		} as never);

		const result = await resolvePmTarget({
			project: {
				projectManagementMcpServerId: "srv-fz",
				projectManagementMcpConfigId: null,
				organizationId: null,
			},
			userId: "u1",
			organizationId: null,
		});

		expect(result).toBeNull();
	});

	it("returns null when both configId and serverId are null", async () => {
		const result = await resolvePmTarget({
			project: {
				projectManagementMcpServerId: null,
				projectManagementMcpConfigId: null,
				organizationId: null,
			},
			userId: "u1",
			organizationId: null,
		});

		expect(result).toBeNull();
	});

	it("uses XOR tenant filter for the WorkflowIntegration lookup (org context)", async () => {
		vi.mocked(db.mCPServer.findUnique).mockResolvedValue({
			key: "gitlab-official",
		} as never);
		vi.mocked(db.workflowIntegration.findFirst).mockResolvedValue({
			id: "wi1",
		} as never);

		await resolvePmTarget({
			project: {
				projectManagementMcpServerId: "srv-gl",
				projectManagementMcpConfigId: null,
				organizationId: "org-x",
			},
			userId: "u1",
			organizationId: "org-x",
		});

		const call = vi.mocked(db.workflowIntegration.findFirst).mock
			.calls[0]?.[0];
		expect(call?.where).toMatchObject({
			provider: "GITLAB",
			isActive: true,
			userId: "u1",
			organizationId: "org-x",
		});
	});

	it("uses XOR tenant filter for the WorkflowIntegration lookup (personal context)", async () => {
		vi.mocked(db.mCPServer.findUnique).mockResolvedValue({
			key: "gitlab-official",
		} as never);
		vi.mocked(db.workflowIntegration.findFirst).mockResolvedValue({
			id: "wi1",
		} as never);

		await resolvePmTarget({
			project: {
				projectManagementMcpServerId: "srv-gl",
				projectManagementMcpConfigId: null,
				organizationId: null,
			},
			userId: "u1",
			organizationId: null,
		});

		const call = vi.mocked(db.workflowIntegration.findFirst).mock
			.calls[0]?.[0];
		expect(call?.where).toMatchObject({
			provider: "GITLAB",
			isActive: true,
			userId: "u1",
			organizationId: null,
		});
	});

	it("returns kind=rest-gitlab for the key:gitlab-official sentinel when WorkflowIntegration is active", async () => {
		vi.mocked(db.workflowIntegration.findFirst).mockResolvedValue({
			id: "wi1",
		} as never);

		const result = await resolvePmTarget({
			project: {
				projectManagementMcpServerId: "key:gitlab-official",
				projectManagementMcpConfigId: null,
				organizationId: null,
			},
			userId: "u1",
			organizationId: null,
		});

		// Sentinel must not hit the catalog.
		expect(vi.mocked(db.mCPServer.findUnique)).not.toHaveBeenCalled();
		expect(result).toEqual({ kind: "rest-gitlab", mcpConfigId: null });
	});

	it("returns null for the sentinel when no active WorkflowIntegration exists", async () => {
		vi.mocked(db.workflowIntegration.findFirst).mockResolvedValue(null);

		const result = await resolvePmTarget({
			project: {
				projectManagementMcpServerId: "key:gitlab-official",
				projectManagementMcpConfigId: null,
				organizationId: null,
			},
			userId: "u1",
			organizationId: null,
		});

		expect(vi.mocked(db.mCPServer.findUnique)).not.toHaveBeenCalled();
		expect(result).toBeNull();
	});

	// --- Connection owner (mirrors temporal pm-source.ts) ---------------------
	// A GitLab WorkflowIntegration is a member's personal OAuth connection; in
	// org context the REST target resolves only through the CALLER's own
	// connection, never a teammate's. Rows are seeded in an in-memory store
	// (teammate first) so a lookup without `userId` would pick the teammate.

	const gitlabRow = (id: string, userId: string): StoredRow => ({
		id,
		userId,
		organizationId: "org-example",
		provider: "GITLAB",
		name: "GITLAB",
		isActive: true,
		credentials: "{}",
	});
	const teammateGitLab = gitlabRow("wi-teammate", "user-1");
	const callerGitLab = gitlabRow("wi-caller", "user-2");

	function seed(rows: StoredRow[]) {
		const store = createWorkflowIntegrationStore();
		store.rows.push(...rows);
		vi.mocked(db.workflowIntegration.findFirst).mockImplementation(
			store.delegate.findFirst as never,
		);
	}

	const gitlabProject = {
		projectManagementMcpServerId: "key:gitlab-official",
		projectManagementMcpConfigId: null,
		organizationId: "org-example",
	};

	it("org context: returns null when only a teammate has GitLab connected", async () => {
		seed([teammateGitLab]);

		const result = await resolvePmTarget({
			project: gitlabProject,
			userId: "user-2",
			organizationId: "org-example",
		});

		expect(result).toBeNull();
	});

	it("org context: resolves rest-gitlab from the caller's own connection", async () => {
		seed([teammateGitLab, callerGitLab]);

		const result = await resolvePmTarget({
			project: gitlabProject,
			userId: "user-2",
			organizationId: "org-example",
		});

		expect(result).toEqual({ kind: "rest-gitlab", mcpConfigId: null });
		expect(
			vi.mocked(db.workflowIntegration.findFirst).mock.calls[0]?.[0]
				?.where,
		).toMatchObject({ userId: "user-2", organizationId: "org-example" });
	});

	it("personal context: does not fall back to another user's integration", async () => {
		vi.mocked(db.mCPServer.findUnique).mockResolvedValue({
			key: "gitlab-official",
		} as never);
		vi.mocked(db.workflowIntegration.findFirst).mockResolvedValue(null);

		const result = await resolvePmTarget({
			project: {
				projectManagementMcpServerId: "srv-gl",
				projectManagementMcpConfigId: null,
				organizationId: null,
			},
			userId: "u2",
			organizationId: null,
		});

		expect(result).toBeNull();
		// Only the single user-scoped lookup in personal context.
		expect(
			vi.mocked(db.workflowIntegration.findFirst),
		).toHaveBeenCalledTimes(1);
	});
});
