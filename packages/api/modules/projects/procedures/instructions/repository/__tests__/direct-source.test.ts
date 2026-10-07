import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	getOrganizationMembership: vi.fn(),
	hasProjectAccess: vi.fn(),
	getTenantContext: vi.fn(),
	getProjectInstructionSettings: vi.fn(),
	getInstructionRepositorySync: vi.fn(),
	getProjectRepoIntegration: vi.fn(),
	resolveFreshRepoTokenForRow: vi.fn(),
	requireHostingOrganizationId: vi.fn(),
	assertProjectPermission: vi.fn(),
	resolveRepositoryBranchHead: vi.fn(),
	isCommitOnBranch: vi.fn(),
	readRepositoryFileAtCommit: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getOrganizationMembership: m.getOrganizationMembership,
	getTenantContext: m.getTenantContext,
	getProjectInstructionSettings: m.getProjectInstructionSettings,
	getInstructionRepositorySync: m.getInstructionRepositorySync,
	getProjectRepoIntegration: m.getProjectRepoIntegration,
	hasProjectAccess: m.hasProjectAccess,
}));
vi.mock("@repo/connectors", () => ({
	resolveRepositoryBranchHead: m.resolveRepositoryBranchHead,
	isCommitOnBranch: m.isCommitOnBranch,
	readRepositoryFileAtCommit: m.readRepositoryFileAtCommit,
}));
vi.mock("@repo/integrations/repo-auth", () => ({
	resolveFreshRepoTokenForRow: m.resolveFreshRepoTokenForRow,
}));
vi.mock("../../hosting-organization", () => ({
	requireHostingOrganizationId: m.requireHostingOrganizationId,
}));
vi.mock("../../../../../../orpc/procedures", () => ({
	assertProjectPermission: m.assertProjectPermission,
	Permissions: { INSTRUCTION_READ: "instruction:read" },
}));

import { resetDirectRepositoryCaches } from "../direct-cache";
import {
	assertDirectRepositoryPin,
	assertDirectRepositorySourceCurrent,
	directRelativeRepositoryPath,
	loadDirectRepositorySource,
	resolveDirectRepositoryHead,
	resolveDirectRepositoryIgnore,
} from "../direct-source";
import { resolveDirectRepositoryState } from "../direct-state";

const SHA = "a".repeat(40);
const TOKEN = "token-for-direct-source-test";

const integration = {
	id: "integration-1",
	projectId: "project-1",
	status: "ACTIVE",
	provider: "AZURE_DEVOPS",
	authMethod: "PAT",
	encryptedAccessToken: null,
	encryptedRefreshToken: null,
	encryptedPat: "ciphertext",
	tokenExpiresAt: null,
	updatedAt: new Date("2026-01-01T00:00:00.000Z"),
	repositoryUrl:
		"https://dev.azure.com/example-org/example/_git/instructions",
	repositoryOwner: "example-org",
	repositoryName: "instructions",
	azureOrganization: "example-org",
};

const sync = {
	repositoryIntegrationId: integration.id,
	generation: 7,
	ref: "main",
	rootPath: "guidance",
};

