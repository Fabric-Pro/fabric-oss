import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `createSandboxActivity`'s `parseRepoUrl` used to decide "is this GitHub?" by
 * substring-testing the whole URL for `github.com`, which also matches a URL
 * whose real host is somewhere else (`https://example.com/github.com/o/r`).
 * It now defers that decision to `repoForgeFromUrl`, which parses the URL's
 * `hostname` the same way the API-side gate in `start-execution.ts` does.
 */

const createSession = vi.fn();
const cancelSession = vi.fn();

vi.mock("../src/activities/weave/get-background-provider", () => ({
	getBackgroundAgentsProvider: () => ({ createSession, cancelSession }),
}));

vi.mock("@repo/database", () => ({
	db: { weaveExecution: { update: vi.fn() } },
}));
vi.mock("../src/activities/weave/runtime-authorization", () => ({
	authorizeWeaveRuntime: async () => ({
		execution: { id: "example-execution" },
		workflow: { workflowId: "example-workflow" },
	}),
}));

import { createSandboxActivity } from "../src/activities/weave/sandbox";

beforeEach(() => {
	createSession.mockReset();
	createSession.mockResolvedValue({ sessionId: "sess-1" });
});

describe("createSandboxActivity repo URL parsing", () => {
	it("accepts a real https GitHub URL", async () => {
		await createSandboxActivity({
			userId: "user-1",
			organizationId: null,
			repoUrl: "https://github.com/acme/widgets.git",
			branch: "main",
		});

		expect(createSession).toHaveBeenCalledWith(
			expect.objectContaining({ repoOwner: "acme", repoName: "widgets" }),
		);
	});

	it("accepts an scp-style GitHub URL", async () => {
		await createSandboxActivity({
			userId: "user-1",
			organizationId: null,
			repoUrl: "git@github.com:acme/widgets.git",
			branch: "main",
		});

		expect(createSession).toHaveBeenCalledWith(
			expect.objectContaining({ repoOwner: "acme", repoName: "widgets" }),
		);
	});

	it("rejects a lookalike host that only names github.com in the path", async () => {
		await expect(
			createSandboxActivity({
				userId: "user-1",
				organizationId: null,
				repoUrl: "https://example.com/github.com/acme/widgets",
				branch: "main",
			}),
		).rejects.toThrow(/Cannot parse repository URL/);

		expect(createSession).not.toHaveBeenCalled();
	});
});

it("keeps transient native readiness failures retryable through the sandbox activity", async () => {
	vi.stubEnv("FABRIC_AGENTS_EXECUTION_BRIDGE_ENABLED", "true");
	vi.stubEnv("BACKGROUND_AGENTS_URL", "https://example.com");
	vi.stubEnv(
		"BACKGROUND_AGENTS_INTERNAL_SECRET",
		"example-synthetic-service-secret-for-readiness-tests",
	);
	const fetchMock = vi.fn(
		async (_url: Parameters<typeof fetch>[0]) =>
			new Response("Temporary outage", { status: 503 }),
	);
	vi.stubGlobal("fetch", fetchMock);
	try {
		const { FabricBackgroundAdapter } = await import(
			"../src/lib/coding-execution/background-agents-provider"
		);
		const adapter = new FabricBackgroundAdapter();
		createSession.mockImplementation((params) =>
			adapter.createSession(params),
		);
		await expect(
			createSandboxActivity({
				userId: "example-user",
				organizationId: "example-org",
				repoUrl: "https://github.com/example-org/example-repo",
				branch: "main",
				fabricAgentsBridgeEnabled: true,
			}),
		).rejects.toMatchObject({
			type: "CODING_SESSION_NOT_CREATED",
			nonRetryable: false,
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"https://example.com/sessions/readiness",
		);
	} finally {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	}
});
