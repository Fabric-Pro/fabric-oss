import { beforeEach, describe, expect, it, vi } from "vitest";

const { projectFindUnique, resolvePMConfigForUser } = vi.hoisted(() => ({
	projectFindUnique: vi.fn(),
	resolvePMConfigForUser: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { project: { findUnique: projectFindUnique } },
	resolvePMConfigForUser,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { resolveApplyPmConfig } from "../resolve-apply-pm-config";

const INPUT = { projectId: "p1", userId: "u1", organizationId: "org1" };

function project(overrides: Record<string, unknown>) {
	return {
		organizationId: "org1",
		projectManagementMcpServerId: "key:fizzy",
		projectManagementMcpConfigId: "cfg-owner",
		projectManagementContainerId: "container-1",
		projectManagementContainerName: "Proj",
		projectManagementAdditionalContext: null,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("resolveApplyPmConfig", () => {
	it("returns no-pm-config when the project has no PM container", async () => {
		projectFindUnique.mockResolvedValue(
			project({ projectManagementContainerId: null }),
		);
		const r = await resolveApplyPmConfig(INPUT);
		expect(r).toEqual({ resolved: false, reason: "no-pm-config" });
		expect(resolvePMConfigForUser).not.toHaveBeenCalled();
	});

	it("returns no-pm-config when the project row is missing", async () => {
		projectFindUnique.mockResolvedValue(null);
		const r = await resolveApplyPmConfig(INPUT);
		expect(r).toEqual({ resolved: false, reason: "no-pm-config" });
	});

	it("resolves the CALLER's own config for an MCP project (the silent-skip fix)", async () => {
		projectFindUnique.mockResolvedValue(
			project({ projectManagementAdditionalContext: { team: "T" } }),
		);
		resolvePMConfigForUser.mockResolvedValue({
			id: "cfg-caller",
			enabled: true,
		});
		const r = await resolveApplyPmConfig(INPUT);
		expect(r).toMatchObject({
			resolved: true,
			mcpConfigId: "cfg-caller",
			mcpServerId: "key:fizzy",
			containerId: "container-1",
			containerName: "Proj",
			additionalContext: { team: "T" },
		});
		// Resolution is for the APPLYING user, not the pinned owner config.
		expect(resolvePMConfigForUser).toHaveBeenCalledWith(
			expect.objectContaining({ configId: "cfg-owner", userId: "u1" }),
		);
	});

	it("falls back to GitLab REST (mcpConfigId null) when the caller has no own config", async () => {
		projectFindUnique.mockResolvedValue(
			project({
				projectManagementMcpServerId: "key:gitlab-official",
				projectManagementContainerId: "100",
			}),
		);
		resolvePMConfigForUser.mockResolvedValue(null);
		const r = await resolveApplyPmConfig(INPUT);
		expect(r).toMatchObject({
			resolved: true,
			mcpConfigId: null,
			mcpServerId: "key:gitlab-official",
			containerId: "100",
		});
	});

	it("uses GitLab REST when the project never had a per-user MCP config", async () => {
		projectFindUnique.mockResolvedValue(
			project({
				projectManagementMcpServerId: "key:gitlab-official",
				projectManagementMcpConfigId: null,
				projectManagementContainerId: "100",
			}),
		);
		const r = await resolveApplyPmConfig(INPUT);
		expect(r).toMatchObject({ resolved: true, mcpConfigId: null });
		// No per-user MCP to resolve → skip the lookup entirely.
		expect(resolvePMConfigForUser).not.toHaveBeenCalled();
	});

	it("returns user-not-connected for a non-GitLab tool the caller can't resolve", async () => {
		projectFindUnique.mockResolvedValue(project({}));
		resolvePMConfigForUser.mockResolvedValue(null);
		const r = await resolveApplyPmConfig(INPUT);
		expect(r).toEqual({ resolved: false, reason: "user-not-connected" });
	});

	it("treats a disabled resolved config as not connected (non-GitLab)", async () => {
		projectFindUnique.mockResolvedValue(project({}));
		resolvePMConfigForUser.mockResolvedValue({
			id: "cfg-caller",
			enabled: false,
		});
		const r = await resolveApplyPmConfig(INPUT);
		expect(r).toEqual({ resolved: false, reason: "user-not-connected" });
	});
});