beforeEach(() => {
	resetDirectRepositoryCaches();
	m.requireHostingOrganizationId.mockResolvedValue("org-1");
	m.hasProjectAccess.mockResolvedValue(true);
	m.assertProjectPermission.mockResolvedValue({ organizationId: "org-1" });
	m.getProjectInstructionSettings.mockResolvedValue({
		sourceOfTruth: "REPOSITORY",
		ignoreGlobs: ["private/**"],
		migration: null,
	});
	m.getInstructionRepositorySync.mockResolvedValue(sync);
	m.getProjectRepoIntegration.mockResolvedValue(integration);
	m.resolveFreshRepoTokenForRow.mockResolvedValue({
		token: TOKEN,
		refreshFault: null,
		credentialFault: null,
	});
	m.resolveRepositoryBranchHead.mockResolvedValue({
		ok: true,
		commitSha: SHA,
	});
	m.isCommitOnBranch.mockResolvedValue({ ok: true, onBranch: true });
	m.readRepositoryFileAtCommit.mockResolvedValue({
		ok: true,
		state: "absent",
	});
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("direct repository source", () => {
	it("reports a repository without a connection as disconnected", async () => {
		m.getInstructionRepositorySync.mockResolvedValue(null);
		await expect(
			resolveDirectRepositoryState({
				projectId: "project-1",
				userId: "user-1",
			}),
		).resolves.toEqual({
			availability: "DISCONNECTED",
			readState: "DIRECT",
		});
		expect(m.resolveRepositoryBranchHead).not.toHaveBeenCalled();
	});

	it("reports an expired repository sign-in as credentials-expired, not disconnected", async () => {
		m.getProjectRepoIntegration.mockResolvedValue({
			...integration,
			status: "TOKEN_EXPIRED",
		});
		await expect(
			resolveDirectRepositoryState({
				projectId: "project-1",
				userId: "user-1",
			}),
		).resolves.toEqual({
			availability: "CREDENTIALS_EXPIRED",
			readState: "DIRECT",
		});
		expect(m.resolveFreshRepoTokenForRow).not.toHaveBeenCalled();
	});

	it("keeps an integration in another non-active state disconnected", async () => {
		m.getProjectRepoIntegration.mockResolvedValue({
			...integration,
			status: "DISCONNECTED",
		});
		await expect(
			resolveDirectRepositoryState({
				projectId: "project-1",
				userId: "user-1",
			}),
		).resolves.toEqual({
			availability: "DISCONNECTED",
			readState: "DIRECT",
		});
	});

	it("carries caller cancellation to the provider and refuses cancelled admission", async () => {
		const controller = new AbortController();
		const input = {
			projectId: "project-1",
			userId: "user-1",
			signal: controller.signal,
		};
		const source = await loadDirectRepositorySource(input);
		await resolveDirectRepositoryHead(source);
		expect(m.resolveRepositoryBranchHead).toHaveBeenCalledWith(
			expect.objectContaining({ signal: controller.signal }),
		);
		m.resolveRepositoryBranchHead.mockClear();
		controller.abort();
		await expect(loadDirectRepositorySource(input)).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(m.resolveRepositoryBranchHead).not.toHaveBeenCalled();
	});

	it("loads only the current project connection and resolves one branch-head pin", async () => {
		const source = await loadDirectRepositorySource({
			projectId: "project-1",
			userId: "user-1",
		});
		const pin = await resolveDirectRepositoryHead(source);

		expect(pin).toEqual({ generation: 7, commitSha: SHA });
		expect(m.getProjectRepoIntegration).toHaveBeenCalledWith(
			integration.id,
			"project-1",
		);
		expect(m.resolveRepositoryBranchHead).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "AZURE_DEVOPS",
				repositoryUrl: integration.repositoryUrl,
				token: TOKEN,
				branch: "main",
			}),
		);
	});

	it("refuses a mutable provider branch result as a pin", async () => {
		m.resolveRepositoryBranchHead.mockResolvedValueOnce({
			ok: true,
			commitSha: "release/next",
		});
		const source = await loadDirectRepositorySource({
			projectId: "project-1",
			userId: "user-1",
		});

		await expect(resolveDirectRepositoryHead(source)).rejects.toMatchObject(
			{
				data: { code: "REPOSITORY_UNREACHABLE" },
			},
		);
	});

	it("refuses a stale configuration generation before fetching a file", async () => {
		const source = await loadDirectRepositorySource({
			projectId: "project-1",
			userId: "user-1",
		});

		await expect(
			assertDirectRepositoryPin(source, {
				generation: 6,
				commitSha: SHA,
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: { code: "REPOSITORY_CONFIGURATION_CHANGED" },
		});
		expect(m.isCommitOnBranch).not.toHaveBeenCalled();
	});

	it("accepts a historical pin only after the configured branch membership check", async () => {
		const source = await loadDirectRepositorySource({
			projectId: "project-1",
			userId: "user-1",
		});

		await assertDirectRepositoryPin(source, {
			generation: 7,
			commitSha: SHA,
		});

		expect(m.isCommitOnBranch).toHaveBeenCalledWith(
			expect.objectContaining({ branch: "main", sha: SHA }),
		);
	});

	it("refuses a source replacement that happens during provider work", async () => {
		const source = await loadDirectRepositorySource({
			projectId: "project-1",
			userId: "user-1",
		});
		m.getInstructionRepositorySync.mockResolvedValueOnce({
			...sync,
			generation: 8,
		});

		await expect(
			assertDirectRepositorySourceCurrent({
				projectId: "project-1",
				userId: "user-1",
				source,
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: { code: "REPOSITORY_CONFIGURATION_CHANGED" },
		});
		expect(m.assertProjectPermission).toHaveBeenCalledWith(
			"project-1",
			"user-1",
			"instruction:read",
		);
	});

	it("rechecks strict project visibility after provider work", async () => {
		const source = await loadDirectRepositorySource({
			projectId: "project-1",
			userId: "user-1",
		});
		m.hasProjectAccess.mockResolvedValueOnce(false);
		m.assertProjectPermission.mockClear();

		await expect(
			assertDirectRepositorySourceCurrent({
				projectId: "project-1",
				userId: "user-1",
				source,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.assertProjectPermission).not.toHaveBeenCalled();
	});

	it("does not turn revoked project access after a provider failure into availability", async () => {
		m.resolveRepositoryBranchHead.mockImplementationOnce(async () => {
			m.hasProjectAccess.mockResolvedValue(false);
			throw new Error("provider unavailable");
		});

		await expect(
			resolveDirectRepositoryState({
				projectId: "project-1",
				userId: "user-1",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("returns provider availability only after a fresh authorization fence", async () => {
		m.resolveRepositoryBranchHead.mockRejectedValueOnce(
			new Error("provider unavailable"),
		);

		await expect(
			resolveDirectRepositoryState({
				projectId: "project-1",
				userId: "user-1",
			}),
		).resolves.toEqual({
			availability: "UNAVAILABLE",
			readState: "DIRECT",
		});
		expect(m.hasProjectAccess).toHaveBeenCalledWith("project-1", "user-1");
	});

	it("checks revocation while credential loading fails before a source is returned", async () => {
		m.resolveFreshRepoTokenForRow.mockImplementationOnce(async () => {
			m.hasProjectAccess.mockResolvedValue(false);
			throw new Error("Credential refresh failed");
		});
		await expect(
			resolveDirectRepositoryState({
				projectId: "project-1",
				userId: "user-1",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.resolveRepositoryBranchHead).not.toHaveBeenCalled();
	});

	it("refuses changed ignore rules even when the generation did not move", async () => {
		const source = await loadDirectRepositorySource({
			projectId: "project-1",
			userId: "user-1",
		});
		m.getProjectInstructionSettings.mockResolvedValueOnce({
			sourceOfTruth: "REPOSITORY",
			ignoreGlobs: ["private/**", "local/**"],
			migration: null,
		});

		await expect(
			assertDirectRepositorySourceCurrent({
				projectId: "project-1",
				userId: "user-1",
				source,
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: { code: "REPOSITORY_CONFIGURATION_CHANGED" },
		});
	});

	it("keeps uploaded and migrating projects out of the direct provider path", async () => {
		m.getProjectInstructionSettings.mockResolvedValueOnce({
			sourceOfTruth: "UPLOAD",
			ignoreGlobs: null,
			migration: null,
		});
		await expect(
			loadDirectRepositorySource({
				projectId: "project-1",
				userId: "user-1",
			}),
		).rejects.toMatchObject({ data: { code: "NOT_REPOSITORY_SOURCED" } });
		expect(m.getProjectRepoIntegration).not.toHaveBeenCalled();

		m.getProjectInstructionSettings.mockResolvedValueOnce({
			sourceOfTruth: "REPOSITORY",
			ignoreGlobs: null,
			migration: { version: 3 },
		});
		await expect(
			loadDirectRepositorySource({
				projectId: "project-1",
				userId: "user-1",
			}),
		).rejects.toMatchObject({
			data: { code: "INSTRUCTION_MIGRATION_IN_PROGRESS" },
		});
		expect(m.getProjectRepoIntegration).not.toHaveBeenCalled();
	});

	it("reads root .fabricignore as pinned bytes and never transforms it through a checkout", async () => {
		m.readRepositoryFileAtCommit.mockResolvedValueOnce({
			ok: true,
			state: "found",
			bytes: Buffer.from("ignored/**\n", "utf8"),
		});
		const source = await loadDirectRepositorySource({
			projectId: "project-1",
			userId: "user-1",
		});

		const ignore = await resolveDirectRepositoryIgnore(source, {
			generation: 7,
			commitSha: SHA,
		});

		expect(ignore).toEqual({
			globs: ["ignored/**"],
			layer: "fabricignore",
		});
		expect(m.readRepositoryFileAtCommit).toHaveBeenCalledWith(
			expect.objectContaining({
				sha: SHA,
				path: "guidance/.fabricignore",
			}),
		);
	});

	it("keeps a configured root boundary in provider tree paths", () => {
		expect(
			directRelativeRepositoryPath(
				{ rootPath: "guidance" },
				"guidance/AGENTS.md",
			),
		).toBe("AGENTS.md");
		expect(
			directRelativeRepositoryPath(
				{ rootPath: "guidance" },
				"other/AGENTS.md",
			),
		).toBeNull();
	});
});
