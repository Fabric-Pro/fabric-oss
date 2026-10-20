import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	project: vi.fn(),
	pinned: vi.fn(),
	target: vi.fn(),
	access: vi.fn(),
	projectAccess: vi.fn(),
	serverKey: vi.fn(),
	gitlabConnection: vi.fn(),
	pat: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	hasProjectAccess: mocks.projectAccess,
	db: {
		project: { findFirst: mocks.project },
		mCPConfig: { findFirst: mocks.pinned },
	},
}));
vi.mock("@repo/connectors", () => ({
	azureDevOpsOrganization: (args: string[]) => {
		const organization = args[0]?.trim();
		return organization &&
			/^[a-zA-Z0-9][a-zA-Z0-9-]{0,49}$/.test(organization)
			? organization
			: null;
	},
}));
vi.mock("../organization-access", () => ({
	checkMcpConfigOrganizationAccess: mocks.access,
}));
vi.mock("@repo/integrations/pm/pull-image-ingest", () => ({
	resolveAdoPat: mocks.pat,
}));
vi.mock("@repo/integrations/gitlab", () => ({
	resolveProjectPMConfigForUser: mocks.target,
	getProjectPMServerKey: mocks.serverKey,
	findUsableGitLabConnection: mocks.gitlabConnection,
	GitLabPmOriginMismatchError: class extends Error {},
}));

import { GitLabPmOriginMismatchError } from "@repo/integrations/gitlab";
import { resolveProjectPmRead } from "../project-pm-read";

const args = {
	projectId: "project-1",
	userId: "user-1",
	organizationId: "org-1",
};
const project = {
	organizationId: "org-1",
	projectManagementMcpServerId: "server-1",
	projectManagementMcpConfigId: "config-pinned",
	projectManagementAdditionalContext: null,
	projectManagementContainerId: "ado-project",
	projectManagementContainerName: "Example Project",
};
const config = {
	id: "config-own",
	enabled: true,
	userId: "user-1",
	organizationId: "org-1",
	authType: "API_KEY",
	needsReauth: false,
	mcpServer: { key: "azure-devops" },
	commandArgs: ["example-org"],
	encryptedApiKey: "example-encrypted",
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.project.mockResolvedValue({ ...project });
	mocks.pinned.mockResolvedValue({
		commandArgs: ["example-org"],
		mcpServer: { key: "azure-devops" },
	});
	mocks.target.mockResolvedValue({ ...config });
	mocks.access.mockResolvedValue(null);
	mocks.projectAccess.mockResolvedValue(true);
	mocks.serverKey.mockResolvedValue("azure-devops");
	mocks.pat.mockReturnValue("example-pat");
});

