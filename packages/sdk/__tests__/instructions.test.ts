/**
 * InstructionsResource shape tests (Fizzy #2539).
 *
 * Same contract as the other SDK suites: `fetch` is stubbed and the
 * assertions are about the request that leaves the client — URL, method,
 * query encoding, headers. The server side is covered by the v1 route tests
 * in @repo/api.
 */
import { describe, expect, it } from "vitest";
import { createFabric, type FabricClient } from "../src/index.js";

interface CapturedRequest {
	url: string;
	method: string;
	body: unknown;
	headers: Record<string, string>;
}

function buildClient({
	responseBody = {},
	org,
	status = 200,
	rawBody,
}: {
	responseBody?: unknown;
	org?: string;
	status?: number;
	/** A complete response body, for the error shapes that are not `{data}`. */
	rawBody?: unknown;
} = {}): {
	client: FabricClient;
	captured: CapturedRequest[];
} {
	const captured: CapturedRequest[] = [];
	const stub: typeof fetch = async (input, init) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url;
		const headers: Record<string, string> = {};
		if (init?.headers) {
			const h = new Headers(init.headers);
			h.forEach((v, k) => {
				headers[k] = v;
			});
		}
		captured.push({
			url,
			method: init?.method ?? "GET",
			body: init?.body ? JSON.parse(init.body as string) : null,
			headers,
		});
		return new Response(JSON.stringify(rawBody ?? { data: responseBody }), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	};

	const client = createFabric({
		apiKey: "fab_test_key",
		baseUrl: "https://test.fabric",
		fetch: stub,
		retry: { maxRetries: 0 },
		org,
	});
	return { client, captured };
}

function lastRequest(captured: CapturedRequest[]): CapturedRequest {
	const r = captured[captured.length - 1];
	if (!r) {
		throw new Error("No captured request");
	}
	return r;
}

describe("InstructionsResource.getPublished", () => {
	it("GETs the published manifest with the Bearer key", async () => {
		const { client, captured } = buildClient({
			responseBody: {
				published: true,
				sourceOfTruth: "UPLOAD",
				snapshot: {
					id: "snap-2",
					version: 7,
					digest: "abc",
					fileCount: 2,
					publishedAt: "2026-09-17T10:00:00.000Z",
				},
				manifest: [],
			},
		});

		const result = await client.instructions.getPublished("project-1");

		const req = lastRequest(captured);
		expect(req.method).toBe("GET");
		expect(req.url).toBe(
			"https://test.fabric/api/v1/projects/project-1/instructions/published",
		);
		expect(req.headers.authorization).toBe("Bearer fab_test_key");
		expect(result.snapshot?.version).toBe(7);
	});

	it("encodes sinceDigest as a query parameter", async () => {
		const { client, captured } = buildClient({
			responseBody: { published: true, sourceOfTruth: "UPLOAD" },
		});

		await client.instructions.getPublished("project-1", {
			sinceDigest: "d".repeat(64),
		});

		expect(lastRequest(captured).url).toBe(
			`https://test.fabric/api/v1/projects/project-1/instructions/published?sinceDigest=${"d".repeat(64)}`,
		);
	});

	it("carries an explicit org and escapes the project id", async () => {
		const { client, captured } = buildClient();

		await client.instructions.getPublished("proj/with space", {
			org: "example org",
		});

		expect(lastRequest(captured).url).toBe(
			"https://test.fabric/api/v1/projects/proj%2Fwith%20space/instructions/published?org=example+org",
		);
	});

	it("inherits the client's default org context", async () => {
		const { client, captured } = buildClient({ org: "example-org" });

		await client.instructions.getPublished("project-1");

		expect(lastRequest(captured).url).toBe(
			"https://test.fabric/api/v1/projects/project-1/instructions/published?org=example-org",
		);
	});
});

