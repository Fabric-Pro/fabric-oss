/**
 * The `checkout` argument and check of `fabric_instruction_checks` (Fizzy
 * #2878): a hookless editor's agent reports the git checkout it runs in, and
 * the report says whether it is the commit the project published.
 *
 * What is pinned: the facts are validated in the handler (the gateway does not
 * enforce `inputSchema`) with the literals the CLI's git module uses, and no
 * refusal echoes the value it refused, because a remote URL may carry a
 * credential; the verdicts are what a published commit and the last sync
 * run's tip can establish, labelled `caller-reported`; and no remedy grants
 * the caller authority to touch the checkout.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/api/modules/v1/instruction-direct-repository", () => ({
	getDirectRepositoryState: vi
		.fn()
		.mockResolvedValue({ availability: "UPLOAD", readState: "DIRECT" }),
}));

const m = vi.hoisted(() => ({
	getProjectAccessContext: vi.fn(),
	resolveEffectiveProjectPermissions: vi.fn(),
	getPublishedInstructionSnapshot: vi.fn(),
	getInstructionFileByPath: vi.fn(),
	getProjectInstructionSettings: vi.fn(),
	resolveInstructionSnapshotSource: vi.fn(),
	resolveCurrentInstructionRepository: vi.fn(),
	downloadFile: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	hasPermission: (permissions: readonly string[], permission: string) =>
		permissions.includes(permission),
	Permissions: { INSTRUCTION_READ: "instruction:read" },
	isProjectSoftDeleted: vi.fn().mockResolvedValue(false),
	getProjectAccessContext: m.getProjectAccessContext,
	getPublishedInstructionSnapshot: m.getPublishedInstructionSnapshot,
	getInstructionFileByPath: m.getInstructionFileByPath,
	getProjectInstructionSettings: m.getProjectInstructionSettings,
	resolveInstructionSnapshotSource: m.resolveInstructionSnapshotSource,
	resolveCurrentInstructionRepository: m.resolveCurrentInstructionRepository,
}));

vi.mock("@repo/api/lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: (...a: unknown[]) =>
		m.resolveEffectiveProjectPermissions(...a),
}));

vi.mock("@repo/storage", () => ({
	getStorageProvider: () => ({ downloadFile: m.downloadFile }),
}));

vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { skills: "skills" } } },
}));

import type {
	InstructionCheck,
	InstructionChecksReport,
} from "../instruction-checks";
import { executePlatformTool } from "../platform-tools";
import type { GatewaySession } from "../types";

const TOOL = "fabric_instruction_checks";
const PROJECT = "proj_1";
const PUBLISHED = "a".repeat(40);
const TIP = "b".repeat(40);
const OLDER = "c".repeat(40);
const REMOTE = "https://github.com/example-org/example-repo.git";

const session: GatewaySession = {
	sessionId: "sess-1",
	userId: "user-1",
	organizationId: "org_1",
	userName: "Example Agent",
	email: "agent@example.com",
	role: "user",
	credential: "organization-key",
	scopes: ["instructions:read"],
	createdAt: new Date("2026-01-01T00:00:00Z"),
	expiresAt: new Date("2026-01-02T00:00:00Z"),
};

function text(result: { content: Array<{ text: string }> }): string {
	return result.content[0]?.text ?? "";
}

function reportOf(result: {
	content: Array<{ text: string }>;
	isError?: boolean;
}): InstructionChecksReport {
	expect(result.isError).toBeUndefined();
	return JSON.parse(text(result)) as InstructionChecksReport;
}

function checkoutCheck(report: InstructionChecksReport): InstructionCheck {
	const found = report.checks.find((c) => c.id === "checkout");
	if (!found) {
		throw new Error("no checkout check");
	}
	return found;
}

function repositoryConfig(
	sync: Record<string, unknown> = {},
	overrides: Record<string, unknown> = {},
) {
	return {
		provider: "GITHUB",
		host: "github.com",
		path: "example-org/example-repo",
		ref: "main",
		rootPath: "",
		generation: 2,
		cloneUrl: "https://github.com/example-org/example-repo",
		sync: { automatic: true, pausedReason: null, lastRun: null, ...sync },
		...overrides,
	};
}

function lastRun(overrides: Record<string, unknown> = {}) {
	return {
		trigger: "WEBHOOK",
		status: "SUCCEEDED",
		error: null,
		commitSha: PUBLISHED,
		finishedAt: "2026-10-02T09:30:00.000Z",
		...overrides,
	};
}

/** A repository-backed project whose published version came from `commitSha`. */
function repositoryProject(
	options: {
		sync?: Record<string, unknown>;
		repository?: Record<string, unknown>;
		source?: Record<string, unknown>;
	} = {},
) {
	m.resolveInstructionSnapshotSource.mockResolvedValue({
		sourceOfTruth: "REPOSITORY",
		source: {
			kind: "REPOSITORY",
			ref: "main",
			commitSha: PUBLISHED,
			current: true,
			...options.source,
		},
		repository: repositoryConfig(options.sync, options.repository),
	});
}

