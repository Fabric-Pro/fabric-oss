import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubRepository } from "../src/repository-create";

const TOKEN = "test-token";

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function mockFetch(...responses: Response[]) {
	const fetchMock = vi.fn();
	for (const response of responses) {
		fetchMock.mockResolvedValueOnce(response);
	}
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("createGitHubRepository", () => {
	it("creates under the user when the owner is the token's login", async () => {
		const fetchMock = mockFetch(
			json(200, { login: "dev-user" }),
			json(201, {
				name: "app-ai",
				html_url: "https://github.com/dev-user/app-ai",
				default_branch: "main",
				owner: { login: "dev-user" },
			}),
		);
		const result = await createGitHubRepository({
			token: TOKEN,
			owner: "Dev-User",
			name: "app-ai",
			private: true,
		});
		expect(result).toEqual({
			ok: true,
			repository: {
				owner: "dev-user",
				name: "app-ai",
				url: "https://github.com/dev-user/app-ai",
				defaultBranch: "main",
			},
		});
		expect(fetchMock.mock.calls[1]?.[0]).toBe(
			"https://api.github.com/user/repos",
		);
		const body = JSON.parse(fetchMock.mock.calls[1]?.[1].body as string);
		expect(body).toMatchObject({
			name: "app-ai",
			private: true,
			auto_init: true,
		});
	});

	it("creates under an organization", async () => {
		const fetchMock = mockFetch(
			json(200, { login: "dev-user" }),
			json(201, {
				name: "app-ai",
				html_url: "https://github.com/example-org/app-ai",
				default_branch: "main",
				owner: { login: "example-org" },
			}),
		);
		await createGitHubRepository({
			token: TOKEN,
			owner: "example-org",
			name: "app-ai",
			private: true,
		});
		expect(fetchMock.mock.calls[1]?.[0]).toBe(
			"https://api.github.com/orgs/example-org/repos",
		);
	});

	it.each([
		[
			json(422, {
				errors: [{ message: "name already exists on this account" }],
			}),
			"exists",
		],
		[
			json(403, { message: "Resource not accessible by integration" }),
			"forbidden",
		],
		[json(404, { message: "Not Found" }), "forbidden"],
		[json(401, { message: "Bad credentials" }), "unauthorized"],
		[json(500, {}), "unreachable"],
	])("maps a refusal to its outcome", async (response, outcome) => {
		mockFetch(json(200, { login: "dev-user" }), response);
		const result = await createGitHubRepository({
			token: TOKEN,
			owner: null,
			name: "app-ai",
			private: true,
		});
		expect(result).toEqual({ ok: false, outcome });
	});

	it("refuses an invalid name without calling GitHub", async () => {
		const fetchMock = mockFetch();
		const result = await createGitHubRepository({
			token: TOKEN,
			owner: null,
			name: "bad name",
			private: true,
		});
		expect(result).toEqual({ ok: false, outcome: "invalid" });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
