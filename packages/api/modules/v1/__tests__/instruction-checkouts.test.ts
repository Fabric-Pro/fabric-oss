/**
 * `POST /instructions/checkouts/resolve` (Fizzy #2878): the CLI sends the
 * canonical spellings of a checkout's fetch remote and learns which
 * repository-sourced coding-instructions projects they belong to.
 *
 * What is pinned is the AUTHORIZATION shape and the absence of an oracle. An
 * empty `matches` is the one answer for "nothing is connected", "another
 * tenant's project", "you cannot read it" and "it keeps uploads", so a caller
 * cannot learn from it which repositories other organizations connected.
 * Everything that reaches a lookup is first canonicalised by the real
 * `parseRepoUrl`, so what the database is asked for is what it stores.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		findAllByRepoUrl: vi.fn(),
		listInstructionSyncsByIntegrationIds: vi.fn(),
		getProjectInstructionSettings: vi.fn(),
		hasProjectAccess: vi.fn(),
		resolveEffectiveProjectPermissions: vi.fn(),
		findOrganization: vi.fn(),
		scopes: ["instructions:read"] as string[],
	},
}));

vi.mock("@repo/database", async (importOriginal) => {
	// `parseRepoUrl` and `repositoryIdentity` are real: the canonical form the
	// lookup is exact against, and the identity the response names, are the
	// behaviour under test.
	const actual = await importOriginal<typeof import("@repo/database")>();
	return {
		...actual,
		db: { organization: { findFirst: mocks.findOrganization } },
		findAllByRepoUrl: mocks.findAllByRepoUrl,
		listInstructionSyncsByIntegrationIds:
			mocks.listInstructionSyncsByIntegrationIds,
		getProjectInstructionSettings: mocks.getProjectInstructionSettings,
		hasProjectAccess: mocks.hasProjectAccess,
	};
});

vi.mock("../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions:
		mocks.resolveEffectiveProjectPermissions,
}));

/** A faithful stand-in: the scope refusal is flat `{ error: string }`, as the real one. */
vi.mock("../../external-api/middleware/api-key-auth", () => ({
	requireScope:
		(scope: string) =>
		async (
			c: { json: (body: unknown, status: number) => unknown },
			next: () => Promise<unknown>,
		) => {
			if (!mocks.scopes.includes(scope) && !mocks.scopes.includes("*")) {
				return c.json(
					{ error: `Missing required scope: ${scope}` },
					403,
				);
			}
			return next();
		},
}));

const { registerInstructionCheckoutRoutes } = await import(
	"../instruction-checkouts"
);

const ORG = "org-1";
const OTHER_ORG = "org-2";
const RESOLVE_PATH = "/instructions/checkouts/resolve";
const REPOSITORY_URL = "https://github.com/example-org/example-repo";

let apiContext: {
	keyType: "personal" | "organization" | "oauth";
	userId: string;
	organizationId?: string;
	boundProjectId?: string;
	scopes: string[];
};

function organizationKey(organizationId: string, userId = "user-1") {
	return {
		keyType: "organization" as const,
		userId,
		organizationId,
		scopes: ["instructions:read"],
	};
}

function personalKey(userId = "user-1") {
	return {
		keyType: "personal" as const,
		userId,
		organizationId: undefined,
		scopes: ["instructions:read"],
	};
}

function buildApp() {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("externalApiContext", apiContext);
		await next();
	});
	registerInstructionCheckoutRoutes(
		app as unknown as Parameters<
			typeof registerInstructionCheckoutRoutes
		>[0],
	);
	return app;
}

