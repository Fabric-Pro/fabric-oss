import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		loadDirectRepositorySource: vi.fn(),
		assertDirectRepositorySourceCurrent: vi.fn(),
		resolveInstructionProject: vi.fn(),
		scopes: ["repositories:read"] as string[],
	},
}));

vi.mock("@repo/connectors", () => ({
	parseAdoRepositoryUrl: vi.fn(() => ({
		organization: "example-org",
		project: "example-project",
		host: "https://dev.azure.com",
	})),
}));

vi.mock("../instruction-project-gate", () => ({
	resolveInstructionProject: mocks.resolveInstructionProject,
}));

vi.mock(
	"../../projects/procedures/instructions/repository/direct-source",
	() => ({
		loadDirectRepositorySource: mocks.loadDirectRepositorySource,
		assertDirectRepositorySourceCurrent:
			mocks.assertDirectRepositorySourceCurrent,
	}),
);

vi.mock("../../external-api/middleware/api-key-auth", () => ({
	requireScope:
		(scope: string) =>
		async (
			c: { json: (body: unknown, status: number) => Response },
			next: () => Promise<void>,
		) => {
			if (!mocks.scopes.includes(scope)) {
				return c.json(
					{ error: `Missing required scope: ${scope}` },
					403,
				);
			}
			return next();
		},
}));

const { registerInstructionGitRoutes } = await import(
	"../instruction-git-routes"
);

const PROJECT = "project-example";
const BASE = `/projects/${PROJECT}/instructions/repository/git/7`;

function source(overrides: Record<string, unknown> = {}) {
	return {
		organizationId: "org-example",
		integrationId: "integration-example",
		generation: 7,
		ref: "main",
		rootPath: "",
		ignoreGlobs: [],
		refreshFault: null,
		repository: {
			provider: "GITHUB",
			token: "provider-token",
			repositoryUrl: "https://github.com/example-org/example-repository",
			owner: "example-org",
			repo: "example-repository",
		},
		...overrides,
	};
}

function app() {
	const result = new Hono();
	result.use("*", async (c, next) => {
		c.set("externalApiContext", {
			keyType: "oauth",
			userId: "user-example",
			scopes: mocks.scopes,
		});
		await next();
	});
	registerInstructionGitRoutes(result);
	return result;
}

beforeEach(() => {
	mocks.scopes = ["repositories:read"];
	mocks.resolveInstructionProject.mockResolvedValue({
		userId: "user-example",
		organizationId: "org-example",
	});
	mocks.loadDirectRepositorySource.mockResolvedValue(source());
	mocks.assertDirectRepositorySourceCurrent.mockResolvedValue(undefined);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe("repository Git transport", () => {
	it("refuses another service before resolving credentials or contacting a provider", async () => {
		const upstream = vi.fn();
		vi.stubGlobal("fetch", upstream);

		const response = await app().request(
			`${BASE}/info/refs?service=git-receive-pack`,
		);

		expect(response.status).toBe(400);
		expect(mocks.loadDirectRepositorySource).not.toHaveBeenCalled();
		expect(upstream).not.toHaveBeenCalled();
	});

	it("requires the explicit repository scope before loading a repository credential", async () => {
		mocks.scopes = ["instructions:read"];
		const upstream = vi.fn();
		vi.stubGlobal("fetch", upstream);

		const response = await app().request(
			`${BASE}/info/refs?service=git-upload-pack`,
		);

		expect(response.status).toBe(403);
		expect(mocks.loadDirectRepositorySource).not.toHaveBeenCalled();
		expect(upstream).not.toHaveBeenCalled();
	});

	it("uses the stored repository credential, forwards protocol v2, and fences the source before release", async () => {
		const upstream = vi.fn(
			async (input: URL | RequestInfo, init?: RequestInit) => {
				expect(String(input)).toBe(
					"https://github.com/example-org/example-repository.git/info/refs?service=git-upload-pack",
				);
				expect(new Headers(init?.headers).get("authorization")).toBe(
					`Basic ${Buffer.from("x-access-token:provider-token").toString("base64")}`,
				);
				expect(new Headers(init?.headers).get("git-protocol")).toBe(
					"version=2",
				);
				expect(init?.redirect).toBe("error");
				return new Response("001e# service=git-upload-pack\n0000", {
					headers: {
						"content-type":
							"application/x-git-upload-pack-advertisement",
					},
				});
			},
		);
		vi.stubGlobal("fetch", upstream);

		const response = await app().request(
			new Request(
				`http://localhost${BASE}/info/refs?service=git-upload-pack`,
				{ headers: { "git-protocol": "version=2" } },
			),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain(
			"application/x-git-upload-pack-advertisement",
		);
		expect(await response.text()).toContain("git-upload-pack");
		expect(mocks.assertDirectRepositorySourceCurrent).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: PROJECT,
				userId: "user-example",
			}),
		);
	});

	it("releases a transfer slot when the pre-response authority fence fails", async () => {
		const upstream = vi.fn(
			async () =>
				new Response("001e# service=git-upload-pack\n0000", {
					headers: {
						"content-type":
							"application/x-git-upload-pack-advertisement",
					},
				}),
		);
		vi.stubGlobal("fetch", upstream);

		for (let attempt = 0; attempt < 4; attempt += 1) {
			mocks.resolveInstructionProject.mockReset();
			mocks.resolveInstructionProject
				.mockResolvedValueOnce({
					userId: "user-example",
					organizationId: "org-example",
				})
				.mockRejectedValueOnce(new Error("authority lookup failed"));
			const response = await app().request(
				`${BASE}/info/refs?service=git-upload-pack`,
			);
			expect(response.status).toBe(503);
		}

		mocks.resolveInstructionProject.mockResolvedValue({
			userId: "user-example",
			organizationId: "org-example",
		});
		const response = await app().request(
			`${BASE}/info/refs?service=git-upload-pack`,
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toContain("git-upload-pack");
		expect(upstream).toHaveBeenCalledTimes(5);
	});
});
