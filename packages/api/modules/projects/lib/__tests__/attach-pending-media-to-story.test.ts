/**
 * Unit tests for the apply-time orchestrator
 * `attachPendingMediaToStory`.
 *
 * Per `fabric/standards/testing/test-writing.md`: mock only external
 * boundaries. The cap math, MIME extraction, alt-text fallback,
 * `appendAttachmentsSection`, the warning-line formatter, and the
 * concurrency runner all run for real.
 *
 * External boundary mocks:
 *   - `downloadSlackFile` (from `@repo/integrations/slack`).
 *   - `downloadTeamsHostedContent` (from `@repo/integrations/microsoft`).
 *   - `uploadFile` (from `@repo/storage`).
 *   - `updateStory` (from `@repo/database`).
 *   - The logger (we pass a hand-rolled mock to capture every call).
 *
 * Test catalog mirrors spec § 9.1 cases 1–14.
 *
 * Log-redaction: every captured log call's args are scanned for forbidden
 * substrings (token, signed URL, Slack `url_private`, Graph hostedContent
 * URL). See the shared `redactionGuard` helper below.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mocks } = vi.hoisted(() => ({
	mocks: {
		downloadSlackFile: vi.fn(),
		downloadTeamsHostedContent: vi.fn(),
		uploadFile: vi.fn(),
		updateStory: vi.fn(),
	},
}));

vi.mock("@repo/integrations/slack", async () => {
	// We need the real error classes so the orchestrator's `instanceof`
	// branches resolve correctly. Replace only the `downloadSlackFile`
	// function with our spy.
	const actual = await vi.importActual<
		typeof import("@repo/integrations/slack")
	>("@repo/integrations/slack");
	return {
		...actual,
		downloadSlackFile: mocks.downloadSlackFile,
	};
});

vi.mock("@repo/integrations/microsoft", async () => {
	const actual = await vi.importActual<
		typeof import("@repo/integrations/microsoft")
	>("@repo/integrations/microsoft");
	return {
		...actual,
		downloadTeamsHostedContent: mocks.downloadTeamsHostedContent,
	};
});

vi.mock("@repo/storage", async () => {
	const actual =
		await vi.importActual<typeof import("@repo/storage")>("@repo/storage");
	return {
		...actual,
		uploadFile: mocks.uploadFile,
	};
});

vi.mock("@repo/database", async () => {
	const actual =
		await vi.importActual<typeof import("@repo/database")>(
			"@repo/database",
		);
	return {
		...actual,
		updateStory: mocks.updateStory,
	};
});

vi.mock("@repo/config", () => ({
	config: {
		storage: {
			bucketNames: {
				projectContexts: "project-contexts-test",
			},
		},
	},
}));

// Default logger pulled in via `@repo/logs` — we patch the import here so the
// orchestrator's fallback `defaultLogger` never logs to stdout in tests when
// a test forgets to inject the test logger (none of them should, but defense
// in depth).
vi.mock("@repo/logs", () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

// ---------------------------------------------------------------------------
// Import the SUT after mocks are set up
// ---------------------------------------------------------------------------

import { DownloadFailedError as TeamsDownloadFailedError } from "@repo/integrations/microsoft";
import {
	ExternalWorkspaceError,
	ScopeMissingError,
	DownloadFailedError as SlackDownloadFailedError,
} from "@repo/integrations/slack";
import {
	appendWarningLinesToAttachmentsBlock,
	attachPendingMediaToStory,
	type OrchestratorLogger,
} from "../attach-pending-media-to-story";

/**
 * Every heading line that reads as an Attachments section, decoration and
 * demotion included — so a "did we stamp a duplicate?" assertion can't be
 * fooled by the very markup that caused the duplicate.
 */
function attachmentsHeadings(markdown: string): string[] {
	return markdown
		.split("\n")
		.filter((line) => /^#{2,6} .*Attachments/.test(line));
}

// ---------------------------------------------------------------------------
// Test fixtures + helpers
// ---------------------------------------------------------------------------

const FIVE_MB = 5 * 1024 * 1024;

function makeMockLogger(): OrchestratorLogger & {
	calls: Array<{
		level: "debug" | "info" | "warn" | "error";
		args: unknown[];
	}>;
} {
	const calls: Array<{
		level: "debug" | "info" | "warn" | "error";
		args: unknown[];
	}> = [];
	return {
		calls,
		debug: (...args: unknown[]) => {
			calls.push({ level: "debug", args });
		},
		info: (...args: unknown[]) => {
			calls.push({ level: "info", args });
		},
		warn: (...args: unknown[]) => {
			calls.push({ level: "warn", args });
		},
		error: (...args: unknown[]) => {
			calls.push({ level: "error", args });
		},
	};
}

/**
 * Walk a value tree and assert no forbidden substrings appear anywhere
 * inside it. Catches accidental token / URL leakage into log payloads.
 */
function scanForForbidden(value: unknown, forbidden: string[]): string[] {
	const hits: string[] = [];
	const seen = new WeakSet<object>();
	function walk(v: unknown, path: string): void {
		if (v === null || v === undefined) {
			return;
		}
		if (typeof v === "string") {
			for (const needle of forbidden) {
				if (v.includes(needle)) {
					hits.push(`${path} contains "${needle}"`);
				}
			}
			return;
		}
		if (typeof v !== "object") {
			return;
		}
		if (seen.has(v as object)) {
			return;
		}
		seen.add(v as object);
		if (Array.isArray(v)) {
			for (const [i, item] of v.entries()) {
				walk(item, `${path}[${i}]`);
			}
			return;
		}
		for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
			walk(item, `${path}.${k}`);
		}
	}
	walk(value, "$");
	return hits;
}

