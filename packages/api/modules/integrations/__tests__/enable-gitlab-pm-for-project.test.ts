import { beforeEach, describe, expect, it, vi } from "vitest";

const persistGitLabToken = vi
	.fn()
	.mockResolvedValue({ mcpConfigId: "mcp_1", workflowIntegrationId: "wi_1" });
const gitlabFetch = vi.fn();

const projectFindUnique = vi.fn();
const projectUpdate = vi.fn().mockResolvedValue({});
const serverFindUnique = vi.fn();
const serverFindFirst = vi.fn();

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: projectFindUnique, update: projectUpdate },
		mCPServer: { findUnique: serverFindUnique, findFirst: serverFindFirst },
	},
}));
vi.mock("@repo/integrations/gitlab", () => ({ gitlabFetch }));
vi.mock("../lib/gitlab-token", () => ({ persistGitLabToken }));

const baseArgs = {
	userId: "u1",
	organizationId: "org_1" as string | null,
	projectId: "proj_1",
	repositoryOwner: "acme",
	repositoryName: "widgets",
	token: {
		accessToken: "tok",
		refreshToken: "ref",
		expiresAt: null,
		scopes: ["api", "read_user"],
	},
	gitlabUser: { id: 7, username: "u", name: "U", avatarUrl: null },
};

describe("enableGitLabPMForProject", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		persistGitLabToken.mockResolvedValue({
			mcpConfigId: "mcp_1",
			workflowIntegrationId: "wi_1",
		});
		projectUpdate.mockResolvedValue({});
		gitlabFetch.mockResolvedValue({
			id: 123,
			name: "widgets",
			path_with_namespace: "acme/widgets",
		});
		serverFindFirst.mockResolvedValue({ id: "srv_official" });
	});

	it("dual-writes the token and wires the PM pointer to gitlab-official", async () => {
		projectFindUnique.mockResolvedValue({
			projectManagementMcpServerId: null,
		});
		const { enableGitLabPMForProject } = await import(
			"../lib/enable-gitlab-pm-for-project"
		);

		const result = await enableGitLabPMForProject(baseArgs);

		expect(persistGitLabToken).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ pmWired: true, containerId: "123" });
		const data = projectUpdate.mock.calls[0][0].data;
		expect(data.projectManagementMcpServerId).toBe("srv_official");
		// configId left null so the resolver routes MCP vs REST automatically.
		expect(data.projectManagementMcpConfigId).toBeNull();
		expect(data.projectManagementContainerId).toBe("123");
		expect(data.projectManagementContainerName).toBe("acme/widgets");
	});

	it("withholds breaker-reset authority unless the caller declares a fresh grant", async () => {
		// This helper is called from both sides: the project-target OAuth
		// callback holds a token the user just authorized, while the PM
		// backfill script replays one it decrypted out of the database. The
		// default has to be the safe one, or the script silently clears
		// `needsReauth` on credentials nobody re-authorized.
		projectFindUnique.mockResolvedValue({
			projectManagementMcpServerId: null,
		});
		const { enableGitLabPMForProject } = await import(
			"../lib/enable-gitlab-pm-for-project"
		);

		await enableGitLabPMForProject(baseArgs);
		expect(persistGitLabToken.mock.calls[0][1]).toMatchObject({
			freshGrant: false,
		});

		await enableGitLabPMForProject({ ...baseArgs, freshGrant: true });
		expect(persistGitLabToken.mock.calls[1][1]).toMatchObject({
			freshGrant: true,
		});
	});

	it("does not clobber a non-GitLab PM tool, but still dual-writes", async () => {
		projectFindUnique.mockResolvedValue({
			projectManagementMcpServerId: "srv_jira",
		});
		serverFindUnique.mockResolvedValue({ key: "atlassian-jira" });
		const { enableGitLabPMForProject } = await import(
			"../lib/enable-gitlab-pm-for-project"
		);

		const result = await enableGitLabPMForProject(baseArgs);

		expect(persistGitLabToken).toHaveBeenCalledTimes(1);
		expect(projectUpdate).not.toHaveBeenCalled();
		expect(result).toEqual({
			pmWired: false,
			reason: "other-pm-tool-configured",
		});
	});

	it("re-wires when the project already points at GitLab", async () => {
		projectFindUnique.mockResolvedValue({
			projectManagementMcpServerId: "srv_official",
		});
		serverFindUnique.mockResolvedValue({ key: "gitlab-official" });
		const { enableGitLabPMForProject } = await import(
			"../lib/enable-gitlab-pm-for-project"
		);

		const result = await enableGitLabPMForProject(baseArgs);

		expect(result.pmWired).toBe(true);
		expect(projectUpdate).toHaveBeenCalledTimes(1);
	});

	it("persists the key:gitlab-official sentinel when the catalog row is missing", async () => {
		projectFindUnique.mockResolvedValue({
			projectManagementMcpServerId: null,
		});
		serverFindFirst.mockResolvedValue(null);
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		try {
			const { enableGitLabPMForProject } = await import(
				"../lib/enable-gitlab-pm-for-project"
			);

			const result = await enableGitLabPMForProject(baseArgs);

			expect(result).toEqual({ pmWired: true, containerId: "123" });
			expect(projectUpdate).toHaveBeenCalledTimes(1);
			const data = projectUpdate.mock.calls[0][0].data;
			expect(data.projectManagementMcpServerId).toBe(
				"key:gitlab-official",
			);
			expect(data.projectManagementMcpConfigId).toBeNull();
			expect(data.projectManagementContainerId).toBe("123");
			expect(data.projectManagementContainerName).toBe("acme/widgets");
			// Loud log so the misconfigured env is observable — mirrors #1205 style.
			expect(errorSpy).toHaveBeenCalled();
			const logged = errorSpy.mock.calls
				.map((c) => String(c[0]))
				.join("\n");
			expect(logged).toMatch(/gitlab-official.*missing/i);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("falls back to the repo path container when numeric id is unavailable", async () => {
		projectFindUnique.mockResolvedValue({
			projectManagementMcpServerId: null,
		});
		gitlabFetch.mockResolvedValue({ name: "widgets" }); // no id
		const { enableGitLabPMForProject } = await import(
			"../lib/enable-gitlab-pm-for-project"
		);

		const result = await enableGitLabPMForProject(baseArgs);

		// Container must never be left null (that hides the Pull button), so we
		// wire the path container instead of bailing.
		expect(result).toEqual({ pmWired: true, containerId: "acme/widgets" });
		const data = projectUpdate.mock.calls[0][0].data;
		expect(data.projectManagementContainerId).toBe("acme/widgets");
	});

	it("falls back to the path container when project lookup throws (expired token)", async () => {
		projectFindUnique.mockResolvedValue({
			projectManagementMcpServerId: null,
		});
		gitlabFetch.mockRejectedValue(new Error("401 Token is expired"));
		const { enableGitLabPMForProject } = await import(
			"../lib/enable-gitlab-pm-for-project"
		);

		const result = await enableGitLabPMForProject(baseArgs);

		expect(result).toEqual({ pmWired: true, containerId: "acme/widgets" });
		const data = projectUpdate.mock.calls[0][0].data;
		expect(data.projectManagementContainerId).toBe("acme/widgets");
		expect(data.projectManagementContainerName).toBe("acme/widgets");
	});
});
