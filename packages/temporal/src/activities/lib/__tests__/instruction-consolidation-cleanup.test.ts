import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "ghs_exampletoken0123456789";
const SHA = "a".repeat(40);

const warn = vi.hoisted(() => vi.fn());

vi.mock("@repo/logs", () => ({
	logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/database")>()),
	getProjectRepoIntegration: vi.fn(async () => ({
		provider: "GITHUB",
		repositoryUrl: "https://github.com/example-org/example-repo",
		defaultBranch: "main",
		authMethod: "OAUTH",
	})),
}));

vi.mock("@repo/integrations", () => ({
	isGitAuthError: vi.fn(() => false),
	resolveFreshRepoToken: vi.fn(async () => ({
		token: TOKEN,
		authMethod: "OAUTH",
	})),
}));

vi.mock("../instruction-branch-git", () => ({
	initBranchWorkspace: vi.fn(async () => undefined),
}));

vi.mock("../instruction-sync-temp", () => ({
	createSyncRunDir: vi.fn(async () => "/tmp/example-run"),
	removeSyncRunDir: vi.fn(async () => undefined),
}));

vi.mock("../instruction-sync-git", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../instruction-sync-git")>();
	return {
		...actual,
		revParseHead: vi.fn(async () => SHA),
		listTreeRaw: vi.fn(async () => ({
			ok: true,
			entries: [
				{
					path: "CLAUDE.md",
					type: "blob",
					oid: "b".repeat(40),
					mode: "100644",
				},
			],
		})),
		readBaseTree: vi.fn(async () => undefined),
		writeResolvedTree: vi.fn(async () => "c".repeat(40)),
		commitTree: vi.fn(async () => "d".repeat(40)),
		runPush: vi.fn(async () => ({ stdout: Buffer.from(""), error: null })),
		porcelainFlag: vi.fn(() => ({ flag: "*", summary: "[new branch]" })),
	};
});

import {
	ConsolidationStepError,
	runConsolidationCleanup,
} from "../instruction-consolidation-git";

const identity = { name: "Example Dev", email: "dev@example.com" };

function run() {
	return runConsolidationCleanup({
		consolidationId: "consolidation-0001",
		projectId: "project-1",
		userId: "user-1",
		organizationId: "org-1",
		sourceIntegrationId: "integration-1",
		targetRepositoryUrl:
			"https://github.com/example-org/example-instructions",
		files: [{ from: "CLAUDE.md", to: "CLAUDE.md" }],
		author: identity,
		committer: identity,
		date: "2026-01-01T00:00:00Z",
		signal: new AbortController().signal,
	}).catch((e: unknown) => e);
}

/** The lookup finds nothing; `open` answers with `refusal`. */
function stubGithub(refusal: Response) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: string, init: RequestInit = {}) =>
			init.method === "POST"
				? refusal
				: new Response("[]", {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
		),
	);
}

const json = (
	body: unknown,
	status: number,
	headers: Record<string, string> = {},
) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});

beforeEach(() => {
	warn.mockClear();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("runConsolidationCleanup when the pull request is refused", () => {
	it("appends the provider's reason and logs it", async () => {
		stubGithub(
			json(
				{
					message: "Validation Failed",
					errors: [
						{
							resource: "PullRequest",
							field: "base",
							code: "invalid",
						},
					],
				},
				422,
			),
		);
		const error = await run();
		expect(error).toBeInstanceOf(ConsolidationStepError);
		expect(error).toMatchObject({
			code: "PULL_REQUEST_FAILED",
			message:
				"The cleanup branch was pushed, but its pull request could not be opened (GitHub 422: Validation Failed — base: invalid). Open it from the branch in the code repository.",
		});
		expect(warn).toHaveBeenCalledWith(
			"[instruction-consolidation] pull request refused",
			expect.objectContaining({
				status: 422,
				providerMessage: "Validation Failed — base: invalid",
				sourceRef: "fabric/move-ai-instructions-tion0001",
				targetRef: "main",
				repository: {
					provider: "GITHUB",
					owner: "example-org",
					name: "example-repo",
				},
			}),
		);
		expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
	});

	it("names the missing GitHub permission instead of the generic text", async () => {
		stubGithub(
			json({ message: "Resource not accessible by integration" }, 403, {
				"x-accepted-github-permissions": "pull_requests=write",
			}),
		);
		const error = (await run()) as ConsolidationStepError;
		expect(error.code).toBe("PULL_REQUEST_FAILED");
		expect(error.message).toContain(
			"GitHub refused: the credential this repository uses lacks Pull requests (write) permission. Grant it to the Fabric GitHub App or choose a credential that has it.",
		);
		expect(error.message).not.toContain("could not be opened");
	});
});
