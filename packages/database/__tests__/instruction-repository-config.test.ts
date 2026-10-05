/**
 * What the published response says about the repository behind a project's
 * coding instructions (Fizzy #2878): how the repository is named, the
 * credential-free URL to clone it from, and the state of its sync.
 *
 * `resolveCurrentInstructionSource` and `resolveInstructionSnapshotSource`
 * are the two readers that build that block, so each case runs through both
 * wherever the answer must agree.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	project: { findFirst: vi.fn() },
	repositorySync: { findFirst: vi.fn() },
	repositorySyncRun: { findFirst: vi.fn() },
}));

vi.mock("../prisma/client", () => ({
	db: {
		project: mocks.project,
		projectInstructionRepositorySync: mocks.repositorySync,
		projectInstructionRepositorySyncRun: mocks.repositorySyncRun,
	},
	Prisma: {},
}));

vi.mock("../prisma/queries/audit-log", () => ({ recordAuditTx: vi.fn() }));

import {
	repositoryIdentity,
	resolveCurrentInstructionSource,
	resolveInstructionSnapshotSource,
} from "../prisma/queries/instructions";

type Provider = "GITHUB" | "GITLAB" | "AZURE_DEVOPS";

function syncRowOf(
	integration: Partial<{
		provider: Provider;
		repositoryUrl: string;
		repositoryOwner: string;
		repositoryName: string;
	}> = {},
	overrides: Record<string, unknown> = {},
) {
	return {
		id: "sync_1",
		projectId: "p",
		organizationId: "org_1",
		repositoryIntegrationId: "int_1",
		ref: "main",
		rootPath: "",
		automatic: true,
		generation: 3,
		automaticPausedReason: null,
		automaticPausedAt: null,
		allowReaderProposals: false,
		user: { id: "u1", name: "Example Developer" },
		repositoryIntegration: {
			id: "int_1",
			provider: "GITHUB",
			repositoryUrl: "https://github.com/example-org/example-repo",
			repositoryOwner: "example-org",
			repositoryName: "example-repo",
			defaultBranch: "main",
			status: "ACTIVE",
			...integration,
		},
		...overrides,
	};
}

function runOf(overrides: Record<string, unknown> = {}) {
	return {
		trigger: "WEBHOOK",
		status: "SUCCEEDED",
		error: null,
		commitSha: "a".repeat(40),
		finishedAt: new Date("2026-10-02T09:30:00.000Z"),
		...overrides,
	};
}

const REPOSITORY_SNAPSHOT = {
	source: "REPOSITORY" as const,
	repositoryIntegrationId: "int_1",
	sourceRef: "main",
	sourceCommitSha: "a".repeat(40),
};

function repositoryBacked(sync: ReturnType<typeof syncRowOf>) {
	mocks.project.findFirst.mockResolvedValue({
		instructionSettings: { sourceOfTruth: "REPOSITORY" },
	});
	mocks.repositorySync.findFirst.mockResolvedValue(sync);
}

beforeEach(() => {
	for (const group of Object.values(mocks)) {
		group.findFirst.mockReset();
	}
});

describe("repositoryIdentity", () => {
	const github = {
		provider: "GITHUB" as const,
		repositoryOwner: "example-org",
		repositoryName: "example-repo",
	};

	it("clones from the canonical credential-free URL, never the stored spelling", () => {
		const withUserinfo = new URL(
			"https://github.com/example-org/example-repo.git",
		);
		withUserinfo.username = "x-access-token";
		withUserinfo.password = "secret";

		const identity = repositoryIdentity({
			...github,
			repositoryUrl: withUserinfo.toString(),
		});

		expect(identity?.cloneUrl).toBe(
			"https://github.com/example-org/example-repo",
		);
		expect(JSON.stringify(identity)).not.toContain("secret");
		expect(JSON.stringify(identity)).not.toContain("x-access-token");
	});

	it("names a GitLab repository by its subgroup path", () => {
		expect(
			repositoryIdentity({
				provider: "GITLAB",
				repositoryUrl:
					"https://gitlab.com/example-group/sub-group/example-repo.git",
				repositoryOwner: "example-group/sub-group",
				repositoryName: "example-repo",
			}),
		).toEqual({
			host: "gitlab.com",
			path: "example-group/sub-group/example-repo",
			cloneUrl: "https://gitlab.com/example-group/sub-group/example-repo",
		});
	});

	it.each([
		[
			"dev.azure.com with a project",
			"https://dev.azure.com/example-org/Example%20Project/_git/example-repo",
			"example-org/Example%20Project/_git/example-repo",
		],
		[
			"dev.azure.com with the userinfo its Clone button adds",
			"https://example-org@dev.azure.com/example-org/example-project/_git/example-repo",
			"example-org/example-project/_git/example-repo",
		],
		[
			"a visualstudio.com host",
			"https://example-org.visualstudio.com/example-project/_git/example-repo",
			"example-org/example-project/_git/example-repo",
		],
		[
			"a URL that names no project",
			"https://dev.azure.com/example-org/_git/example-repo",
			"example-org/_git/example-repo",
		],
	])(
		"names an Azure DevOps repository by its URL path under dev.azure.com: %s",
		(_label, repositoryUrl, expectedPath) => {
			const identity = repositoryIdentity({
				provider: "AZURE_DEVOPS",
				repositoryUrl,
				// The columns drop the project, which is why they are not the path.
				repositoryOwner: "example-org",
				repositoryName: "example-repo",
			});

			expect(identity?.host).toBe("dev.azure.com");
			expect(identity?.path).toBe(expectedPath);
		},
	);

	it("keeps the stored visualstudio.com URL as the clone URL", () => {
		const identity = repositoryIdentity({
			provider: "AZURE_DEVOPS",
			repositoryUrl:
				"https://example-org.visualstudio.com/example-project/_git/example-repo",
			repositoryOwner: "example-org",
			repositoryName: "example-repo",
		});

		expect(identity?.cloneUrl).toBe(
			"https://example-org.visualstudio.com/example-project/_git/example-repo",
		);
	});

	it("canonicalises a legacy scp-style stored value into an HTTPS clone URL", () => {
		const identity = repositoryIdentity({
			...github,
			repositoryUrl: "git@github.com:example-org/example-repo.git",
		});

		expect(identity).toEqual({
			host: "github.com",
			path: "example-org/example-repo",
			cloneUrl: "https://github.com/example-org/example-repo",
		});
	});

	it("has no clone URL for a stored host outside the supported providers", () => {
		const identity = repositoryIdentity({
			...github,
			repositoryUrl:
				"https://git.example.com/example-org/example-repo.git",
		});

		expect(identity).toEqual({
			host: "git.example.com",
			path: "example-org/example-repo",
			cloneUrl: null,
		});
	});

	it("is null when the stored value has no host to name", () => {
		expect(
			repositoryIdentity({
				...github,
				repositoryUrl: "not a url at all",
			}),
		).toBeNull();
	});
});

describe("the repository block of a published response", () => {
	it("carries the clone URL and an Azure DevOps path with _git, through both readers", async () => {
		repositoryBacked(
			syncRowOf({
				provider: "AZURE_DEVOPS",
				repositoryUrl:
					"https://example-org.visualstudio.com/example-project/_git/example-repo",
			}),
		);

		const current = await resolveCurrentInstructionSource("p", "org_1");
		const snapshot = await resolveInstructionSnapshotSource(
			"p",
			"org_1",
			REPOSITORY_SNAPSHOT,
		);

		for (const repository of [current.repository, snapshot.repository]) {
			expect(repository).toMatchObject({
				provider: "AZURE_DEVOPS",
				host: "dev.azure.com",
				path: "example-org/example-project/_git/example-repo",
				cloneUrl:
					"https://example-org.visualstudio.com/example-project/_git/example-repo",
			});
		}
	});

	it("reports the sync's automatic flag and why it is paused", async () => {
		repositoryBacked(
			syncRowOf(
				{},
				{
					automatic: false,
					automaticPausedReason: "PERMISSION_REVOKED",
				},
			),
		);

		const { repository } = await resolveCurrentInstructionSource(
			"p",
			"org_1",
		);

		expect(repository?.sync).toEqual({
			automatic: false,
			pausedReason: "PERMISSION_REVOKED",
			lastRun: null,
		});
	});

	it("reports the newest run of this configuration with a refusal's closed error code", async () => {
		repositoryBacked(syncRowOf());
		mocks.repositorySyncRun.findFirst.mockResolvedValue(
			runOf({
				trigger: "POLL",
				status: "REJECTED",
				error: "TREE_REFUSED",
				commitSha: "b".repeat(40),
			}),
		);

		const { repository } = await resolveInstructionSnapshotSource(
			"p",
			"org_1",
			REPOSITORY_SNAPSHOT,
		);

		expect(repository?.sync.lastRun).toEqual({
			trigger: "POLL",
			status: "REJECTED",
			error: "TREE_REFUSED",
			commitSha: "b".repeat(40),
			finishedAt: "2026-10-02T09:30:00.000Z",
		});
		expect(
			mocks.repositorySyncRun.findFirst,
		).toHaveBeenCalledExactlyOnceWith({
			where: {
				syncId: "sync_1",
				projectId: "p",
				organizationId: "org_1",
			},
			orderBy: { startedAt: "desc" },
			select: expect.any(Object),
		});
	});

	it("reports a run that is still open as no status and no finish time", async () => {
		repositoryBacked(syncRowOf());
		mocks.repositorySyncRun.findFirst.mockResolvedValue(
			runOf({ status: null, commitSha: null, finishedAt: null }),
		);

		const { repository } = await resolveCurrentInstructionSource(
			"p",
			"org_1",
		);

		expect(repository?.sync.lastRun).toMatchObject({
			status: null,
			commitSha: null,
			finishedAt: null,
		});
	});

	it("reads the run only for a repository-backed project with a readable URL", async () => {
		mocks.project.findFirst.mockResolvedValue({
			instructionSettings: { sourceOfTruth: "UPLOAD" },
		});
		await resolveCurrentInstructionSource("p", "org_1");
		await resolveInstructionSnapshotSource("p", "org_1", {
			source: "UPLOAD",
			repositoryIntegrationId: null,
			sourceRef: null,
			sourceCommitSha: null,
		});

		repositoryBacked(syncRowOf({ repositoryUrl: "not a url at all" }));
		await resolveCurrentInstructionSource("p", "org_1");

		expect(mocks.repositorySyncRun.findFirst).not.toHaveBeenCalled();
	});
});