/**
 * Forbidden strings that must never appear in any captured log payload.
 * Validates the spec § 6.1 security contract.
 */
const FORBIDDEN_LOG_SUBSTRINGS = [
	"xoxb-test-secret",
	"Bearer ",
	"https://files.slack.com/",
	"url_private",
	"urlPrivate",
	"hostedContents/",
	"GRAPH-TOKEN-SECRET",
];

function assertNoSecretsLogged(
	logger: ReturnType<typeof makeMockLogger>,
): void {
	const hits = scanForForbidden(logger.calls, FORBIDDEN_LOG_SUBSTRINGS);
	expect(hits).toEqual([]);
}

interface SlackRefFixture {
	source: "slack";
	id: string;
	size: number;
	mimetype?: string;
	name?: string;
	title?: string;
	urlPrivate?: string;
	messageTs?: string;
}

function slackRef(f: SlackRefFixture) {
	return {
		source: "slack" as const,
		file: {
			id: f.id,
			name: f.name ?? `${f.id}.png`,
			title: f.title ?? `Title for ${f.id}`,
			mimetype: f.mimetype ?? "image/png",
			urlPrivate:
				f.urlPrivate ?? `https://files.slack.com/${f.id}/url_private`,
			size: f.size,
		},
		messageTs: f.messageTs ?? "1690000000.123",
	};
}

function teamsRef(id: string, opts: { altText?: string } = {}) {
	return {
		source: "teams" as const,
		ref: {
			id,
			messageId: "msg-1",
			contentType: "image/png",
			...(opts.altText !== undefined ? { altText: opts.altText } : {}),
		},
	};
}

function makeProposal(attachments: unknown[]) {
	return {
		id: "proposal-1",
		sourceMetadata: {
			channelId: "C123",
			threadTs: "1690000000.123",
			teamId: "T-team",
			messageId: "msg-1",
			attachments,
		},
	};
}

function makeStory(description: string | null = "Existing description") {
	return { id: "story-1", description };
}

/**
 * Default `downloadSlackFile` mock returns a 100KB PNG buffer for a given
 * `urlPrivate`. Override per test as needed.
 */
function defaultSlackResolver() {
	return async (
		_urlPrivate: string,
		_token: string,
		_options: { signal: AbortSignal; maxBytes: number },
	) => ({
		buffer: Buffer.from(new Uint8Array(100 * 1024)),
		mime: "image/png",
		size: 100 * 1024,
	});
}

function defaultTeamsResolver() {
	return async (
		_ref: { id: string },
		_token: string,
		_options: {
			signal: AbortSignal;
			maxBytes: number;
			messageUrl: string;
		},
	) => ({
		buffer: Buffer.from(new Uint8Array(80 * 1024)),
		mime: "image/png",
		size: 80 * 1024,
		contentDisposition: undefined,
	});
}

// ---------------------------------------------------------------------------
// beforeEach
// ---------------------------------------------------------------------------

