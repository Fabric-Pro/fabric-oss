/**
 * `GET /api/mcp-gateway` refuses the standalone SSE stream with 405
 * (Fizzy #2347).
 *
 * The gateway never emits a server-initiated stream: every reply is a
 * discrete JSON-RPC response to a POST. A Streamable HTTP client still opens
 * `GET` with `Accept: text/event-stream` to listen for one, and the spec says
 * a server with no stream MUST answer that GET with 405, which official SDK
 * clients treat as "no standalone stream here" and stop asking.
 *
 * Until this change the route answered that GET with its 200 JSON info page.
 * To the client that is a stream that closed the moment it opened, so it
 * reconnected about once a second for the life of the session. Multiplied by
 * every developer machine with a coding-agent client configured against the
 * gateway, that loop was the largest source of requests to the deployment by
 * an order of magnitude, none of which authenticated or touched the database.
 *
 * The info page itself is kept for GETs that do not ask for a stream, as the
 * body of the answer. A GET with credentials gets it as a 200, as it always
 * did. A GET with none gets it as a 401 that carries the same challenge an
 * unauthenticated POST does, because an OAuth client finds a server's sign-in
 * by probing its URL with a plain GET and reads a 200 as "this is the resource's
 * metadata document" (Codex failed to sign in to either gateway URL on
 * exactly that). Each half is pinned here; the sibling `/mcp` route's
 * equivalent is pinned by `mcp-get-405`.
 */

import { describe, expect, it, vi } from "vitest";

const ORIGIN = "https://app.example.com";
const PROJECT = "project-example-one";
const SCOPE = "mcp:read instructions:read instructions:write offline_access";

vi.mock("@repo/utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/utils")>()),
	getBaseUrl: () => "https://app.example.com",
}));

vi.mock("@repo/api/modules/users/procedures/api-keys", () => ({
	verifyUserApiKey: vi.fn(),
}));

vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: vi.fn() } },
}));

vi.mock("@saas/mcp/lib/gateway", () => ({
	createGatewaySession: vi.fn(),
	deleteGatewaySession: vi.fn(),
	executeConnectedServerTool: vi.fn(),
	executePlatformTool: vi.fn(),
	getAggregatedTools: vi.fn(),
	getGatewaySession: vi.fn(),
	updateSessionOrganization: vi.fn(),
}));

vi.mock("@saas/mcp/lib/gateway/authority-service", () => ({
	enforceAuthority: vi.fn(),
	generateRequestFingerprint: vi.fn(),
	resolveProviderKeyFromToolPrefix: vi.fn(),
}));

vi.mock("@saas/mcp/lib/record-organization-refusal", () => ({
	recordOrganizationRefusal: vi.fn(),
}));

/** A GET that carries credentials, which is what the info page has always been served to. */
async function get(headers: Record<string, string> = {}) {
	return getWithoutCredentials({
		authorization: "Bearer fab_example",
		...headers,
	});
}

async function getWithoutCredentials(headers: Record<string, string> = {}) {
	const { GET } = await import("../../app/api/mcp-gateway/route");
	return GET(
		new Request(`${ORIGIN}/api/mcp-gateway`, {
			headers,
		}) as never,
	);
}

async function getProject(
	projectId: string,
	headers: Record<string, string> = {},
) {
	const { GET } = await import(
		"../../app/api/mcp-gateway/projects/[projectId]/route"
	);
	return GET(
		new Request(`${ORIGIN}/api/mcp-gateway/projects/${projectId}`, {
			headers,
		}) as never,
		{ params: Promise.resolve({ projectId }) },
	);
}