function checkout(overrides: Record<string, unknown> = {}) {
	return {
		remoteUrl: REMOTE,
		headSha: PUBLISHED,
		branch: "main",
		clean: true,
		...overrides,
	};
}

function run(checkoutFacts: unknown) {
	return executePlatformTool(
		TOOL,
		{ projectId: PROJECT, checkout: checkoutFacts },
		session,
	);
}

beforeEach(() => {
	for (const fn of Object.values(m)) {
		fn.mockReset();
	}
	m.resolveEffectiveProjectPermissions.mockResolvedValue({
		permissions: ["instruction:read"],
		source: "project-member",
		organizationId: "org_1",
	});
	m.getProjectAccessContext.mockResolvedValue({ organizationId: "org_1" });
	m.getPublishedInstructionSnapshot.mockResolvedValue({
		id: "snap_1",
		version: 4,
		status: "READY",
		digest: "d".repeat(64),
		fileCount: 3,
		projectId: PROJECT,
		organizationId: "org_1",
	});
	m.getInstructionFileByPath.mockResolvedValue(null);
	m.resolveCurrentInstructionRepository.mockResolvedValue(null);
	repositoryProject();
});

describe("the checkout argument", () => {
	it("is advertised with the literals the CLI uses", async () => {
		const { PLATFORM_TOOL_DEFINITIONS } = await import("../platform-tools");
		const def = PLATFORM_TOOL_DEFINITIONS.find((t) => t.name === TOOL);
		const schema = (
			def?.inputSchema.properties as Record<
				string,
				{
					required: string[];
					properties: Record<string, Record<string, unknown>>;
				}
			>
		).checkout;

		expect(schema.required).toEqual(["remoteUrl", "headSha", "clean"]);
		const description = (schema as unknown as { description: string })
			.description;
		expect(description).toContain("git diff --quiet");
		expect(description).toContain("git diff --cached --quiet");
		expect(description).toContain(
			"Do NOT derive clean from `git status --porcelain`",
		);
		expect(schema.properties.remoteUrl?.maxLength).toBe(512);
		expect(schema.properties.branch?.maxLength).toBe(255);
		expect(schema.properties.headSha?.pattern).toBe(
			"^(?:[0-9a-f]{40}|[0-9a-f]{64})$",
		);
		expect(schema.properties.branch?.pattern).toBe(
			"^[A-Za-z0-9][A-Za-z0-9._/-]*$",
		);
		expect(def?.description).toMatch(
			/grant no authority.*pull, reset or overwrite/,
		);
	});

	it.each([
		["a non-object", "main", "checkout must be an object"],
		["null", null, "checkout must be an object"],
		["an array", [], "checkout must be an object"],
		[
			"a missing remoteUrl",
			checkout({ remoteUrl: undefined }),
			"checkout.remoteUrl",
		],
		[
			"an empty remoteUrl",
			checkout({ remoteUrl: "" }),
			"checkout.remoteUrl",
		],
		[
			"a remoteUrl over 512 characters",
			checkout({ remoteUrl: `https://github.com/${"o".repeat(512)}` }),
			"checkout.remoteUrl",
		],
		[
			"a headSha that is not hexadecimal",
			checkout({ headSha: "z".repeat(40) }),
			"checkout.headSha",
		],
		[
			"an uppercase headSha",
			checkout({ headSha: "A".repeat(40) }),
			"checkout.headSha",
		],
		[
			"a short headSha",
			checkout({ headSha: "abc1234" }),
			"checkout.headSha",
		],
		[
			"a 41-character headSha",
			checkout({ headSha: "a".repeat(41) }),
			"checkout.headSha",
		],
		[
			"a revision expression for a branch",
			checkout({ branch: "@{-1}" }),
			"checkout.branch",
		],
		[
			"a branch over 255 characters",
			checkout({ branch: `b${"r".repeat(255)}` }),
			"checkout.branch",
		],
		[
			"a clean that is not a boolean",
			checkout({ clean: "yes" }),
			"checkout.clean",
		],
		["a missing clean", checkout({ clean: undefined }), "checkout.clean"],
	])("refuses %s before any lookup", async (_label, facts, field) => {
		const r = await run(facts);

		expect(r.isError).toBe(true);
		expect(JSON.parse(text(r)).error).toContain(field);
		expect(m.getProjectAccessContext).not.toHaveBeenCalled();
	});

	it("refuses an invalid headSha without echoing it", async () => {
		const bad = `${"A".repeat(10)}-not-a-sha-marker`;

		const r = await run(checkout({ headSha: bad }));

		expect(r.isError).toBe(true);
		expect(text(r)).not.toContain(bad);
		expect(text(r)).not.toContain("not-a-sha-marker");
	});

	it("refuses an invalid branch and remote without echoing them", async () => {
		const badBranch = await run(checkout({ branch: "bad branch marker" }));
		const badRemote = await run(checkout({ remoteUrl: 7, branch: "ok" }));

		expect(badBranch.isError).toBe(true);
		expect(text(badBranch)).not.toContain("bad branch marker");
		expect(badRemote.isError).toBe(true);
	});

	it("accepts a SHA-256 object name and a detached HEAD with no branch", async () => {
		const sha256Head = "e".repeat(64);

		const r = await run(
			checkout({ headSha: sha256Head, branch: undefined }),
		);

		expect(r.isError).toBeUndefined();
	});
});