beforeEach(() => {
	mocks.downloadSlackFile.mockReset();
	mocks.downloadTeamsHostedContent.mockReset();
	mocks.uploadFile.mockReset();
	mocks.updateStory.mockReset();

	mocks.downloadSlackFile.mockImplementation(defaultSlackResolver());
	mocks.downloadTeamsHostedContent.mockImplementation(defaultTeamsResolver());
	mocks.uploadFile.mockResolvedValue(undefined);
	mocks.updateStory.mockResolvedValue({ id: "story-1" });
});

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe("attachPendingMediaToStory", () => {
	// -------------------------------------------------------------------------
	// 1. Happy path Slack
	// -------------------------------------------------------------------------
	it("attaches 2 Slack images on the happy path", async () => {
		const logger = makeMockLogger();
		const proposal = makeProposal([
			slackRef({ source: "slack", id: "F1", size: 200 * 1024 }),
			slackRef({ source: "slack", id: "F2", size: 200 * 1024 }),
		]);
		const result = await attachPendingMediaToStory({
			proposal,
			story: makeStory("Body."),
			source: "slack",
			accessToken: "xoxb-test-secret",
			projectId: "P1",
			organizationId: "ORG1",
			userId: "U1",
			logger,
		});

		expect(result.uploaded.length).toBe(2);
		expect(result.warnings.length).toBe(0);
		expect(mocks.uploadFile).toHaveBeenCalledTimes(2);
		expect(mocks.updateStory).toHaveBeenCalledOnce();
		const firstCall = mocks.updateStory.mock.calls[0] as [
			string,
			string,
			{ description: string },
			unknown,
		];
		const [storyId, projectId, data] = firstCall;
		expect(storyId).toBe("story-1");
		expect(projectId).toBe("P1");
		const updatedDescription = (data as { description: string })
			.description;
		expect(updatedDescription).toContain("## Attachments");
		expect(
			updatedDescription.match(/!\[.*?\]\(story-media\/P1\/story-1\//g),
		).toHaveLength(2);
		assertNoSecretsLogged(logger);
	});

	// -------------------------------------------------------------------------
	// 2. Happy path Teams
	// -------------------------------------------------------------------------
	it("attaches 2 Teams hosted-contents on the happy path", async () => {
		const logger = makeMockLogger();
		const proposal = makeProposal([
			teamsRef("HC1", { altText: "First screenshot" }),
			teamsRef("HC2"),
		]);
		const result = await attachPendingMediaToStory({
			proposal,
			story: makeStory(""),
			source: "teams",
			accessToken: "GRAPH-TOKEN-SECRET",
			projectId: "P1",
			organizationId: null,
			userId: "U1",
			logger,
		});

		expect(result.uploaded.length).toBe(2);
		expect(result.warnings.length).toBe(0);
		const firstCall = mocks.updateStory.mock.calls[0] as [
			string,
			string,
			{ description: string },
			unknown,
		];
		const updatedDescription = firstCall[2].description;
		expect(updatedDescription).toContain("## Attachments");
		expect(updatedDescription).toContain("First screenshot");
		assertNoSecretsLogged(logger);
	});

	// -------------------------------------------------------------------------
	// 3. Count cap exceeded
	// -------------------------------------------------------------------------
	it("emits count_cap_exceeded warnings for refs above MAX_IMAGES_PER_THREAD", async () => {
		const logger = makeMockLogger();
		const eleven = Array.from({ length: 11 }, (_, i) =>
			slackRef({ source: "slack", id: `F${i + 1}`, size: 100 * 1024 }),
		);
		const result = await attachPendingMediaToStory({
			proposal: makeProposal(eleven),
			story: makeStory(""),
			source: "slack",
			accessToken: "xoxb-test-secret",
			projectId: "P1",
			organizationId: null,
			userId: "U1",
			logger,
		});

		expect(result.uploaded.length).toBe(10);
		expect(result.warnings.length).toBe(1);
		expect(result.warnings[0]).toMatchObject({
			source: "slack",
			refId: "F11",
			reason: "count_cap_exceeded",
		});
		expect(mocks.downloadSlackFile).toHaveBeenCalledTimes(10);
		assertNoSecretsLogged(logger);
	});

	// -------------------------------------------------------------------------
	// 4. Per-image PRE-check (Slack file.size > MAX_BYTES_PER_IMAGE)
	// -------------------------------------------------------------------------
	it("skips Slack refs whose file.size exceeds MAX_BYTES_PER_IMAGE without downloading", async () => {
		const logger = makeMockLogger();
		const proposal = makeProposal([
			slackRef({ source: "slack", id: "BIG", size: FIVE_MB + 1 }),
		]);
		const result = await attachPendingMediaToStory({
			proposal,
			story: makeStory(""),
			source: "slack",
			accessToken: "xoxb-test-secret",
			projectId: "P1",
			organizationId: null,
			userId: "U1",
			logger,
		});

		expect(result.uploaded.length).toBe(0);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toMatchObject({
			source: "slack",
			refId: "BIG",
			reason: "image_too_large",
		});
		expect(mocks.downloadSlackFile).not.toHaveBeenCalled();
		// updateStory must still be called once to insert the warning line.
		expect(mocks.updateStory).toHaveBeenCalledOnce();
		assertNoSecretsLogged(logger);
	});

	// -------------------------------------------------------------------------
	// 5. Per-image POST-check (Teams blob bigger than cap)
	// -------------------------------------------------------------------------
	it("emits image_too_large when post-download buffer exceeds MAX_BYTES_PER_IMAGE", async () => {
		const logger = makeMockLogger();
		mocks.downloadTeamsHostedContent.mockImplementation(async () => ({
			buffer: Buffer.from(new Uint8Array(FIVE_MB + 1024)),
			mime: "image/png",
			size: FIVE_MB + 1024,
		}));
		const proposal = makeProposal([teamsRef("HC1")]);
		const result = await attachPendingMediaToStory({
			proposal,
			story: makeStory(""),
			source: "teams",
			accessToken: "GRAPH-TOKEN-SECRET",
			projectId: "P1",
			organizationId: null,
			userId: "U1",
			logger,
		});

		expect(result.uploaded.length).toBe(0);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toMatchObject({
			refId: "HC1",
			reason: "image_too_large",
		});
		expect(mocks.uploadFile).not.toHaveBeenCalled();
		assertNoSecretsLogged(logger);
	});

	// -------------------------------------------------------------------------
	// 6. Total cap exceeded
	// -------------------------------------------------------------------------
	it("emits thread_total_exceeded once the running total would exceed MAX_TOTAL_BYTES_PER_THREAD", async () => {
		const logger = makeMockLogger();
		// Each ref reports 4MB pre-check (under per-image cap of 5MB) and the
		// mock returns a 4MB buffer post-download. 4 × 4MB = 16MB → fits.
		// 5 × 4MB = 20MB → fits exactly (running total <= 20MB). 6 × 4MB = 24MB
		// → 6th gets dropped. We use 6 refs at 4MB → 5 successful + 1 warning.
		const FOUR_MB = 4 * 1024 * 1024;
		mocks.downloadSlackFile.mockImplementation(async () => ({
			buffer: Buffer.from(new Uint8Array(FOUR_MB)),
			mime: "image/png",
			size: FOUR_MB,
		}));
		const refs = Array.from({ length: 6 }, (_, i) =>
			slackRef({ source: "slack", id: `F${i + 1}`, size: FOUR_MB }),
		);
		const result = await attachPendingMediaToStory({
			proposal: makeProposal(refs),
			story: makeStory(""),
			source: "slack",
			accessToken: "xoxb-test-secret",
			projectId: "P1",
			organizationId: null,
			userId: "U1",
			logger,
		});

		expect(result.uploaded.length).toBe(5);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toMatchObject({
			source: "slack",
			reason: "thread_total_exceeded",
		});
		assertNoSecretsLogged(logger);
	});

	// -------------------------------------------------------------------------
	// 7. MIME filter — unsupported MIME at post-download (defensive branch)
	// -------------------------------------------------------------------------
	it("emits unsupported_mime when the downloaded blob's Content-Type is not in the allowlist", async () => {
		const logger = makeMockLogger();
		mocks.downloadSlackFile.mockImplementation(async () => ({
			buffer: Buffer.from(new Uint8Array(80 * 1024)),
			mime: "image/svg+xml",
			size: 80 * 1024,
		}));
		const proposal = makeProposal([
			slackRef({ source: "slack", id: "SVG1", size: 80 * 1024 }),
		]);
		const result = await attachPendingMediaToStory({
			proposal,
			story: makeStory(""),
			source: "slack",
			accessToken: "xoxb-test-secret",
			projectId: "P1",
			organizationId: null,
			userId: "U1",
			logger,
		});

		expect(result.uploaded.length).toBe(0);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toMatchObject({
			refId: "SVG1",
			reason: "unsupported_mime",
			detail: "image/svg+xml",
		});
		expect(mocks.uploadFile).not.toHaveBeenCalled();
		assertNoSecretsLogged(logger);
	});

	// -------------------------------------------------------------------------
	// 8. Partial failure — 1 download fails, 1 upload fails
	// -------------------------------------------------------------------------
	it("returns a partial result when some downloads or uploads fail", async () => {
		const logger = makeMockLogger();
		// 4 refs: F1 + F2 succeed; F3 download fails; F4 upload fails.
		mocks.downloadSlackFile.mockImplementation(
			async (urlPrivate: string) => {
				if (urlPrivate.includes("F3")) {
					throw new SlackDownloadFailedError("download exploded", {
						status: 500,
					});
				}
				return {
					buffer: Buffer.from(new Uint8Array(100 * 1024)),
					mime: "image/png",
					size: 100 * 1024,
				};
			},
		);
		mocks.uploadFile.mockImplementation(async (key: string) => {
			if (key.includes("F4-marker")) {
				throw new Error("R2 5xx");
			}
		});

		// We need to make F4's upload break — to do so we'll stamp F4 as the
		// fourth ref's name (so the key includes it). Simpler: track call
		// index in uploadFile mock.
		let uploadCalls = 0;
		mocks.uploadFile.mockImplementation(async () => {
			uploadCalls++;
			if (uploadCalls === 3) {
				// 3rd successful download → 3rd upload attempt (F4 because F3
				// download failed). Throw on this call.
				throw new Error("R2 5xx");
			}
		});

		const proposal = makeProposal([
			slackRef({ source: "slack", id: "F1", size: 100 * 1024 }),
			slackRef({ source: "slack", id: "F2", size: 100 * 1024 }),
			slackRef({
				source: "slack",
				id: "F3",
				size: 100 * 1024,
				urlPrivate: "https://files.slack.com/F3/url_private",
			}),
			slackRef({ source: "slack", id: "F4", size: 100 * 1024 }),
		]);
		const result = await attachPendingMediaToStory({
			proposal,
			story: makeStory(""),
			source: "slack",
			accessToken: "xoxb-test-secret",
			projectId: "P1",
			organizationId: null,
			userId: "U1",
			logger,
		});

		expect(result.uploaded.length).toBe(2);
		expect(result.warnings.length).toBe(2);
		const reasons = result.warnings.map((w) => w.reason).sort();
		expect(reasons).toEqual(["download_failed", "upload_failed"]);
		expect(mocks.updateStory).toHaveBeenCalledOnce();
		assertNoSecretsLogged(logger);
	});

	// -------------------------------------------------------------------------
	// 9. Empty input short-circuit (AC15)
	// -------------------------------------------------------------------------
	it("short-circuits when sourceMetadata.attachments is undefined", async () => {
		const logger = makeMockLogger();
		const proposal = {
			id: "p-empty",
			sourceMetadata: { channelId: "C1" /* no attachments key */ },
		};
		const result = await attachPendingMediaToStory({
			proposal,
			story: makeStory("Untouched body"),
			source: "slack",
			accessToken: "xoxb-test-secret",
			projectId: "P1",
			organizationId: null,
			userId: "U1",
			logger,
		});

		expect(result).toEqual({ uploaded: [], warnings: [] });
		expect(mocks.downloadSlackFile).not.toHaveBeenCalled();
		expect(mocks.downloadTeamsHostedContent).not.toHaveBeenCalled();
		expect(mocks.uploadFile).not.toHaveBeenCalled();
		expect(mocks.updateStory).not.toHaveBeenCalled();
		assertNoSecretsLogged(logger);
	});

	it("short-circuits when sourceMetadata.attachments is an empty array", async () => {
		const logger = makeMockLogger();
		const result = await attachPendingMediaToStory({
			proposal: makeProposal([]),
			story: makeStory("Untouched"),
			source: "slack",
			accessToken: "xoxb-test-secret",
			projectId: "P1",
			organizationId: null,
			userId: "U1",
			logger,
		});

		expect(result).toEqual({ uploaded: [], warnings: [] });
		expect(mocks.updateStory).not.toHaveBeenCalled();
		assertNoSecretsLogged(logger);
	});

	// -------------------------------------------------------------------------
	// 10. Idempotency — running twice produces no duplicate entries
	// -------------------------------------------------------------------------
	it("is idempotent at the description level — re-running with overlapping s3Keys does not duplicate entries", async () => {
		const logger = makeMockLogger();
		// First run.
		const proposal = makeProposal([
			slackRef({ source: "slack", id: "F1", size: 100 * 1024 }),
		]);
		const first = await attachPendingMediaToStory({
			proposal,
			story: makeStory(""),
			source: "slack",
			accessToken: "xoxb-test-secret",
			projectId: "P1",
			organizationId: null,
			userId: "U1",
			logger,
		});
		expect(first.uploaded.length).toBe(1);
		const firstS3Key = first.uploaded[0]?.s3Key;
		const firstDescription = (
			mocks.updateStory.mock.calls[0]?.[2] as { description: string }
		).description;
		expect(firstDescription).toContain(firstS3Key);
		// Sanity: the key appears exactly once.
		expect(
			firstDescription.match(new RegExp(firstS3Key, "g")),
		).toHaveLength(1);

		// Simulate the retry path: the same proposal is approved a second
		// time, but the description on the story now contains the prior
		// upload's s3Key (because the first run patched it). For this run
		// we force the SUT to "re-upload" the same blob to the SAME s3Key
		// by interposing on the upload mock — this matches the scenario
		// where appliedChangeIndexes is bypassed (e.g. the patch failed
		// last time but the upload had succeeded — see spec § 10.3).
		mocks.uploadFile.mockClear();
		mocks.updateStory.mockClear();
		const REUSED_KEY = firstS3Key;
		// Intercept the SUT's randomly-generated key and force it to match
		// the prior one. We do this by stubbing uploadFile to ignore the
		// new key argument and instead record the reused one in the
		// description (the orchestrator builds the UploadedAttachment from
		// the key it just generated, so we can't truly force it to reuse
		// the prior key without also intercepting `randomUUID`). The
		// simpler, more honest assertion is that the
		// `appendAttachmentsSection` helper — the orchestrator's
		// idempotency primitive — does NOT add a new line for an s3Key
		// that already appears in the description. The append helper's
		// own test suite covers this; here we assert the orchestrator
		// uses the helper (the description after the second run still
		// contains exactly one entry for any one s3Key).
		const second = await attachPendingMediaToStory({
			proposal,
			story: { id: "story-1", description: firstDescription },
			source: "slack",
			accessToken: "xoxb-test-secret",
			projectId: "P1",
			organizationId: null,
			userId: "U1",
			logger,
		});
		expect(second.uploaded.length).toBe(1);
		const secondDescription = (
			mocks.updateStory.mock.calls[0]?.[2] as { description: string }
		).description;
		// The first run's key MUST still be present, exactly once.
		expect(
			secondDescription.match(new RegExp(REUSED_KEY, "g")),
		).toHaveLength(1);
		// Only ONE `## Attachments` heading.
		expect(secondDescription.match(/## Attachments/g)).toHaveLength(1);
		assertNoSecretsLogged(logger);
	});

	// -------------------------------------------------------------------------
	// 11. Budget exceeded — all downloads abort
	// -------------------------------------------------------------------------
	it("aborts in-flight downloads when budgetMs elapses", async () => {
		const logger = makeMockLogger();
		// All Slack downloads hang for 200ms then resolve. With budgetMs = 10
		// the global controller aborts before any of them completes; the mock
		// observes the abort signal and rejects with AbortError so the
		// orchestrator maps each ref to a budget_exceeded warning.
		mocks.downloadSlackFile.mockImplementation(
			async (
				_url: string,
				_token: string,
				{ signal }: { signal: AbortSignal },
			) =>
				new Promise((_resolve, reject) => {
					const onAbort = () => {
						const e = new Error("aborted");
						e.name = "AbortError";
						reject(e);
					};
					if (signal.aborted) {
						onAbort();
						return;
					}
					signal.addEventListener("abort", onAbort, { once: true });
					setTimeout(() => {
						signal.removeEventListener("abort", onAbort);
						_resolve({
							buffer: Buffer.from(new Uint8Array(10)),
							mime: "image/png",
							size: 10,
						});
					}, 200);
				}),
		);
		const proposal = makeProposal([
			slackRef({ source: "slack", id: "F1", size: 100 * 1024 }),
			slackRef({ source: "slack", id: "F2", size: 100 * 1024 }),
			slackRef({ source: "slack", id: "F3", size: 100 * 1024 }),
		]);
		const result = await attachPendingMediaToStory({
			proposal,
			story: makeStory(""),
			source: "slack",
			accessToken: "xoxb-test-secret",
			projectId: "P1",
			organizationId: null,
			userId: "U1",
			logger,
			budgetMs: 10,
		});

		expect(result.uploaded).toEqual([]);
		expect(result.warnings.length).toBe(3);
		for (const w of result.warnings) {
			expect(w.reason).toBe("budget_exceeded");
		}
		assertNoSecretsLogged(logger);
	});

	// -------------------------------------------------------------------------
	// 12. Concurrency = 3 — never more than 3 in-flight
	// -------------------------------------------------------------------------
	it("limits concurrent downloads to DOWNLOAD_CONCURRENCY", async () => {
		const logger = makeMockLogger();
		let inFlight = 0;
		let peak = 0;
		mocks.downloadSlackFile.mockImplementation(async () => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, 10));
			inFlight--;
			return {
				buffer: Buffer.from(new Uint8Array(10 * 1024)),
				mime: "image/png",
				size: 10 * 1024,
			};
		});
		const refs = Array.from({ length: 8 }, (_, i) =>
			slackRef({ source: "slack", id: `F${i + 1}`, size: 10 * 1024 }),
		);
		await attachPendingMediaToStory({
			proposal: makeProposal(refs),
			story: makeStory(""),
			source: "slack",
			accessToken: "xoxb-test-secret",
			projectId: "P1",
			organizationId: null,
			userId: "U1",
			logger,
		});

		expect(peak).toBeLessThanOrEqual(3);
		expect(peak).toBeGreaterThan(0);
		assertNoSecretsLogged(logger);
	});

	// -------------------------------------------------------------------------
	// 13. Warning-line placement inside ## Attachments block
	// -------------------------------------------------------------------------
	it("places the warning line INSIDE the ## Attachments block after uploads", async () => {
		const logger = makeMockLogger();
		mocks.downloadSlackFile.mockImplementation(async (url: string) => {
			if (url.includes("FAIL")) {
				throw new SlackDownloadFailedError("nope", { status: 500 });
			}
			return {
				buffer: Buffer.from(new Uint8Array(10 * 1024)),
				mime: "image/png",
				size: 10 * 1024,
			};
		});
		const proposal = makeProposal([
			slackRef({ source: "slack", id: "F1", size: 10 * 1024 }),
			slackRef({
				source: "slack",
				id: "F2",
				size: 10 * 1024,
				urlPrivate: "https://files.slack.com/FAIL/url_private",
			}),
		]);
		await attachPendingMediaToStory({
			proposal,
			story: makeStory(""),
			source: "slack",
			accessToken: "xoxb-test-secret",
			projectId: "P1",
			organizationId: null,
			userId: "U1",
			logger,
		});

		const data = mocks.updateStory.mock.calls[0]?.[2] as {
			description: string;
		};
		const desc = data.description;
		const headingIdx = desc.indexOf("## Attachments");
		const warningIdx = desc.indexOf(
			"_⚠ 1 image couldn't be attached from Slack",
		);
		expect(headingIdx).toBeGreaterThanOrEqual(0);
		expect(warningIdx).toBeGreaterThan(headingIdx);
		assertNoSecretsLogged(logger);
	});

	// -------------------------------------------------------------------------
	// 14. Tenant safety — R2 key prefix carries projectId + storyId
	// -------------------------------------------------------------------------
	it("scopes R2 keys to story-media/{projectId}/{storyId}/", async () => {
		const logger = makeMockLogger();
		const proposal = makeProposal([
			slackRef({ source: "slack", id: "F1", size: 10 * 1024 }),
		]);
		await attachPendingMediaToStory({
			proposal,
			story: { id: "STORY-ABC", description: "" },
			source: "slack",
			accessToken: "xoxb-test-secret",
			projectId: "PROJECT-XYZ",
			organizationId: "ORG1",
			userId: "U1",
			logger,
		});

		const firstCall = mocks.uploadFile.mock.calls[0] as [
			string,
			Buffer,
			{ bucket: string; contentType: string },
		];
		const [key, _buf, opts] = firstCall;
		expect(key).toMatch(/^story-media\/PROJECT-XYZ\/STORY-ABC\/[^/]+$/);
		expect((opts as { bucket: string }).bucket).toBe(
			"project-contexts-test",
		);
		assertNoSecretsLogged(logger);
	});

	// -------------------------------------------------------------------------
	// Extra coverage — error-mapping branches
	// -------------------------------------------------------------------------
	it("maps ScopeMissingError to reason 'scope_missing'", async () => {
		const logger = makeMockLogger();
		mocks.downloadSlackFile.mockImplementation(async () => {
			throw new ScopeMissingError();
		});
		const proposal = makeProposal([
			slackRef({ source: "slack", id: "F1", size: 10 * 1024 }),
		]);
		const result = await attachPendingMediaToStory({
			proposal,
			story: makeStory(""),
			source: "slack",
			accessToken: "xoxb-test-secret",
			projectId: "P1",
			organizationId: null,
			userId: "U1",
			logger,
		});

		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]?.reason).toBe("scope_missing");
		assertNoSecretsLogged(logger);
	});

	it("maps ExternalWorkspaceError to reason 'external_workspace'", async () => {
		const logger = makeMockLogger();
		mocks.downloadSlackFile.mockImplementation(async () => {
			throw new ExternalWorkspaceError();
		});
		const proposal = makeProposal([
			slackRef({ source: "slack", id: "F1", size: 10 * 1024 }),
		]);
		const result = await attachPendingMediaToStory({
			proposal,
			story: makeStory(""),
			source: "slack",
			accessToken: "xoxb-test-secret",
			projectId: "P1",
			organizationId: null,
			userId: "U1",
			logger,
		});

		expect(result.warnings[0]?.reason).toBe("external_workspace");
		assertNoSecretsLogged(logger);
	});

	it("maps Teams DownloadFailedError to reason 'download_failed'", async () => {
		const logger = makeMockLogger();
		mocks.downloadTeamsHostedContent.mockImplementation(async () => {
			throw new TeamsDownloadFailedError("graph 5xx", { status: 502 });
		});
		const proposal = makeProposal([teamsRef("HC1")]);
		const result = await attachPendingMediaToStory({
			proposal,
			story: makeStory(""),
			source: "teams",
			accessToken: "GRAPH-TOKEN-SECRET",
			projectId: "P1",
			organizationId: null,
			userId: "U1",
			logger,
		});

		expect(result.warnings[0]?.reason).toBe("download_failed");
		expect(result.warnings[0]?.detail).toBe("502");
		assertNoSecretsLogged(logger);
	});

	it("treats malformed sourceMetadata as empty without throwing", async () => {
		const logger = makeMockLogger();
		const result = await attachPendingMediaToStory({
			proposal: { id: "p-bad", sourceMetadata: "not-an-object" },
			story: makeStory(""),
			source: "slack",
			accessToken: "xoxb-test-secret",
			projectId: "P1",
			organizationId: null,
			userId: "U1",
			logger,
		});
		expect(result).toEqual({ uploaded: [], warnings: [] });
		expect(mocks.updateStory).not.toHaveBeenCalled();
		assertNoSecretsLogged(logger);
	});

	it("skips updateStory entirely when uploaded=0 AND warnings=0", async () => {
		// Empty input is one such case (covered by case 9). This adds a sanity
		// check that the `if (uploaded.length === 0 && warnings.length === 0)`
		// guard fires on the empty-input fast path.
		const logger = makeMockLogger();
		await attachPendingMediaToStory({
			proposal: makeProposal([]),
			story: makeStory("body"),
			source: "slack",
			accessToken: "xoxb-test-secret",
			projectId: "P1",
			organizationId: null,
			userId: "U1",
			logger,
		});
		expect(mocks.updateStory).not.toHaveBeenCalled();
		assertNoSecretsLogged(logger);
	});

	it("includes channelId/threadTs from sourceMetadata in the download log fields", async () => {
		const logger = makeMockLogger();
		await attachPendingMediaToStory({
			proposal: makeProposal([
				slackRef({ source: "slack", id: "F1", size: 10 * 1024 }),
			]),
			story: makeStory(""),
			source: "slack",
			accessToken: "xoxb-test-secret",
			projectId: "P1",
			organizationId: null,
			userId: "U1",
			logger,
		});
		const downloadCall = logger.calls.find((c) => {
			const meta = c.args[1] as Record<string, unknown> | undefined;
			return meta?.step === "download" && meta?.outcome === "success";
		});
		expect(downloadCall).toBeDefined();
		const meta = downloadCall?.args[1] as Record<string, unknown>;
		expect(meta.channelId).toBe("C123");
		expect(meta.threadTs).toBe("1690000000.123");
		expect(meta.refId).toBe("F1");
		expect(meta.proposalId).toBe("proposal-1");
		expect(meta.projectId).toBe("P1");
		expect(meta.storyId).toBe("story-1");
		assertNoSecretsLogged(logger);
	});

	it("never propagates an exception out of the orchestrator", async () => {
		// Mock updateStory to throw — orchestrator should catch and emit a
		// defensive warning (FR-23).
		const logger = makeMockLogger();
		mocks.updateStory.mockRejectedValue(new Error("DB explosion"));
		const proposal = makeProposal([
			slackRef({ source: "slack", id: "F1", size: 10 * 1024 }),
		]);
		const result = await attachPendingMediaToStory({
			proposal,
			story: makeStory(""),
			source: "slack",
			accessToken: "xoxb-test-secret",
			projectId: "P1",
			organizationId: null,
			userId: "U1",
			logger,
		});
		// The upload itself succeeded, but the patch step failed — uploaded
		// stays populated and the warning records the DB failure with the
		// `patch_failed` reason (bug_008: distinct from `upload_failed` so
		// the proposal-inbox tooltip points at the right subsystem).
		expect(result.uploaded.length).toBe(1);
		expect(result.warnings.some((w) => w.reason === "patch_failed")).toBe(
			true,
		);
		// Must NOT be labeled upload_failed — the R2 upload succeeded; only
		// the DB description-patch failed.
		expect(result.warnings.some((w) => w.reason === "upload_failed")).toBe(
			false,
		);
		assertNoSecretsLogged(logger);
	});

	// -------------------------------------------------------------------------
	// 15. Decorated ## Attachments heading — both description writers (the
	//     upload lines and the warning lines) must land in the EXISTING block.
	// -------------------------------------------------------------------------
	it("appends into a HIGHLIGHTED ## Attachments block instead of stamping a second one", async () => {
		const logger = makeMockLogger();
		mocks.downloadSlackFile.mockImplementation(async (url: string) => {
			if (url.includes("FAIL")) {
				throw new SlackDownloadFailedError("nope", { status: 500 });
			}
			return {
				buffer: Buffer.from(new Uint8Array(10 * 1024)),
				mime: "image/png",
				size: 10 * 1024,
			};
		});
		const proposal = makeProposal([
			slackRef({ source: "slack", id: "F1", size: 10 * 1024 }),
			slackRef({
				source: "slack",
				id: "F2",
				size: 10 * 1024,
				urlPrivate: "https://files.slack.com/FAIL/url_private",
			}),
		]);
		// The story's heading carries an editor highlight — the shape that used
		// to make every append create a fresh `## Attachments` section.
		const decorated =
			'body\n\n## <mark data-color="#fef08a">Attachments</mark>\n\n![old.png](story-media/P1/story-1/old.png)\n';
		await attachPendingMediaToStory({
			proposal,
			story: { id: "story-1", description: decorated },
			source: "slack",
			accessToken: "xoxb-test-secret",
			projectId: "P1",
			organizationId: null,
			userId: "U1",
			logger,
		});

		const desc = (
			mocks.updateStory.mock.calls[0]?.[2] as { description: string }
		).description;
		// Exactly one section, and it is still the user's decorated heading.
		expect(attachmentsHeadings(desc)).toHaveLength(1);
		expect(desc).not.toContain("## Attachments");
		expect(desc).toContain(
			'## <mark data-color="#fef08a">Attachments</mark>',
		);
		// Both writers landed inside it: the upload line and the warning line.
		const headingIdx = desc.indexOf("<mark");
		expect(desc.indexOf("![old.png]")).toBeGreaterThan(headingIdx);
		expect(
			desc.indexOf("_⚠ 1 image couldn't be attached from Slack"),
		).toBeGreaterThan(headingIdx);
		assertNoSecretsLogged(logger);
	});
});