function resolveRequest(body: unknown, query = "") {
	return buildApp().request(`http://localhost${RESOLVE_PATH}${query}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

/** An ACTIVE integration row as `findAllByRepoUrl` returns it, credentials and all. */
function integrationRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "int-1",
		projectId: "project-1",
		provider: "GITHUB",
		repositoryUrl: REPOSITORY_URL,
		repositoryOwner: "example-org",
		repositoryName: "example-repo",
		status: "ACTIVE",
		encryptedAccessToken: "ciphertext-that-must-not-leave",
		encryptedPat: null,
		project: { id: "project-1", userId: "user-9", organizationId: ORG },
		...overrides,
	};
}

function syncRow(overrides: Record<string, unknown> = {}) {
	return {
		projectId: "project-1",
		organizationId: ORG,
		repositoryIntegrationId: "int-1",
		ref: "main",
		rootPath: "",
		project: { name: "Example Project" },
		organization: { slug: "example-org-slug" },
		...overrides,
	};
}

function connected(
	integrations: Array<Record<string, unknown>>,
	syncs: Array<Record<string, unknown>>,
) {
	mocks.findAllByRepoUrl.mockResolvedValue(integrations);
	// As the real query: only the syncs of the integrations it is asked for.
	mocks.listInstructionSyncsByIntegrationIds.mockImplementation(
		async (integrationIds: string[]) =>
			syncs.filter((sync) =>
				integrationIds.includes(String(sync.repositoryIntegrationId)),
			),
	);
}

function readableAs(source: "org" | "member", organizationId = ORG) {
	mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
		permissions: ["instruction:read"],
		source,
		organizationId,
	});
}

beforeEach(() => {
	for (const value of Object.values(mocks)) {
		if (typeof value === "function" && "mockReset" in value) {
			(value as ReturnType<typeof vi.fn>).mockReset();
		}
	}
	mocks.scopes = ["instructions:read"];
	apiContext = organizationKey(ORG);
	readableAs("org");
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.getProjectInstructionSettings.mockResolvedValue({
		ignoreGlobs: null,
		sourceOfTruth: "REPOSITORY",
	});
	mocks.findOrganization.mockResolvedValue({ id: ORG });
	connected([integrationRow()], [syncRow()]);
});

describe("POST /instructions/checkouts/resolve: what it answers", () => {
	it("names the repository-sourced project a canonical URL is connected to", async () => {
		const res = await resolveRequest({ candidates: [REPOSITORY_URL] });

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			data: {
				matches: [
					{
						projectId: "project-1",
						projectName: "Example Project",
						organizationSlug: "example-org-slug",
						provider: "GITHUB",
						host: "github.com",
						path: "example-org/example-repo",
						ref: "main",
						rootPath: "",
						cloneUrl: REPOSITORY_URL,
					},
				],
			},
		});
	});

	it("never returns an integration id, a credential column or the project's owner", async () => {
		const res = await resolveRequest({ candidates: [REPOSITORY_URL] });

		const text = JSON.stringify(await res.json());
		expect(text).not.toContain("int-1");
		expect(text).not.toContain("ciphertext-that-must-not-leave");
		expect(text).not.toContain("encrypted");
		expect(text).not.toContain("user-9");
	});

	it("answers a project guest who holds a ProjectMember row and no organization membership", async () => {
		apiContext = personalKey("guest-1");
		readableAs("member");

		const res = await resolveRequest({ candidates: [REPOSITORY_URL] });

		const { data } = (await res.json()) as {
			data: { matches: Array<{ projectId: string }> };
		};
		expect(data.matches.map((match) => match.projectId)).toEqual([
			"project-1",
		]);
	});

	it("names an Azure DevOps repository by the URL path with _git under dev.azure.com", async () => {
		const url =
			"https://dev.azure.com/example-org/example-project/_git/example-repo";
		connected(
			[
				integrationRow({
					provider: "AZURE_DEVOPS",
					repositoryUrl: url,
				}),
			],
			[syncRow()],
		);

		const res = await resolveRequest({ candidates: [url] });

		const { data } = (await res.json()) as {
			data: { matches: Array<Record<string, unknown>> };
		};
		expect(data.matches[0]).toMatchObject({
			provider: "AZURE_DEVOPS",
			host: "dev.azure.com",
			path: "example-org/example-project/_git/example-repo",
			cloneUrl: url,
		});
	});

	it("looks the canonical stored form up, once per distinct repository", async () => {
		await resolveRequest({
			candidates: [
				"github.com/example-org/example-repo.git",
				"https://github.com/example-org/example-repo/",
				"HTTPS://GitHub.com/example-org/example-repo",
			],
		});

		expect(mocks.findAllByRepoUrl).toHaveBeenCalledExactlyOnceWith([
			REPOSITORY_URL,
		]);
	});

	it("bounds how many projects one request puts through the read gate", async () => {
		await resolveRequest({ candidates: [REPOSITORY_URL] });

		expect(
			mocks.listInstructionSyncsByIntegrationIds,
		).toHaveBeenCalledExactlyOnceWith(["int-1"], 20);
	});
});

describe("POST /instructions/checkouts/resolve: the empty answer is the one answer", () => {
	const EMPTY = { data: { matches: [] } };

	it("is empty for another tenant's project, with an organization key", async () => {
		apiContext = organizationKey(OTHER_ORG);

		const res = await resolveRequest({ candidates: [REPOSITORY_URL] });

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(EMPTY);
	});

	it("does not spend a permission lookup on another tenant's project", async () => {
		apiContext = organizationKey(OTHER_ORG);

		await resolveRequest({ candidates: [REPOSITORY_URL] });

		expect(mocks.resolveEffectiveProjectPermissions).not.toHaveBeenCalled();
	});

	it("is empty for an organization key whose hosting organization differs once the gate runs", async () => {
		readableAs("org", OTHER_ORG);

		const res = await resolveRequest({ candidates: [REPOSITORY_URL] });

		expect(await res.json()).toEqual(EMPTY);
	});

	it("is empty, not 403, for a caller whose creator lacks INSTRUCTION_READ", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: [],
			source: "org",
			organizationId: ORG,
		});

		const res = await resolveRequest({ candidates: [REPOSITORY_URL] });

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(EMPTY);
	});

	it("is empty for a caller with no tie to the project", async () => {
		apiContext = personalKey("stranger");
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: [],
			source: "none",
			organizationId: ORG,
		});

		const res = await resolveRequest({ candidates: [REPOSITORY_URL] });

		expect(await res.json()).toEqual(EMPTY);
	});

	it("is empty for an organization member who cannot discover the project", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);

		const res = await resolveRequest({ candidates: [REPOSITORY_URL] });

		expect(await res.json()).toEqual(EMPTY);
	});

	it.each([
		["a project that keeps uploads", { sourceOfTruth: "UPLOAD" }],
		["a project whose setting was never written", { sourceOfTruth: null }],
	])("is empty for %s", async (_label, settings) => {
		mocks.getProjectInstructionSettings.mockResolvedValue({
			ignoreGlobs: null,
			...settings,
		});

		const res = await resolveRequest({ candidates: [REPOSITORY_URL] });

		expect(await res.json()).toEqual(EMPTY);
	});

	it("is empty for a personal project, which has no hosting organization", async () => {
		apiContext = personalKey();
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: ["instruction:read"],
			source: "owner",
			organizationId: null,
		});

		const res = await resolveRequest({ candidates: [REPOSITORY_URL] });

		expect(await res.json()).toEqual(EMPTY);
	});

	it("is empty when nothing is connected to the URL", async () => {
		connected([], []);

		const res = await resolveRequest({ candidates: [REPOSITORY_URL] });

		expect(await res.json()).toEqual(EMPTY);
	});

	it("is empty when ?org names an organization other than the project's", async () => {
		mocks.findOrganization.mockResolvedValue({ id: OTHER_ORG });

		const res = await resolveRequest(
			{ candidates: [REPOSITORY_URL] },
			"?org=another-org",
		);

		expect(await res.json()).toEqual(EMPTY);
	});

	it("keeps the project when ?org names its own organization", async () => {
		const res = await resolveRequest(
			{ candidates: [REPOSITORY_URL] },
			"?org=example-org-slug",
		);

		const { data } = (await res.json()) as {
			data: { matches: unknown[] };
		};
		expect(data.matches).toHaveLength(1);
	});

	it("lists only the projects the caller may read when several share a repository", async () => {
		connected(
			[
				integrationRow(),
				integrationRow({
					id: "int-2",
					projectId: "project-2",
					project: {
						id: "project-2",
						userId: "user-9",
						organizationId: ORG,
					},
				}),
			],
			[
				syncRow(),
				syncRow({
					projectId: "project-2",
					repositoryIntegrationId: "int-2",
					project: { name: "Hidden Project" },
				}),
			],
		);
		mocks.resolveEffectiveProjectPermissions.mockImplementation(
			async (projectId: string) => ({
				permissions:
					projectId === "project-1" ? ["instruction:read"] : [],
				source: "org",
				organizationId: ORG,
			}),
		);

		const res = await resolveRequest({ candidates: [REPOSITORY_URL] });

		const { data } = (await res.json()) as {
			data: { matches: Array<{ projectId: string }> };
		};
		expect(data.matches.map((match) => match.projectId)).toEqual([
			"project-1",
		]);
		expect(JSON.stringify(data)).not.toContain("Hidden Project");
	});
});

describe("POST /instructions/checkouts/resolve: what it refuses", () => {
	// Assembled at runtime, never one literal, so a publication scan does not
	// read the fixture as a leaked credential.
	const withUserinfo = [
		"https://x-access-token:",
		"secret",
		"@github.com/example-org/example-repo",
	].join("");

	it("refuses a request without the instructions:read scope, flat", async () => {
		mocks.scopes = ["instructions:write"];

		const res = await resolveRequest({ candidates: [REPOSITORY_URL] });

		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({
			error: "Missing required scope: instructions:read",
		});
		expect(mocks.findAllByRepoUrl).not.toHaveBeenCalled();
	});

	it("refuses a body that is not JSON", async () => {
		const res = await buildApp().request(
			`http://localhost${RESOLVE_PATH}`,
			{ method: "POST", body: "{not json" },
		);

		expect(res.status).toBe(400);
	});

	it.each([
		["a body that is not an object", ["https://github.com/o/r"]],
		["no candidates field", {}],
		["an empty list", { candidates: [] }],
		["a candidates field that is not a list", { candidates: "x" }],
		[
			"more than ten candidates",
			{
				candidates: Array.from(
					{ length: 11 },
					(_, index) =>
						`https://github.com/example-org/repo-${index}`,
				),
			},
		],
		["a candidate that is not a string", { candidates: [7] }],
		["an empty candidate", { candidates: [""] }],
		[
			"a candidate over 512 characters",
			{
				candidates: [
					`https://github.com/example-org/${"r".repeat(512)}`,
				],
			},
		],
	])("answers 400 for %s", async (_label, body) => {
		const res = await resolveRequest(body);

		expect(res.status).toBe(400);
		expect(mocks.findAllByRepoUrl).not.toHaveBeenCalled();
	});

	it("accepts exactly ten candidates", async () => {
		const res = await resolveRequest({
			candidates: Array.from(
				{ length: 10 },
				(_, index) => `https://github.com/example-org/repo-${index}`,
			),
		});

		expect(res.status).toBe(200);
	});

	it.each([
		["userinfo with a token", withUserinfo],
		[
			"userinfo with a user only",
			"https://example-org@dev.azure.com/example-org/p/_git/r",
		],
		["scp-style shorthand", "git@github.com:example-org/example-repo.git"],
		["a port", "https://github.com:8443/example-org/example-repo"],
		[
			"a query string",
			"https://github.com/example-org/example-repo?tab=readme",
		],
		["a fragment", "https://github.com/example-org/example-repo#readme"],
		["ssh", "ssh://github.com/example-org/example-repo"],
		[
			"a host outside the supported providers",
			"https://git.example.com/example-org/example-repo",
		],
		["no repository path", "https://github.com/example-org"],
	])(
		"answers 400 for %s, naming the position and never the value",
		async (_label, candidate) => {
			const res = await resolveRequest({
				candidates: [REPOSITORY_URL, candidate],
			});

			expect(res.status).toBe(400);
			const text = JSON.stringify(await res.json());
			expect(text).toContain("candidates[1]");
			expect(text).not.toContain("secret");
			expect(text).not.toContain("x-access-token");
			expect(text).not.toContain("git@github.com");
			expect(mocks.findAllByRepoUrl).not.toHaveBeenCalled();
		},
	);
});