describe("InstructionsResource.createDownloadUrl", () => {
	it("POSTs and carries an Idempotency-Key", async () => {
		const { client, captured } = buildClient({
			responseBody: {
				snapshotId: "snap-2",
				digest: "abc",
				url: "https://storage.example.com/exports/snap-2.zip?sig=x",
				expiresInSeconds: 600,
			},
		});

		const result = await client.instructions.createDownloadUrl("project-1");

		const req = lastRequest(captured);
		expect(req.method).toBe("POST");
		expect(req.url).toBe(
			"https://test.fabric/api/v1/projects/project-1/instructions/published/download",
		);
		expect(req.body).toEqual({});
		expect(req.headers["idempotency-key"]).toBeTruthy();
		expect(result.expiresInSeconds).toBe(600);
	});

	it("passes an explicit org through", async () => {
		const { client, captured } = buildClient();

		await client.instructions.createDownloadUrl("project-1", {
			org: "example-org",
		});

		expect(lastRequest(captured).url).toBe(
			"https://test.fabric/api/v1/projects/project-1/instructions/published/download?org=example-org",
		);
	});
});

describe("error shapes", () => {
	/**
	 * The v1 API-key middleware answers a MISSING SCOPE with a bare string
	 * and an object-level permission failure with the nested form. The
	 * distinction is deliberate on the wire; the SDK used to parse only the
	 * nested one, so a scope refusal reached the caller as "HTTP 403" with
	 * nothing to act on.
	 */
	it("surfaces a missing-scope refusal verbatim", async () => {
		const { client } = buildClient({
			status: 403,
			rawBody: { error: "Missing required scope: instructions:read" },
		});

		await expect(
			client.instructions.getPublished("project-1"),
		).rejects.toMatchObject({
			message: "Missing required scope: instructions:read",
			code: "MISSING_SCOPE",
			status: 403,
		});
	});

	it("still surfaces the nested object-level refusal", async () => {
		const { client } = buildClient({
			status: 403,
			rawBody: {
				error: {
					message:
						"No coding-instructions read permission for this project",
				},
			},
		});

		await expect(
			client.instructions.getPublished("project-1"),
		).rejects.toMatchObject({
			message: "No coding-instructions read permission for this project",
			status: 403,
		});
		await expect(
			client.instructions.getPublished("project-1"),
		).rejects.not.toMatchObject({ code: "MISSING_SCOPE" });
	});

	it("does not invent a code for a bare-string error at another status", async () => {
		const { client } = buildClient({
			status: 500,
			rawBody: { error: "Something went wrong" },
		});

		await expect(
			client.instructions.getPublished("project-1"),
		).rejects.toMatchObject({
			message: "Something went wrong",
			code: undefined,
		});
	});
});

/**
 * Review round 3, finding 3. The constructor adopts `FABRIC_ORG` /
 * `FABRIC_PERSONAL`, and `buildUrl` injects that context into every request
 * that does not name one. A project-authoritative surface must be able to
 * send nothing at all.
 */
describe("withoutContext", () => {
	it("drops a configured org from the request", async () => {
		const { client, captured } = buildClient({ org: "example-org" });

		await client.withoutContext().instructions.getPublished("project-1");

		expect(lastRequest(captured).url).toBe(
			"https://test.fabric/api/v1/projects/project-1/instructions/published",
		);
	});

	it("leaves the original client alone", async () => {
		const { client, captured } = buildClient({ org: "example-org" });

		client.withoutContext();
		await client.instructions.getPublished("project-1");

		expect(lastRequest(captured).url).toContain("org=example-org");
	});

	it("still honours an org passed per call", async () => {
		const { client, captured } = buildClient({ org: "example-org" });

		await client
			.withoutContext()
			.instructions.getPublished("project-1", { org: "other-org" });

		expect(lastRequest(captured).url).toContain("org=other-org");
	});
});

describe("personal context", () => {
	/**
	 * `buildQuery` used to emit `personal=` for `false`, and the client's URL
	 * builder treats the mere presence of `personal=` as "an explicit context
	 * was supplied" and skips the default `org`. Passing `personal: false`
	 * therefore silently dropped a configured organization.
	 */
	it("keeps the client's default org when personal is explicitly false", async () => {
		const { client, captured } = buildClient({ org: "example-org" });

		await client.instructions.getPublished("project-1", {
			personal: false,
		});

		expect(lastRequest(captured).url).toBe(
			"https://test.fabric/api/v1/projects/project-1/instructions/published?org=example-org",
		);
	});

	it("still sends personal=1 when it is true", async () => {
		const { client, captured } = buildClient();

		await client.instructions.getPublished("project-1", {
			personal: true,
		});

		expect(lastRequest(captured).url).toBe(
			"https://test.fabric/api/v1/projects/project-1/instructions/published?personal=1",
		);
	});
});
