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

/**
 * The route does not honour `Idempotency-Key`, and a retry of a request that
 * is still building the archive on the server does not wait for that build —
 * it starts another. So `createDownloadUrl` overrides the client's retry
 * policy to zero on every call, regardless of what the client itself was
 * configured with.
 */
describe("createDownloadUrl never retries", () => {
	function abortingClient(): {
		client: FabricClient;
		attempts: () => number;
	} {
		let attempts = 0;
		const stub: typeof fetch = async () => {
			attempts++;
			const err = new Error("The operation was aborted");
			err.name = "AbortError";
			throw err;
		};
		return {
			client: createFabric({
				apiKey: "fab_test_key",
				baseUrl: "https://test.fabric",
				fetch: stub,
				// No `retry` override: the shipped default (two retries) is
				// what any OTHER mutating call on this client gets.
				retry: { initialDelayMs: 1 },
			}),
			attempts: () => attempts,
		};
	}

	it("is called exactly once on a timeout, even though the client would otherwise retry it", async () => {
		const { client, attempts } = abortingClient();

		await expect(
			client.instructions.createDownloadUrl("project-1"),
		).rejects.toThrow();

		expect(attempts()).toBe(1);
	});

	// The control: the same failure, the same client, a mutating call this
	// SDK does retry. If this stops retrying, the test above has stopped
	// proving anything.
	it("still retries submitChange on the same client", async () => {
		const { client, attempts } = abortingClient();

		await expect(
			client.instructions.submitChange("project-1", "snap-7", [
				{ op: "delete", path: "old.md" },
			]),
		).rejects.toThrow();

		expect(attempts()).toBeGreaterThan(1);
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

/**
 * `submitChange` is retried like every other mutating call in this SDK.
 *
 * It did not used to be. The route creates a snapshot row per POST and a
 * proposal counts against a cap of five per proposer, so a request whose
 * RESPONSE was lost used to be replayed into a second identical pending
 * proposal — and this resource turned retries off to stop that. The route
 * now deduplicates by the CONTENT of the change set (base plus the set of
 * op, path and sha256), so the replay returns the proposal the first attempt
 * opened, and the override was doing nothing but turning one dropped packet
 * into a failed push.
 *
 * These build a client with the DEFAULT retry policy on purpose. The helper
 * above passes `maxRetries: 0`, which would make every one of them pass
 * whatever the resource does.
 */
describe("submitChange uses the shipped retry policy", () => {
	function failingClient(error: unknown): {
		client: FabricClient;
		attempts: () => number;
	} {
		let attempts = 0;
		const stub: typeof fetch = async () => {
			attempts++;
			throw error;
		};
		return {
			client: createFabric({
				apiKey: "fab_test_key",
				baseUrl: "https://test.fabric",
				fetch: stub,
				// No `retry`: the shipped default is what a caller gets.
				retry: { initialDelayMs: 1 },
			}),
			attempts: () => attempts,
		};
	}

	const change = [
		{ op: "put" as const, path: "AGENTS.md", content: "# Updated\n" },
	];

	it("retries a network failure instead of surfacing the first one", async () => {
		const { client, attempts } = failingClient(
			new TypeError("fetch failed"),
		);

		await expect(
			client.instructions.submitChange("project-1", "snap-7", change),
		).rejects.toThrow();

		expect(attempts()).toBeGreaterThan(1);
	});

	// The control: the same client, the same failure, an idempotent read. If
	// this stops retrying, the test above has stopped proving anything.
	it("still retries an idempotent read on the same client", async () => {
		const { client, attempts } = failingClient(
			new TypeError("fetch failed"),
		);

		await expect(
			client.instructions.getPublished("project-1"),
		).rejects.toThrow();

		expect(attempts()).toBeGreaterThan(1);
	});
});

/**
 * A 404 that names its own `code` has written its own sentence too.
 *
 * `NOTHING_PUBLISHED` is the case: the route answers "this project has no
 * published coding instructions to change yet…", and the CLI branches on the
 * code to tell that apart from a project that does not exist. Treating the
 * message as a resource NAME produced "…to change yet. not found" under the
 * generic `NOT_FOUND`, which made that branch unreachable.
 */
describe("a 404 that carries a code", () => {
	const MESSAGE =
		"This project has no published coding instructions to change yet. Upload a first version from the Coding Instructions tab.";

	it("keeps both the message and the code", async () => {
		const { client } = buildClient({
			status: 404,
			rawBody: { error: { message: MESSAGE, code: "NOTHING_PUBLISHED" } },
		});

		await expect(
			client.instructions.submitChange("project-1", "snap-7", [
				{ op: "delete", path: "old.md" },
			]),
		).rejects.toMatchObject({
			message: MESSAGE,
			code: "NOTHING_PUBLISHED",
			status: 404,
		});
	});

	// A codeless 404 keeps the old shape exactly, so nothing that relies on
	// the "<resource> not found" sentence changes.
	it("still appends 'not found' when the body names no code", async () => {
		const { client } = buildClient({
			status: 404,
			rawBody: { error: { message: "Project" } },
		});

		await expect(
			client.instructions.getPublished("project-1"),
		).rejects.toMatchObject({
			message: "Project not found",
			code: "NOT_FOUND",
		});
	});
});

/**
 * `baseSnapshotId` is positional and required, and the signature is the point.
 *
 * It used to be an optional field on the options bag, and the server fell
 * back to whatever was published at the moment the request arrived. Every
 * caller that left it out therefore had the stale-base check silently turned
 * off: an edit written against v7 and sent after v8 was published was rebased
 * onto v8 without a word, reverting v8's changes to the files it touched.
 * Making it the second argument means no caller can leave it out by accident
 * and none can leave it out at all.
 */
describe("submitChange states its base", () => {
	it("sends the base in the body and nothing about a mode", async () => {
		const { client, captured } = buildClient({
			responseBody: { snapshotId: "snap-8" },
		});

		await client.instructions.submitChange("project-1", "snap-7", [
			{ op: "delete", path: "old.md" },
		]);

		expect(captured[0]?.method).toBe("POST");
		expect(captured[0]?.body).toEqual({
			baseSnapshotId: "snap-7",
			changes: [{ op: "delete", path: "old.md" }],
		});
	});

	it("still carries an explicit org as a query parameter", async () => {
		const { client, captured } = buildClient({
			responseBody: { snapshotId: "snap-8" },
		});

		await client.instructions.submitChange(
			"project-1",
			"snap-7",
			[{ op: "delete", path: "old.md" }],
			{ org: "example-org" },
		);

		expect(captured[0]?.url).toContain("org=example-org");
		expect(captured[0]?.body).toEqual({
			baseSnapshotId: "snap-7",
			changes: [{ op: "delete", path: "old.md" }],
		});
	});
});