describe("POST /instructions/checkouts/resolve: an agent that signed in for one project", () => {
	function boundTo(projectId: string) {
		return {
			keyType: "oauth" as const,
			userId: "user-1",
			organizationId: ORG,
			boundProjectId: projectId,
			scopes: ["instructions:read"],
		};
	}

	/** One repository connected to two projects of one organization. */
	function twoProjectsOneRepository() {
		connected(
			[
				integrationRow(),
				integrationRow({
					id: "int-2",
					projectId: "project-2",
					project: {
						id: "project-2",
						userId: "user-9",
						organizationId: ORG,
					},
				}),
			],
			[
				syncRow(),
				syncRow({
					projectId: "project-2",
					repositoryIntegrationId: "int-2",
					project: { name: "Other Project" },
				}),
			],
		);
	}

	it("is answered with its own project when the repository is connected to it", async () => {
		apiContext = boundTo("project-1");

		const res = await resolveRequest({ candidates: [REPOSITORY_URL] });

		const { data } = (await res.json()) as {
			data: { matches: Array<{ projectId: string }> };
		};
		expect(data.matches.map((match) => match.projectId)).toEqual([
			"project-1",
		]);
	});

	it("is answered with that project alone when the repository is connected to others of the organization", async () => {
		twoProjectsOneRepository();
		apiContext = boundTo("project-2");

		const res = await resolveRequest({ candidates: [REPOSITORY_URL] });

		const { data } = (await res.json()) as {
			data: { matches: Array<{ projectId: string }> };
		};
		expect(data.matches.map((match) => match.projectId)).toEqual([
			"project-2",
		]);
	});

	it("asks no permission question about any other project", async () => {
		twoProjectsOneRepository();
		apiContext = boundTo("project-2");

		await resolveRequest({ candidates: [REPOSITORY_URL] });

		expect(mocks.listInstructionSyncsByIntegrationIds).toHaveBeenCalledWith(
			["int-2"],
			20,
		);
		expect(
			mocks.resolveEffectiveProjectPermissions.mock.calls.map(
				([projectId]) => projectId,
			),
		).toEqual(["project-2"]);
	});

	it("is answered with the empty answer when the repository belongs to a project it was not signed in for", async () => {
		apiContext = boundTo("project-other");

		const res = await resolveRequest({ candidates: [REPOSITORY_URL] });

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ data: { matches: [] } });
		expect(mocks.resolveEffectiveProjectPermissions).not.toHaveBeenCalled();
	});
});
