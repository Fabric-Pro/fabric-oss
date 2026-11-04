import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	addRepositoryCollaborator,
	addTeamMember,
	ensureInstructionsTeam,
	GitHubAccessError,
	getRepositoryOwner,
	getTeamMembership,
	instructionsTeamSlug,
	isRepositoryCollaborator,
	removeRepositoryCollaborator,
	removeTeamMember,
} from "../../src/github/instructions-access";

const TOKEN = "example-token-value";
const repository = { owner: "example-org", name: "example-instructions" };

type Call = { url: string; method: string; body: unknown; headers: Headers };

let calls: Call[] = [];
let replies: Array<() => Response> = [];

function json(status: number, body: unknown): () => Response {
	return () =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		});
}

function empty(status: number): () => Response {
	return () => new Response(null, { status });
}

beforeEach(() => {
	calls = [];
	replies = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			calls.push({
				url,
				method: init.method ?? "GET",
				body: init.body ? JSON.parse(String(init.body)) : undefined,
				headers: new Headers(init.headers),
			});
			const next = replies.shift();
			if (!next) {
				throw new Error(`unexpected request ${url}`);
			}
			return next();
		}),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("getRepositoryOwner", () => {
	it("reads the owner type and login, with a bearer token and a deadline", async () => {
		replies.push(
			json(200, {
				owner: { type: "Organization", login: "Example-Org" },
			}),
		);
		await expect(getRepositoryOwner(TOKEN, repository)).resolves.toEqual({
			type: "Organization",
			login: "Example-Org",
		});
		expect(calls[0]?.url).toBe(
			"https://api.github.com/repos/example-org/example-instructions",
		);
		expect(calls[0]?.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
		const init = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit;
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it.each([
		[401, "auth"],
		[403, "forbidden"],
		[404, "not-found"],
		[422, "validation"],
		[500, "http"],
	])(
		"maps %i to a typed %s error that never carries the token",
		async (status, kind) => {
			replies.push(json(status, { message: "Short reason" }));
			const error = await getRepositoryOwner(TOKEN, repository).catch(
				(e: unknown) => e,
			);
			expect(error).toBeInstanceOf(GitHubAccessError);
			expect(error).toMatchObject({ kind, status });
			expect((error as Error).message).toContain("Short reason");
			expect((error as Error).message).not.toContain(TOKEN);
		},
	);

	it("tells a rate limit from a refusal", async () => {
		replies.push(json(403, { message: "API rate limit exceeded" }));
		await expect(
			getRepositoryOwner(TOKEN, repository),
		).rejects.toMatchObject({ kind: "rate-limited" });
	});

	it("turns a network failure into an unavailable error", async () => {
		replies.push(() => {
			throw new TypeError("fetch failed");
		});
		await expect(
			getRepositoryOwner(TOKEN, repository),
		).rejects.toMatchObject({ kind: "unavailable" });
	});
});

describe("ensureInstructionsTeam", () => {
	const input = {
		org: "example-org",
		teamSlug: instructionsTeamSlug("example-project"),
		marker: "fabric-project:proj_1",
		description: "Managed by Fabric (fabric-project:proj_1).",
		repository,
	};

	it("creates the team when missing and gives it pull on the repository", async () => {
		replies.push(
			json(404, { message: "Not Found" }),
			json(201, { slug: "fabric-example-project-instructions" }),
			empty(204),
		);
		await expect(ensureInstructionsTeam(TOKEN, input)).resolves.toBe(
			"fabric-example-project-instructions",
		);
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			"GET https://api.github.com/orgs/example-org/teams/fabric-example-project-instructions",
			"POST https://api.github.com/orgs/example-org/teams",
			"PUT https://api.github.com/orgs/example-org/teams/fabric-example-project-instructions/repos/example-org/example-instructions",
		]);
		expect(calls[1]?.body).toMatchObject({
			name: "fabric-example-project-instructions",
			privacy: "closed",
		});
		expect(calls[2]?.body).toEqual({ permission: "pull" });
	});

	it("reuses a team Fabric made for this project", async () => {
		replies.push(json(200, { description: input.description }), empty(204));
		await ensureInstructionsTeam(TOKEN, input);
		expect(calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
	});

	it("refuses a same-named team Fabric did not make for this project", async () => {
		replies.push(json(200, { description: "Someone else's team" }));
		await expect(
			ensureInstructionsTeam(TOKEN, input),
		).rejects.toMatchObject({ kind: "conflict" });
		expect(calls).toHaveLength(1);
	});
});

describe("team membership", () => {
	const member = {
		org: "example-org",
		teamSlug: "fabric-example-project-instructions",
		username: "example-dev",
	};

	it("adds a member and reports a pending invitation", async () => {
		replies.push(json(200, { state: "pending" }));
		await expect(addTeamMember(TOKEN, member)).resolves.toBe("pending");
		expect(calls[0]).toMatchObject({
			method: "PUT",
			url: "https://api.github.com/orgs/example-org/teams/fabric-example-project-instructions/memberships/example-dev",
		});
	});

	it("reads a missing membership as null", async () => {
		replies.push(json(404, { message: "Not Found" }));
		await expect(getTeamMembership(TOKEN, member)).resolves.toBeNull();
	});

	it("removes a member, and a missing one is not an error", async () => {
		replies.push(json(404, { message: "Not Found" }));
		await expect(removeTeamMember(TOKEN, member)).resolves.toBeUndefined();
		expect(calls[0]?.method).toBe("DELETE");
	});
});

describe("collaborators", () => {
	const collaborator = { repository, username: "example-dev" };

	it("invites with pull", async () => {
		replies.push(json(201, { id: 7 }));
		await expect(
			addRepositoryCollaborator(TOKEN, collaborator),
		).resolves.toBe("invited");
		expect(calls[0]).toMatchObject({
			method: "PUT",
			url: "https://api.github.com/repos/example-org/example-instructions/collaborators/example-dev",
			body: { permission: "pull" },
		});
	});

	it("reports an existing collaborator rather than a grant", async () => {
		replies.push(empty(204));
		await expect(
			addRepositoryCollaborator(TOKEN, collaborator),
		).resolves.toBe("already-collaborator");
	});

	it("reads collaborator status from 204 and 404", async () => {
		replies.push(empty(204), json(404, { message: "Not Found" }));
		await expect(
			isRepositoryCollaborator(TOKEN, collaborator),
		).resolves.toBe(true);
		await expect(
			isRepositoryCollaborator(TOKEN, collaborator),
		).resolves.toBe(false);
	});

	it("withdraws an open invitation and removes the collaborator", async () => {
		replies.push(
			json(200, [{ id: 42, invitee: { login: "Example-Dev" } }]),
			empty(204),
			empty(204),
		);
		await removeRepositoryCollaborator(TOKEN, collaborator);
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			"GET https://api.github.com/repos/example-org/example-instructions/invitations?per_page=100&page=1",
			"DELETE https://api.github.com/repos/example-org/example-instructions/invitations/42",
			"DELETE https://api.github.com/repos/example-org/example-instructions/collaborators/example-dev",
		]);
	});
});