describe("caller-owned project PM read resolution", () => {
	it("reloads the tenant-bound project and caller-specific PM target", async () => {
		expect(await resolveProjectPmRead(args)).toMatchObject({
			status: "ready",
			target: { organization: "example-org", projectId: "ado-project" },
		});
		expect(mocks.project).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "project-1",
					organizationId: "org-1",
					deletedAt: null,
				},
			}),
		);
		expect(mocks.target).toHaveBeenCalledWith({
			configId: "config-pinned",
			mcpServerId: "server-1",
			userId: "user-1",
			organizationId: "org-1",
			pmAdditionalContext: null,
		});
		expect(mocks.projectAccess).toHaveBeenCalledWith("project-1", "user-1");
		expect(mocks.access).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
			access: "connect",
		});
		expect(mocks.pinned).toHaveBeenCalledWith({
			where: { id: "config-pinned", organizationId: "org-1" },
			select: { commandArgs: true, mcpServer: { select: { key: true } } },
		});
		expect(mocks.pat).toHaveBeenCalledWith("example-encrypted");
		expect(mocks.project.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.projectAccess.mock.invocationCallOrder[0]!,
		);
		expect(mocks.projectAccess.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.access.mock.invocationCallOrder[0]!,
		);
		expect(mocks.access.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.target.mock.invocationCallOrder[0]!,
		);
		expect(mocks.target.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.pat.mock.invocationCallOrder[0]!,
		);
	});

	it.each([
		null,
		{ commandArgs: ["other-org"], mcpServer: { key: "azure-devops" } },
		{ commandArgs: [], mcpServer: { key: "azure-devops" } },
		{
			commandArgs: ["https://other.example"],
			mcpServer: { key: "azure-devops" },
		},
	])(
		"refuses an unverifiable or different pinned organization: %j",
		async (pinned) => {
			mocks.pinned.mockResolvedValueOnce(pinned);
			expect(await resolveProjectPmRead(args)).toMatchObject({
				status: "not_connected",
			});
			expect(mocks.pat).not.toHaveBeenCalled();
		},
	);

	it("compares Azure DevOps organizations without case sensitivity", async () => {
		mocks.target.mockResolvedValueOnce({
			...config,
			commandArgs: ["EXAMPLE-ORG"],
		});
		expect(await resolveProjectPmRead(args)).toMatchObject({
			status: "ready",
		});
	});

	it("refuses a server-only binding whose original organization is unknown", async () => {
		mocks.project.mockResolvedValueOnce({
			...project,
			projectManagementMcpConfigId: null,
		});
		expect(await resolveProjectPmRead(args)).toMatchObject({
			status: "not_connected",
		});
		expect(mocks.pinned).not.toHaveBeenCalled();
		expect(mocks.target).not.toHaveBeenCalled();
		expect(mocks.pat).not.toHaveBeenCalled();
	});

	it("distinguishes absent PM configuration from a missing own connection", async () => {
		mocks.project.mockResolvedValueOnce({
			...project,
			projectManagementContainerId: null,
		});
		expect(await resolveProjectPmRead(args)).toMatchObject({
			status: "not_configured",
		});
		expect(mocks.target).not.toHaveBeenCalled();
		expect(mocks.pat).not.toHaveBeenCalled();
		mocks.target.mockResolvedValueOnce(null);
		expect(await resolveProjectPmRead(args)).toMatchObject({
			status: "not_connected",
		});
	});

	it("detects a subsequently configured binding without caching absence", async () => {
		mocks.project.mockResolvedValueOnce({
			...project,
			projectManagementMcpConfigId: null,
			projectManagementMcpServerId: null,
		});
		expect(await resolveProjectPmRead(args)).toMatchObject({
			status: "not_configured",
		});
		expect(await resolveProjectPmRead(args)).toMatchObject({
			status: "ready",
		});
		expect(mocks.project).toHaveBeenCalledTimes(2);
	});

	it.each(["Permission denied", "Organization membership required"])(
		"stops an MCP access refusal before resolution or decryption: %s",
		async (message) => {
			mocks.access.mockResolvedValueOnce({ message });
			expect(await resolveProjectPmRead(args)).toEqual({
				status: "forbidden",
				message,
			});
			expect(mocks.pinned).not.toHaveBeenCalled();
			expect(mocks.target).not.toHaveBeenCalled();
			expect(mocks.pat).not.toHaveBeenCalled();
		},
	);

	it("rechecks lost project access before reading configuration or credentials", async () => {
		expect(await resolveProjectPmRead(args)).toMatchObject({
			status: "ready",
		});
		vi.clearAllMocks();
		mocks.projectAccess.mockResolvedValueOnce(false);
		expect(await resolveProjectPmRead(args)).toEqual({
			status: "forbidden",
			message: "You do not have access to this project.",
		});
		expect(mocks.projectAccess).toHaveBeenCalledWith("project-1", "user-1");
		expect(mocks.access).not.toHaveBeenCalled();
		expect(mocks.pinned).not.toHaveBeenCalled();
		expect(mocks.target).not.toHaveBeenCalled();
		expect(mocks.pat).not.toHaveBeenCalled();
	});

	it.each([
		{ userId: "teammate" },
		{ organizationId: "other-org" },
		{ enabled: false },
		{ authType: "OAUTH" },
		{ needsReauth: true },
	])(
		"refuses an unowned or unusable resolved config: %j",
		async (override) => {
			mocks.target.mockResolvedValueOnce({
				...config,
				...override,
			});
			expect(await resolveProjectPmRead(args)).toMatchObject({
				status: "not_connected",
			});
			expect(mocks.pat).not.toHaveBeenCalled();
		},
	);

	it.each(["missing", "another tenant's", "soft-deleted"])(
		"never resolves credentials for a %s project",
		async () => {
			mocks.project.mockResolvedValueOnce(null);
			expect(await resolveProjectPmRead(args)).toEqual({
				status: "not_found",
			});
			expect(mocks.project).toHaveBeenCalledWith(
				expect.objectContaining({
					where: {
						id: args.projectId,
						organizationId: args.organizationId,
						deletedAt: null,
					},
				}),
			);
			expect(mocks.target).not.toHaveBeenCalled();
			expect(mocks.projectAccess).not.toHaveBeenCalled();
			expect(mocks.access).not.toHaveBeenCalled();
			expect(mocks.pat).not.toHaveBeenCalled();
		},
	);

	it("reports other PM providers as unsupported without decrypting", async () => {
		mocks.pinned.mockResolvedValueOnce({
			commandArgs: [],
			mcpServer: { key: "gitlab-official" },
		});
		expect(await resolveProjectPmRead(args)).toMatchObject({
			status: "unsupported",
		});
		expect(mocks.target).not.toHaveBeenCalled();
		expect(mocks.gitlabConnection).not.toHaveBeenCalled();
		expect(mocks.pat).not.toHaveBeenCalled();
	});

	it.each(["gitlab-official", "gitlab", "other-provider"])(
		"reports a server-only %s binding as unsupported without resolving credentials",
		async (key) => {
			mocks.project.mockResolvedValueOnce({
				...project,
				projectManagementMcpConfigId: null,
				projectManagementMcpServerId: `key:${key}`,
			});
			mocks.serverKey.mockResolvedValueOnce(key);
			expect(await resolveProjectPmRead(args)).toMatchObject({
				status: "unsupported",
			});
			expect(mocks.serverKey).toHaveBeenCalledWith(`key:${key}`);
			expect(mocks.pinned).not.toHaveBeenCalled();
			expect(mocks.target).not.toHaveBeenCalled();
			expect(mocks.gitlabConnection).not.toHaveBeenCalled();
			expect(mocks.pat).not.toHaveBeenCalled();
		},
	);

	it("fails closed on a GitLab origin mismatch during caller resolution", async () => {
		mocks.target.mockRejectedValueOnce(new GitLabPmOriginMismatchError());
		expect(await resolveProjectPmRead(args)).toMatchObject({
			status: "not_connected",
		});
		expect(mocks.pat).not.toHaveBeenCalled();
	});

	it("propagates unexpected connection lookup failures without decrypting", async () => {
		const error = new Error("Lookup failed");
		mocks.target.mockRejectedValueOnce(error);
		await expect(resolveProjectPmRead(args)).rejects.toBe(error);
		expect(mocks.pat).not.toHaveBeenCalled();
	});

	it("refuses a resolved non-ADO config without decrypting", async () => {
		mocks.target.mockResolvedValueOnce({
			...config,
			mcpServer: { key: "gitlab-official" },
		});
		expect(await resolveProjectPmRead(args)).toMatchObject({
			status: "unsupported",
		});
		expect(mocks.pat).not.toHaveBeenCalled();
	});

	it.each([
		{ commandArgs: [] },
		{ commandArgs: ["https://other.example"] },
		{ commandArgs: ["other-org"] },
	])(
		"refuses an invalid or different caller organization before decrypting: %j",
		async ({ commandArgs }) => {
			mocks.target.mockResolvedValueOnce({ ...config, commandArgs });
			expect(await resolveProjectPmRead(args)).toMatchObject({
				status: "not_connected",
			});
			expect(mocks.pat).not.toHaveBeenCalled();
		},
	);

	it("requires reconnection when the own credential cannot be decrypted", async () => {
		mocks.pat.mockReturnValueOnce(null);
		expect(await resolveProjectPmRead(args)).toMatchObject({
			status: "not_connected",
		});
	});
});
