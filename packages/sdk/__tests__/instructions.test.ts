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

	// Fizzy #2709: a plain passthrough field, pinned so a later change to the
	// resource cannot silently drop it.
	it("passes the snapshot's source and the project's repository config through untouched", async () => {
		const { client } = buildClient({
			responseBody: {
				published: true,
				sourceOfTruth: "REPOSITORY",
				snapshot: {
					id: "snap-2",
					version: 7,
					digest: "abc",
					fileCount: 2,
					publishedAt: "2026-09-17T10:00:00.000Z",
					source: {
						kind: "REPOSITORY",
						ref: "main",
						commitSha: "a".repeat(40),
						current: true,
					},
				},
				repository: {
					provider: "GITHUB",
					host: "github.com",
					path: "example-org/example-repo",
					ref: "main",
					rootPath: "",
					generation: 3,
				},
				manifest: [],
			},
		});

		const result = await client.instructions.getPublished("project-1");

		expect(result.snapshot?.source).toEqual({
			kind: "REPOSITORY",
			ref: "main",
			commitSha: "a".repeat(40),
			current: true,
		});
		expect(result.repository).toEqual({
			provider: "GITHUB",
			host: "github.com",
			path: "example-org/example-repo",
			ref: "main",
			rootPath: "",
			generation: 3,
		});
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

	/**
	 * `publishChange` joins it, for a different reason with the same
	 * consequence. The proposal route deduplicates by the content of the
	 * change set, so a replay comes back with the proposal the first attempt
	 * opened; the publish route has no such dedup — a replay would create a
	 * second version of the same content — so the call is sent once and a
	 * lost response is reported rather than repeated.
	 */
	it("sends publishChange exactly once on a timeout", async () => {
		const { client, attempts } = abortingClient();

		await expect(
			client.instructions.publishChange("project-1", "snap-7", [
				{ op: "delete", path: "old.md" },
			]),
		).rejects.toThrow();

		expect(attempts()).toBe(1);
	});

	// The control: the same failure, the same client, a mutating call this
	// SDK does retry. If this stops retrying, the tests above have stopped
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

/**
 * `publishChange` is a different ROUTE, not a flag on the one above.
 *
 * The two authorities are two API-key scopes — `instructions:write` proposes,
 * `instructions:publish` publishes — and a scope is checked per route. A body
 * field would have made a key's scope list stop describing what the key can
 * do, which is the objection that kept publishing out of this SDK until the
 * second scope existed. So the only difference a caller sees is which method
 * they call, and the URL is what carries it.
 */
describe("publishChange is its own route", () => {
	it("POSTs the same body to instructions/versions", async () => {
		const { client, captured } = buildClient({
			responseBody: { snapshotId: "snap-8" },
		});

		await client.instructions.publishChange("project-1", "snap-7", [
			{ op: "delete", path: "old.md" },
		]);

		expect(captured[0]?.method).toBe("POST");
		expect(captured[0]?.url).toBe(
			"https://test.fabric/api/v1/projects/project-1/instructions/versions",
		);
		// No mode in the body: the route IS the mode.
		expect(captured[0]?.body).toEqual({
			baseSnapshotId: "snap-7",
			changes: [{ op: "delete", path: "old.md" }],
		});
	});

	it("carries an explicit org and escapes the project id", async () => {
		const { client, captured } = buildClient({
			responseBody: { snapshotId: "snap-8" },
		});

		await client.instructions.publishChange(
			"project one",
			"snap-7",
			[{ op: "delete", path: "old.md" }],
			{ org: "example-org" },
		);

		expect(captured[0]?.url).toBe(
			"https://test.fabric/api/v1/projects/project%20one/instructions/versions?org=example-org",
		);
	});

	/**
	 * `published` is what tells a caller `status: "READY"` did not, by
	 * itself, mean this version landed (Fizzy #2606 review): the auto-publish
	 * is a fast-forward, and a snapshot whose base stopped being published
	 * while it validated can pass every check and still lose the pointer.
	 * This pins that the client hands the server's own value back rather than
	 * deriving it from `status`.
	 */
	it("resolves the server's publication verdict, not a derived one", async () => {
		const { client } = buildClient({
			responseBody: {
				snapshotId: "snap-9",
				version: 9,
				status: "READY",
				published: false,
			},
		});

		const result = await client.instructions.publishChange(
			"project-1",
			"snap-7",
			[{ op: "delete", path: "old.md" }],
		);

		expect(result.published).toBe(false);
	});

	// The scope refusal a key without `instructions:publish` gets, in the flat
	// shape the v1 middleware answers with. It must reach the caller as the
	// server's own words: "ask an admin for the right scope" is not advice the
	// SDK can improvise.
	it("surfaces a missing publish scope verbatim", async () => {
		const { client } = buildClient({
			status: 403,
			rawBody: { error: "Missing required scope: instructions:publish" },
		});

		await expect(
			client.instructions.publishChange("project-1", "snap-7", [
				{ op: "delete", path: "old.md" },
			]),
		).rejects.toThrow("Missing required scope: instructions:publish");
	});
});

// ---------------------------------------------------------------------------
// A REPOSITORY proposal's pull request (Fizzy #2563 spec §12)
// ---------------------------------------------------------------------------

describe("submitChange with a note (note parity)", () => {
	it("sends the note in the body, never in the query, and returns the pull-request block", async () => {
		const pullRequest = {
			operationId: "op-1",
			state: "QUEUED",
			url: null,
			externalId: null,
			failure: null,
			lastCheckedAt: null,
		};
		const { client, captured } = buildClient({
			responseBody: { snapshotId: "snap-8", pullRequest },
		});

		const result = await client.instructions.submitChange(
			"project-1",
			"snap-7",
			[{ op: "delete", path: "old.md" }],
			{
				org: "example-org",
				note: {
					title: "Tighten the lint rule",
					body: "Why it matters.",
				},
			},
		);

		expect(result.pullRequest).toEqual(pullRequest);
		expect(captured[0]?.body).toEqual({
			baseSnapshotId: "snap-7",
			changes: [{ op: "delete", path: "old.md" }],
			note: { title: "Tighten the lint rule", body: "Why it matters." },
		});
		expect(captured[0]?.url).toContain("org=example-org");
		expect(captured[0]?.url).not.toContain("note");
	});

	it("surfaces a rejected note's code and field", async () => {
		const { client } = buildClient({
			status: 422,
			rawBody: {
				error: {
					message: "The title must be one line.",
					code: "NOTE_REJECTED",
					data: { field: "title" },
				},
			},
		});

		await expect(
			client.instructions.submitChange(
				"project-1",
				"snap-7",
				[{ op: "delete", path: "old.md" }],
				{ note: { title: "two\nlines" } },
			),
		).rejects.toMatchObject({
			status: 422,
			code: "NOTE_REJECTED",
			data: { field: "title" },
		});
	});
});

describe("getProposalPullRequest", () => {
	it("GETs the proposal's pull request, escaping both ids, and returns the block", async () => {
		const block = {
			operationId: "op-1",
			state: "OPEN",
			url: "https://example.com/example-org/example-repo/pull/7",
			externalId: "7",
			failure: null,
			lastCheckedAt: "2026-09-24T12:05:00.000Z",
			attempt: 1,
			observation: null,
			mergeSync: null,
		};
		const { client, captured } = buildClient({
			responseBody: { pullRequest: block },
		});
		const controller = new AbortController();

		const pullRequest = await client.instructions.getProposalPullRequest(
			"project 1",
			"snap/8",
			{ org: "example-org", signal: controller.signal },
		);

		expect(pullRequest).toEqual(block);
		expect(captured[0]?.method).toBe("GET");
		expect(captured[0]?.url).toBe(
			"https://test.fabric/api/v1/projects/project%201/instructions/proposals/snap%2F8/pull-request?org=example-org",
		);
	});

	it("is null for a proposal Fabric reviews itself", async () => {
		const { client } = buildClient({ responseBody: { pullRequest: null } });

		expect(
			await client.instructions.getProposalPullRequest(
				"project-1",
				"snap-8",
			),
		).toBeNull();
	});
});

describe("getOpenProposals", () => {
	it("GETs the caller's open proposals, escaping the project id, and returns the list", async () => {
		const proposals = [
			{
				snapshotId: "snap-8",
				version: 8,
				baseSnapshotId: "snap-7",
				status: "READY",
				pullRequest: {
					state: "OPEN",
					url: "https://example.com/example-org/example-repo/pull/7",
				},
				changes: [
					{ path: "AGENTS.md", op: "put", sha256: "a".repeat(64) },
					{ path: "old.md", op: "delete", sha256: null },
				],
			},
		];
		const { client, captured } = buildClient({
			responseBody: { proposals },
		});

		const result = await client.instructions.getOpenProposals("project 1", {
			org: "example-org",
		});

		expect(result).toEqual(proposals);
		expect(captured[0]?.method).toBe("GET");
		expect(captured[0]?.url).toBe(
			"https://test.fabric/api/v1/projects/project%201/instructions/proposals/open?org=example-org",
		);
	});

	// Coding instructions have no personal arm, so nothing but the
	// organization reaches the query, whatever else a caller passes.
	it("sends only the organization in its query", async () => {
		const { client, captured } = buildClient({
			responseBody: { proposals: [] },
		});

		await client.instructions.getOpenProposals("project-1", {
			org: "example-org",
			personal: true,
		} as Parameters<typeof client.instructions.getOpenProposals>[1]);

		expect(lastRequest(captured).url).toBe(
			"https://test.fabric/api/v1/projects/project-1/instructions/proposals/open?org=example-org",
		);
	});

	it("rejects with the signal's own reason when it is cancelled", async () => {
		const { client } = buildClient({ responseBody: { proposals: [] } });
		const controller = new AbortController();
		const reason = new Error("deadline");
		controller.abort(reason);

		await expect(
			client.instructions.getOpenProposals("project-1", {
				signal: controller.signal,
			}),
		).rejects.toBe(reason);
	});
});