describe("the checkout check", () => {
	it("passes a clean checkout at the published commit, as caller-reported", async () => {
		const report = reportOf(await run(checkout()));

		expect(checkoutCheck(report)).toMatchObject({
			title: "Checkout",
			status: "pass",
			evidence: "caller-reported",
		});
		expect(checkoutCheck(report).detail).toContain(
			"published commit aaaaaaa",
		);
		expect(checkoutCheck(report).detail).not.toMatch(/verified/i);
		expect(checkoutCheck(report).fix).toBeUndefined();
	});

	it("warns, with a remedy for the developer, when the tree is dirty at the published commit", async () => {
		const c = checkoutCheck(
			reportOf(await run(checkout({ clean: false }))),
		);

		expect(c.status).toBe("warn");
		expect(c.detail).toContain("uncommitted changes");
		expect(c.fix?.description).toMatch(/developer's decision/);
	});

	it("says the checkout is behind or diverged, and defers the ancestry answer to the session hook rather than to a command someone with only the npx line cannot run", async () => {
		const c = checkoutCheck(
			reportOf(await run(checkout({ headSha: OLDER }))),
		);

		expect(c.status).toBe("warn");
		expect(c.detail).toMatch(/behind it or has diverged from it/);
		expect(c.fix?.description).toContain(
			"the session hook settles which at each session start (to check now, run the setup line from the project's Connect dialog again)",
		);
		expect(c.fix?.description).not.toContain("fabric instructions check");
	});

	it("passes a checkout ahead of the published commit when the caller reports the ancestry", async () => {
		const c = checkoutCheck(
			reportOf(
				await run(
					checkout({ headSha: OLDER, containsPublished: true }),
				),
			),
		);

		expect(c.status).toBe("pass");
		expect(c.detail).toMatch(/ahead of the published commit aaaaaaa/);
		expect(c.fix).toBeUndefined();
	});

	it("says the history does not contain the published commit when the caller reports that, without deferring to the CLI", async () => {
		const c = checkoutCheck(
			reportOf(
				await run(
					checkout({ headSha: OLDER, containsPublished: false }),
				),
			),
		);

		expect(c.status).toBe("warn");
		expect(c.detail).toMatch(/its history does not contain it/);
		expect(c.fix?.description).not.toContain("the session hook");
	});

	it("refuses a containsPublished that is not a boolean", async () => {
		const r = await run(checkout({ containsPublished: "yes" }));

		expect(r.isError).toBe(true);
		expect(JSON.stringify(r)).toContain("checkout.containsPublished");
		expect(JSON.stringify(r)).not.toContain('"yes"');
	});

	it("mentions uncommitted changes when a behind checkout is also dirty", async () => {
		const c = checkoutCheck(
			reportOf(await run(checkout({ headSha: OLDER, clean: false }))),
		);

		expect(c.status).toBe("warn");
		expect(c.detail).toContain("uncommitted changes");
		expect(c.fix?.description).toContain("commit or stash");
	});

	it("says Fabric's copy lags when the checkout is at the tip the last sync refused", async () => {
		repositoryProject({
			sync: {
				lastRun: lastRun({
					status: "REJECTED",
					error: "TREE_REFUSED",
					commitSha: TIP,
				}),
			},
		});

		const c = checkoutCheck(
			reportOf(await run(checkout({ headSha: TIP }))),
		);

		expect(c.status).toBe("warn");
		expect(c.detail).toContain("ahead of Fabric's published copy");
		expect(c.detail).toContain("refused by the secret scan");
		expect(c.fix?.description).toContain("This checkout needs no change");
	});

	it.each([
		[
			"a sync in progress",
			{ lastRun: lastRun({ status: null, commitSha: TIP }) },
			"a sync is in progress",
		],
		[
			"a failed sync",
			{ lastRun: lastRun({ status: "FAILED", commitSha: TIP }) },
			"the last sync failed",
		],
		[
			"paused automatic sync",
			{
				pausedReason: "REF_MISSING",
				lastRun: lastRun({ commitSha: TIP }),
			},
			"automatic sync is paused",
		],
		[
			"automatic sync off",
			{ automatic: false, lastRun: lastRun({ commitSha: TIP }) },
			"automatic sync is off",
		],
		[
			"a sync that has not run yet",
			{ lastRun: lastRun({ commitSha: TIP }) },
			"the next sync has not run yet",
		],
	])("names %s as why Fabric's copy lags", async (_label, sync, reason) => {
		repositoryProject({ sync });

		const c = checkoutCheck(
			reportOf(await run(checkout({ headSha: TIP }))),
		);

		expect(c.detail).toContain(reason);
	});

	it("says Fabric lags when the sync now follows another branch than the published copy came from", async () => {
		repositoryProject({ source: { current: false } });

		const c = checkoutCheck(reportOf(await run(checkout())));

		expect(c.status).toBe("warn");
		expect(c.detail).toContain("from another branch or repository");
	});

	it("skips, rather than calling it behind, a checkout on another branch", async () => {
		const c = checkoutCheck(
			reportOf(
				await run(
					checkout({ headSha: OLDER, branch: "feature/example" }),
				),
			),
		);

		expect(c.status).toBe("skip");
		expect(c.detail).toContain("on feature/example, not main");
	});

	it("skips a detached HEAD that is not the published commit", async () => {
		const c = checkoutCheck(
			reportOf(
				await run(checkout({ headSha: OLDER, branch: undefined })),
			),
		);

		expect(c.status).toBe("skip");
		expect(c.detail).toContain("detached HEAD");
	});

	it("is current on another branch whose HEAD is the published commit", async () => {
		const c = checkoutCheck(
			reportOf(await run(checkout({ branch: "feature/example" }))),
		);

		expect(c.status).toBe("pass");
	});

	it("skips a foreign checkout and names the two repositories, never the remote as given", async () => {
		const withUserinfo = [
			"https://x-access-token:",
			"secret",
			"@github.com/other-org/other-repo.git",
		].join("");

		const r = await run(checkout({ remoteUrl: withUserinfo }));

		const c = checkoutCheck(reportOf(r));
		expect(c.status).toBe("skip");
		expect(c.detail).toBe(
			"this checkout's remote is github.com/other-org/other-repo, not github.com/example-org/example-repo; nothing was compared",
		);
		expect(text(r)).not.toContain("secret");
		expect(text(r)).not.toContain("x-access-token");
	});

	it("skips a remote that is not a repository URL at all", async () => {
		const c = checkoutCheck(
			reportOf(await run(checkout({ remoteUrl: "file:///srv/example" }))),
		);

		expect(c.status).toBe("skip");
		expect(c.detail).toContain("not a repository URL");
	});

	it.each([
		["https", "https://github.com/Example-Org/Example-Repo"],
		["ssh", "ssh://git@github.com/example-org/example-repo.git"],
		["scp-like", "git@github.com:example-org/example-repo.git"],
	])(
		"recognises the %s spelling of the project's repository",
		async (_label, remoteUrl) => {
			const c = checkoutCheck(
				reportOf(await run(checkout({ remoteUrl }))),
			);

			expect(c.status).toBe("pass");
		},
	);

	it.each([
		[
			"https",
			"https://dev.azure.com/example-org/example-project/_git/example-repo",
		],
		[
			"https with userinfo",
			"https://example-org@dev.azure.com/example-org/example-project/_git/example-repo",
		],
		[
			"visualstudio.com",
			"https://example-org.visualstudio.com/example-project/_git/example-repo",
		],
		[
			"ssh.dev.azure.com",
			"git@ssh.dev.azure.com:v3/example-org/example-project/example-repo",
		],
		[
			"vs-ssh.visualstudio.com",
			"example-org@vs-ssh.visualstudio.com:v3/example-org/example-project/example-repo",
		],
	])("recognises the Azure DevOps %s spelling", async (_label, remoteUrl) => {
		repositoryProject({
			repository: {
				provider: "AZURE_DEVOPS",
				host: "dev.azure.com",
				path: "example-org/example-project/_git/example-repo",
			},
		});

		const c = checkoutCheck(reportOf(await run(checkout({ remoteUrl }))));

		expect(c.status).toBe("pass");
	});

	it("skips with how to pass the facts when none are given", async () => {
		const report = reportOf(
			await executePlatformTool(TOOL, { projectId: PROJECT }, session),
		);

		expect(checkoutCheck(report)).toMatchObject({
			status: "skip",
			evidence: "server",
		});
		expect(checkoutCheck(report).detail).toContain("pass checkout");
	});

	it("skips for a project that keeps uploads, whatever is reported", async () => {
		m.resolveInstructionSnapshotSource.mockResolvedValue({
			sourceOfTruth: "UPLOAD",
			source: { kind: "UPLOAD" },
			repository: null,
		});

		const c = checkoutCheck(reportOf(await run(checkout())));

		expect(c.status).toBe("skip");
		expect(c.detail).toContain("not a repository-sourced project");
	});

	it("skips when the published version was not synced from the repository", async () => {
		m.resolveInstructionSnapshotSource.mockResolvedValue({
			sourceOfTruth: "REPOSITORY",
			source: { kind: "UPLOAD" },
			repository: repositoryConfig(),
		});

		const c = checkoutCheck(reportOf(await run(checkout())));

		expect(c.status).toBe("skip");
		expect(c.detail).toContain("no commit to compare with");
	});

	it("skips when nothing is published", async () => {
		m.getPublishedInstructionSnapshot.mockResolvedValue(null);

		const c = checkoutCheck(reportOf(await run(checkout())));

		expect(c.status).toBe("skip");
		expect(c.detail).toBe("nothing published to compare against");
	});

	it("skips when the project is not reachable with this credential", async () => {
		m.getProjectAccessContext.mockResolvedValue(null);

		const c = checkoutCheck(reportOf(await run(checkout())));

		expect(c.status).toBe("skip");
	});

	it("never offers a remedy that entitles the caller to change the checkout", async () => {
		const fixes = [
			checkout({ clean: false }),
			checkout({ headSha: OLDER }),
			checkout({ headSha: OLDER, clean: false }),
		];

		for (const facts of fixes) {
			const c = checkoutCheck(reportOf(await run(facts)));
			expect(c.fix?.command).toBeUndefined();
			expect(c.fix?.description).not.toMatch(
				/\bgit (pull|reset|checkout|stash|rebase)\b/,
			);
		}
	});
});