/**
 * The warning-line writer used to carry its own inlined
 * `description.includes("## Attachments")`, so a decorated heading made it
 * stamp a second block immediately after `appendAttachmentsSection` had merged
 * into the first. It now shares `hasAttachmentsHeading`.
 */
describe("appendWarningLinesToAttachmentsBlock", () => {
	const WARNING =
		"_⚠ 1 image couldn't be attached from Slack — open the thread to view._";

	it("returns the description untouched when there are no warning lines", () => {
		expect(appendWarningLinesToAttachmentsBlock("body", [])).toBe("body");
	});

	it("creates the block exactly once when the document has no Attachments heading", () => {
		const out = appendWarningLinesToAttachmentsBlock("body", [WARNING]);
		expect(out).toBe(`body\n\n## Attachments\n\n${WARNING}\n`);
		expect(attachmentsHeadings(out)).toHaveLength(1);
	});

	it("appends into an existing UNDECORATED block byte-identically", () => {
		const input =
			"body\n\n## Attachments\n\n![a.png](story-media/p/s/a.png)\n";
		const out = appendWarningLinesToAttachmentsBlock(input, [WARNING]);
		expect(out).toBe(`${input}${WARNING}\n`);
		expect(attachmentsHeadings(out)).toHaveLength(1);
	});

	it("appends into a HIGHLIGHTED block instead of creating a second one", () => {
		const input =
			'body\n\n## <mark data-color="#fef08a">Attachments</mark>\n\n![a.png](story-media/p/s/a.png)\n';
		const out = appendWarningLinesToAttachmentsBlock(input, [WARNING]);
		expect(out).toBe(`${input}${WARNING}\n`);
		expect(out).not.toContain("## Attachments");
		expect(attachmentsHeadings(out)).toHaveLength(1);
	});

	it("treats a DEMOTED ### Attachments heading as an existing block", () => {
		const input =
			"body\n\n### Attachments\n\n![a.png](story-media/p/s/a.png)\n";
		const out = appendWarningLinesToAttachmentsBlock(input, [WARNING]);
		expect(out).toBe(`${input}${WARNING}\n`);
		expect(attachmentsHeadings(out)).toHaveLength(1);
	});

	it("appends into an existing block of an ALREADY-CORRUPTED document instead of stamping a third", () => {
		const input =
			'body\n\n## <mark data-color="#fef08a">Attachments</mark>\n\n![a.png](story-media/p/s/a.png)\n\n## Attachments\n\n![b.png](story-media/p/s/b.png)\n';
		const out = appendWarningLinesToAttachmentsBlock(input, [WARNING]);
		expect(out).toBe(`${input}${WARNING}\n`);
		expect(attachmentsHeadings(out)).toHaveLength(2);
	});

	it("stays idempotent — a rerun does not double-stamp the same warning", () => {
		const input =
			'body\n\n## <mark data-color="#fef08a">Attachments</mark>\n';
		const once = appendWarningLinesToAttachmentsBlock(input, [WARNING]);
		expect(appendWarningLinesToAttachmentsBlock(once, [WARNING])).toBe(
			once,
		);
		expect(attachmentsHeadings(once)).toHaveLength(1);
	});
});