describe("GET /api/mcp-gateway", () => {
	it("refuses a standalone SSE stream with 405, Allow: POST, DELETE and no body", async () => {
		const response = await get({ accept: "text/event-stream" });

		expect(response.status).toBe(405);
		expect(response.headers.get("Allow")).toBe("POST, DELETE");
		expect(await response.text()).toBe("");
	});

	it("refuses when text/event-stream is one of several accepted types", async () => {
		// The SDK's GET sends `text/event-stream` alone (the combined value is
		// its POST header); other clients may list it alongside JSON.
		const response = await get({
			accept: "text/event-stream, application/json",
		});

		expect(response.status).toBe(405);
		expect(await response.text()).toBe("");
	});

	it("matches the media type case-insensitively", async () => {
		const response = await get({ accept: "Text/Event-Stream" });

		expect(response.status).toBe(405);
	});

	it("refuses when the stream is listed with a positive quality", async () => {
		const response = await get({
			accept: "application/json, text/event-stream;q=0.5",
		});

		expect(response.status).toBe(405);
	});

	it("serves the info page when text/event-stream is listed with q=0", async () => {
		// `q=0` is the caller saying it will not take a stream.
		const response = await get({
			accept: "text/event-stream;q=0, application/json",
		});

		expect(response.status).toBe(200);
	});

	it("honours q=0 with whitespace around the equals sign", async () => {
		const response = await get({ accept: "text/event-stream; q = 0" });

		expect(response.status).toBe(200);
	});

	it("honours a negative quality with an uppercase Q", async () => {
		const response = await get({ accept: "text/event-stream;Q = -1" });

		expect(response.status).toBe(200);
	});

	it("treats a partially numeric q value as unparseable, not as zero", async () => {
		// `parseFloat("0junk")` is 0; `Number("0junk")` is NaN. Unparseable
		// counts as 1, so this still asks for the stream.
		const response = await get({ accept: "text/event-stream;q=0junk" });

		expect(response.status).toBe(405);
	});

	it("treats an empty q value as unparseable", async () => {
		const response = await get({ accept: "text/event-stream;q=" });

		expect(response.status).toBe(405);
	});

	it("serves the info page to a subtype that merely contains the string", async () => {
		const response = await get({
			accept: "application/text/event-stream",
		});

		expect(response.status).toBe(200);
	});

	it("serves the info page to a wildcard Accept", async () => {
		// A wildcard is not a request for SSE; browsers send it on every
		// navigation.
		const response = await get({ accept: "*/*" });

		expect(response.status).toBe(200);
	});

	it("still serves the JSON info page to a GET that asks for no stream", async () => {
		const response = await get();

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain(
			"application/json",
		);
		const body = (await response.json()) as {
			name: string;
			endpoints: Record<string, string>;
		};
		expect(body.name).toBe("fabric-mcp-gateway");
		expect(body.endpoints.POST).toBeDefined();
	});

	it("still serves the info page to a browser-style Accept header", async () => {
		const response = await get({
			accept: "text/html,application/xhtml+xml,*/*;q=0.8",
		});

		expect(response.status).toBe(200);
	});
});

describe("a GET with no credentials", () => {
	const ORGANIZATION_CHALLENGE = `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp-gateway", scope="${SCOPE}"`;
	const PROJECT_CHALLENGE = `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp-gateway/projects/${PROJECT}", scope="${SCOPE}"`;

	it("is answered 401 with the organization-wide challenge, and the info page as its body", async () => {
		const response = await getWithoutCredentials();

		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toBe(
			ORGANIZATION_CHALLENGE,
		);
		const body = (await response.json()) as { name: string };
		expect(body.name).toBe("fabric-mcp-gateway");
	});

	it("is answered 401 with the project's challenge at a project's URL", async () => {
		const response = await getProject(PROJECT);

		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toBe(
			PROJECT_CHALLENGE,
		);
		const body = (await response.json()) as { name: string };
		expect(body.name).toBe("fabric-mcp-gateway");
	});

	it("is answered with the challenge a POST without credentials gets, at both URLs", async () => {
		const { POST } = await import("../../app/api/mcp-gateway/route");
		const { POST: POST_PROJECT } = await import(
			"../../app/api/mcp-gateway/projects/[projectId]/route"
		);
		const post = (url: string) =>
			new Request(url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
			}) as never;

		const organization = await POST(post(`${ORIGIN}/api/mcp-gateway`));
		const project = await POST_PROJECT(
			post(`${ORIGIN}/api/mcp-gateway/projects/${PROJECT}`),
			{ params: Promise.resolve({ projectId: PROJECT }) },
		);

		expect(
			(await getWithoutCredentials()).headers.get("www-authenticate"),
		).toBe(organization.headers.get("www-authenticate"));
		expect(
			(await getProject(PROJECT)).headers.get("www-authenticate"),
		).toBe(project.headers.get("www-authenticate"));
	});

	it.each([
		["a browser-style Accept header", { accept: "text/html,*/*;q=0.8" }],
		["a wildcard Accept", { accept: "*/*" }],
		["an empty Authorization header", { authorization: "" }],
		["an Authorization header of spaces", { authorization: "   " }],
	])("is answered 401 with %s", async (_label, headers) => {
		const response = await getWithoutCredentials(headers);

		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toBe(
			ORGANIZATION_CHALLENGE,
		);
	});

	it("is still 405 when it asks for the stream, whatever it carries", async () => {
		for (const response of [
			await getWithoutCredentials({ accept: "text/event-stream" }),
			await getProject(PROJECT, { accept: "text/event-stream" }),
		]) {
			expect(response.status).toBe(405);
			expect(response.headers.get("Allow")).toBe("POST, DELETE");
			expect(response.headers.get("www-authenticate")).toBeNull();
			expect(await response.text()).toBe("");
		}
	});

	it("is answered 404 at a project URL that is not a project id", async () => {
		const response = await getProject("not/a/project");

		expect(response.status).toBe(404);
		expect(response.headers.get("www-authenticate")).toBeNull();
	});
});

describe("a GET with credentials", () => {
	it("is served the info page as it always was, at a project's URL too, without a challenge", async () => {
		for (const response of [
			await get(),
			await getProject(PROJECT, { authorization: "Bearer fat_example" }),
		]) {
			expect(response.status).toBe(200);
			expect(response.headers.get("www-authenticate")).toBeNull();
			expect(((await response.json()) as { name: string }).name).toBe(
				"fabric-mcp-gateway",
			);
		}
	});
});
