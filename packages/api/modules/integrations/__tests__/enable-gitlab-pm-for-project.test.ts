/**
 * `enableGitLabPMForProject` wires a project's PM pointer to the GitLab
 * project of a repository it just connected — but only through the CALLER's
 * own GitLab connection. The repository link's token is a separate team
 * grant: it is never used for this and never written into anyone's personal
 * connection (no WorkflowIntegration or MCPConfig write here at all).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const gitlabFetch = vi.fn();
const getGitLabConnectionToken = vi.fn();

const projectFindUnique = vi.fn();
const projectUpdate = vi.fn().mockResolvedValue({});
const serverFindUnique = vi.fn();
const serverFindFirst = vi.fn();

// Any write to a credential store fails the test: only `project.update`
// (the PM pointer) is allowed.
const forbiddenWrite = (store: string) => () => {
	throw new Error(`enableGitLabPMForProject must not write ${store}`);
};
vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: projectFindUnique, update: projectUpdate },
		mCPServer: { findUnique: serverFindUnique, findFirst: serverFindFirst },
		workflowIntegration: {
			create: forbiddenWrite("WorkflowIntegration"),
			update: forbiddenWrite("WorkflowIntegration"),
			updateMany: forbiddenWrite("WorkflowIntegration"),
			upsert: forbiddenWrite("WorkflowIntegration"),
		},
		mCPConfig: {
			create: forbiddenWrite("MCPConfig"),
			update: forbiddenWrite("MCPConfig"),
			updateMany: forbiddenWrite("MCPConfig"),
			upsert: forbiddenWrite("MCPConfig"),
		},
	},
}));
vi.mock("@repo/integrations/gitlab", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@repo/integrations/gitlab")>();
	return {
		GITLAB_DEFAULT_ORIGIN: actual.GITLAB_DEFAULT_ORIGIN,
		GitLabApiError: actual.GitLabApiError,
		gitlabApiBaseForOrigin: actual.gitlabApiBaseForOrigin,
		parseGitLabOrigin: actual.parseGitLabOrigin,
		recordedGitLabPmOrigin: actual.recordedGitLabPmOrigin,
		withGitLabPmOrigin: actual.withGitLabPmOrigin,
		gitlabFetch,
		getGitLabConnectionToken,
	};
});

const baseArgs = {
	userId: "u1",
	organizationId: "org_1" as string | null,
	projectId: "proj_1",
	repositoryOwner: "acme",
	repositoryName: "widgets",
	repositoryUrl: "https://gitlab.com/acme/widgets" as string | null,
};

const personalToken = {
	ok: true,
	accessToken: "personal-token",
	issuer: {
		kind: "app",
		clientId: "app-client",
		origin: "https://gitlab.com",
	},
	origin: "https://gitlab.com",
	integrationId: "wi_1",
	generation: 1,
	settings: {},
};

describe("enableGitLabPMForProject", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		getGitLabConnectionToken.mockResolvedValue(personalToken);
		projectUpdate.mockResolvedValue({});
		gitlabFetch.mockResolvedValue({
			id: 123,
			name: "widgets",
			path_with_namespace: "acme/widgets",
		});
		serverFindFirst.mockResolvedValue({ id: "srv_official" });
	});

	it("validates with the caller's own connection and wires the PM pointer to gitlab-official", async () => {
		projectFindUnique.mockResolvedValue({
			projectManagementMcpServerId: null,
		});
		const { enableGitLabPMForProject } = await import(
			"../lib/enable-gitlab-pm-for-project"
		);

		const result = await enableGitLabPMForProject(baseArgs);

		expect(getGitLabConnectionToken).toHaveBeenCalledWith(
			{ userId: "u1", organizationId: "org_1" },
			{ mode: "strict", anyOrigin: true },
		);
		expect(gitlabFetch).toHaveBeenCalledWith(
			{ token: "personal-token", apiBase: "https://gitlab.com/api/v4" },
			"/projects/acme%2Fwidgets",
		);
		expect(result).toEqual({ pmWired: true, containerId: "123" });
		const data = projectUpdate.mock.calls[0][0].data;
		expect(data.projectManagementMcpServerId).toBe("srv_official");
		// configId left null so the resolver routes MCP vs REST automatically.
		expect(data.projectManagementMcpConfigId).toBeNull();
		expect(data.projectManagementContainerId).toBe("123");
		expect(data.projectManagementContainerName).toBe("acme/widgets");
	});

	it("asks the caller to connect their personal GitLab when they have none — the repository link's token is never borrowed", async () => {
		projectFindUnique.mockResolvedValue({
			projectManagementMcpServerId: null,
		});
		getGitLabConnectionToken.mockResolvedValue({
			ok: false,
			reason: "not-connected",
			message: "GitLab is not connected",
		});
		const { enableGitLabPMForProject } = await import(
			"../lib/enable-gitlab-pm-for-project"
		);

		const result = await enableGitLabPMForProject(baseArgs);

		expect(result).toEqual({
			pmWired: false,
			reason: "personal-connection-required",
		});
		expect(gitlabFetch).not.toHaveBeenCalled();
		expect(projectUpdate).not.toHaveBeenCalled();
	});

	it("asks for a reconnect when the caller's connection needs one", async () => {
		projectFindUnique.mockResolvedValue({
			projectManagementMcpServerId: null,
		});
		getGitLabConnectionToken.mockResolvedValue({
			ok: false,
			reason: "needs-reauth",
			message: "the GitLab connection needs to be reconnected",
		});
		const { enableGitLabPMForProject } = await import(
			"../lib/enable-gitlab-pm-for-project"
		);

		expect(await enableGitLabPMForProject(baseArgs)).toEqual({
			pmWired: false,
			reason: "personal-connection-required",
		});
		expect(projectUpdate).not.toHaveBeenCalled();
	});

	it("validates a self-hosted connection against its own instance", async () => {
		getGitLabConnectionToken.mockResolvedValue({
			...personalToken,
			issuer: {
				...personalToken.issuer,
				origin: "https://gitlab.example.com",
			},
			origin: "https://gitlab.example.com",
		});
		projectFindUnique.mockResolvedValue({
			projectManagementMcpServerId: null,
		});
		const { enableGitLabPMForProject } = await import(
			"../lib/enable-gitlab-pm-for-project"
		);

		await enableGitLabPMForProject({
			...baseArgs,
			repositoryUrl: "https://gitlab.example.com/acme/widgets",
		});

		expect(gitlabFetch).toHaveBeenCalledWith(
			{
				token: "personal-token",
				apiBase: "https://gitlab.example.com/api/v4",
			},
			"/projects/acme%2Fwidgets",
		);
		// The container is recorded with the instance it lives on.
		expect(
			projectUpdate.mock.calls[0][0].data
				.projectManagementAdditionalContext,
		).toEqual({ gitlabOrigin: "https://gitlab.example.com" });
	});

	it("never wires a repository on another instance than the caller's connection", async () => {
		getGitLabConnectionToken.mockResolvedValue({
			...personalToken,
			issuer: {
				...personalToken.issuer,
				origin: "https://gitlab.example.com",
			},
			origin: "https://gitlab.example.com",
		});
		projectFindUnique.mockResolvedValue({
			projectManagementMcpServerId: null,
		});
		const { enableGitLabPMForProject } = await import(
			"../lib/enable-gitlab-pm-for-project"
		);

		// A gitlab.com repository: acme/widgets on the connection's own
		// instance would be an unrelated project.
		const result = await enableGitLabPMForProject(baseArgs);

		expect(result).toEqual({ pmWired: false, reason: "instance-mismatch" });
		expect(gitlabFetch).not.toHaveBeenCalled();
		expect(projectUpdate).not.toHaveBeenCalled();
	});

	it("reads a repository recorded without a URL as gitlab.com", async () => {
		getGitLabConnectionToken.mockResolvedValue({
			...personalToken,
			origin: "https://gitlab.example.com",
		});
		projectFindUnique.mockResolvedValue({
			projectManagementMcpServerId: null,
		});
		const { enableGitLabPMForProject } = await import(
			"../lib/enable-gitlab-pm-for-project"
		);

		const result = await enableGitLabPMForProject({
			...baseArgs,
			repositoryUrl: null,
		});

		expect(result).toEqual({ pmWired: false, reason: "instance-mismatch" });
		expect(gitlabFetch).not.toHaveBeenCalled();
	});

	it("keeps the other PM context keys and records the gitlab.com origin", async () => {
		projectFindUnique.mockResolvedValue({
			projectManagementMcpServerId: null,
			projectManagementAdditionalContext: {
				labelStatusMap: "{}",
				gitlabOrigin: "https://stale.example.com",
			},
		});
		const { enableGitLabPMForProject } = await import(
			"../lib/enable-gitlab-pm-for-project"
		);

		await enableGitLabPMForProject(baseArgs);

		expect(
			projectUpdate.mock.calls[0][0].data
				.projectManagementAdditionalContext,
		).toEqual({ labelStatusMap: "{}", gitlabOrigin: "https://gitlab.com" });
	});

	it("does not wire a GitLab project the caller's own connection cannot see", async () => {
		projectFindUnique.mockResolvedValue({
			projectManagementMcpServerId: null,
		});
		const { GitLabApiError } = await import("@repo/integrations/gitlab");
		gitlabFetch.mockRejectedValue(new GitLabApiError(404, "404 Not Found"));
		const { enableGitLabPMForProject } = await import(
			"../lib/enable-gitlab-pm-for-project"
		);

		expect(await enableGitLabPMForProject(baseArgs)).toEqual({
			pmWired: false,
			reason: "project-not-accessible",
		});
		expect(projectUpdate).not.toHaveBeenCalled();
	});

	it("treats GitLab refusing the caller's token as a reconnect prompt", async () => {
		projectFindUnique.mockResolvedValue({
			projectManagementMcpServerId: null,
		});
		const { GitLabApiError } = await import("@repo/integrations/gitlab");
		gitlabFetch.mockRejectedValue(
			new GitLabApiError(401, "401 Unauthorized"),
		);
		const { enableGitLabPMForProject } = await import(
			"../lib/enable-gitlab-pm-for-project"
		);

		expect(await enableGitLabPMForProject(baseArgs)).toEqual({
			pmWired: false,
			reason: "personal-connection-required",
		});
		expect(projectUpdate).not.toHaveBeenCalled();
	});

	it("does not clobber a non-GitLab PM tool, and never consults the caller's connection for it", async () => {
		projectFindUnique.mockResolvedValue({
			projectManagementMcpServerId: "srv_jira",
		});
		serverFindUnique.mockResolvedValue({ key: "atlassian-jira" });
		const { enableGitLabPMForProject } = await import(
			"../lib/enable-gitlab-pm-for-project"
		);

		const result = await enableGitLabPMForProject(baseArgs);

		expect(getGitLabConnectionToken).not.toHaveBeenCalled();
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

	it("reads the stored server, config and container", async () => {
		projectFindUnique.mockResolvedValue({
			projectManagementMcpServerId: null,
			projectManagementMcpConfigId: null,
			projectManagementContainerId: null,
		});
		const { enableGitLabPMForProject } = await import(
			"../lib/enable-gitlab-pm-for-project"
		);

		await enableGitLabPMForProject(baseArgs);

		expect(projectFindUnique).toHaveBeenCalledWith({
			where: { id: "proj_1" },
			select: {
				projectManagementMcpServerId: true,
				projectManagementMcpConfigId: true,
				projectManagementContainerId: true,
				projectManagementAdditionalContext: true,
			},
		});
	});

	it("switches PM status sync off when it re-points the container (Fizzy #2304)", async () => {
		// Stored by the REST picker as a path; the OAuth auto-wire resolves
		// the numeric id, so this is a different container string.
		projectFindUnique.mockResolvedValue({
			projectManagementMcpServerId: "srv_official",
			projectManagementMcpConfigId: null,
			projectManagementContainerId: "acme/old-widgets",
		});
		serverFindUnique.mockResolvedValue({ key: "gitlab-official" });
		const { enableGitLabPMForProject } = await import(
			"../lib/enable-gitlab-pm-for-project"
		);

		await enableGitLabPMForProject(baseArgs);

		expect(projectUpdate).toHaveBeenCalledTimes(1);
		expect(projectUpdate.mock.calls[0][0]).toEqual({
			where: { id: "proj_1" },
			data: {
				projectManagementMcpServerId: "srv_official",
				projectManagementMcpConfigId: null,
				projectManagementContainerId: "123",
				projectManagementContainerName: "acme/widgets",
				projectManagementAdditionalContext: {
					gitlabOrigin: "https://gitlab.com",
				},
				pmStatusSyncEnabled: false,
			},
		});
	});

	it("switches PM status sync off when it drops a pinned GitLab MCP config", async () => {
		projectFindUnique.mockResolvedValue({
			projectManagementMcpServerId: "srv_official",
			projectManagementMcpConfigId: "cfg_gitlab_mcp",
			projectManagementContainerId: "123",
		});
		serverFindUnique.mockResolvedValue({ key: "gitlab-official" });
		const { enableGitLabPMForProject } = await import(
			"../lib/enable-gitlab-pm-for-project"
		);

		await enableGitLabPMForProject(baseArgs);

		expect(projectUpdate.mock.calls[0][0].data).toEqual({
			projectManagementMcpServerId: "srv_official",
			projectManagementMcpConfigId: null,
			projectManagementContainerId: "123",
			projectManagementContainerName: "acme/widgets",
			projectManagementAdditionalContext: {
				gitlabOrigin: "https://gitlab.com",
			},
			pmStatusSyncEnabled: false,
		});
	});

	it("leaves PM status sync alone when it re-wires the same REST source", async () => {
		projectFindUnique.mockResolvedValue({
			projectManagementMcpServerId: "srv_official",
			projectManagementMcpConfigId: null,
			projectManagementContainerId: "123",
		});
		serverFindUnique.mockResolvedValue({ key: "gitlab-official" });
		const { enableGitLabPMForProject } = await import(
			"../lib/enable-gitlab-pm-for-project"
		);

		await enableGitLabPMForProject(baseArgs);

		expect(projectUpdate.mock.calls[0][0].data).toEqual({
			projectManagementMcpServerId: "srv_official",
			projectManagementMcpConfigId: null,
			projectManagementContainerId: "123",
			projectManagementContainerName: "acme/widgets",
			projectManagementAdditionalContext: {
				gitlabOrigin: "https://gitlab.com",
			},
		});
	});

	it("switches PM status sync off when the same container id was recorded on another instance", async () => {
		projectFindUnique.mockResolvedValue({
			projectManagementMcpServerId: "srv_official",
			projectManagementMcpConfigId: null,
			projectManagementContainerId: "123",
			projectManagementAdditionalContext: {
				gitlabOrigin: "https://gitlab.example.com",
			},
		});
		serverFindUnique.mockResolvedValue({ key: "gitlab-official" });
		const { enableGitLabPMForProject } = await import(
			"../lib/enable-gitlab-pm-for-project"
		);

		await enableGitLabPMForProject(baseArgs);

		expect(projectUpdate.mock.calls[0][0].data).toMatchObject({
			projectManagementAdditionalContext: {
				gitlabOrigin: "https://gitlab.com",
			},
			pmStatusSyncEnabled: false,
		});
	});

	it("changes nothing when GitLab could not be asked (fails closed, never wires an unvalidated project)", async () => {
		projectFindUnique.mockResolvedValue({
			projectManagementMcpServerId: null,
		});
		gitlabFetch.mockRejectedValue(new TypeError("fetch failed"));
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		const { enableGitLabPMForProject } = await import(
			"../lib/enable-gitlab-pm-for-project"
		);

		const result = await enableGitLabPMForProject(baseArgs);

		expect(result).toEqual({ pmWired: false, reason: "validation-failed" });
		expect(projectUpdate).not.toHaveBeenCalled();
		errorSpy.mockRestore();
	});
});
