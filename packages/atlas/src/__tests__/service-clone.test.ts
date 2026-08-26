/**
 * Repository acquisition for analysis — blobless (`--filter=blob:none`) shallow
 * clone + per-attempt working dir + bounded transient retry + back-fill retry.
 *
 * Locks the contract that the analysis clone:
 *  - is a BLOBLESS, shallow clone (`--filter=blob:none`) for a MINIMAL on-disk +
 *    on-wire footprint, materializing only the parser's files via a CLIENT-SIDE
 *    sparse-checkout that back-fills just those blobs from the promisor remote;
 *  - clones each attempt into its OWN unique directory (a retry never shares — and
 *    so never deletes — a prior/concurrent attempt's clone dir);
 *  - retries a transient clone failure a few times into a fresh dir, but fails
 *    fast on a reconnect-required auth failure and on user cancellation;
 *  - retries a transient promisor back-fill failure on the sparse `checkout` so it
 *    recovers at the small footprint, and only falls back to a (larger) full
 *    checkout when the retries are exhausted.
 */
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockResolveRepoCredentials = vi.fn();
const mockForceReExchange = vi.fn();
const mockMarkReauth = vi.fn();
const mockClone = vi.fn();
const mockRevparse = vi.fn();
const mockShow = vi.fn();
const mockRaw = vi.fn();
const mockWriteFileSync = vi.fn();
const mockRmSync = vi.fn();

vi.mock("../credentials", () => ({ ensureFreshRepoCredentials: vi.fn() }));
vi.mock("../commits", () => ({ countCommitsSince: vi.fn() }));

// The clone-auth helpers moved to `@repo/integrations`; keep the real pure
// helpers (buildAuthCloneUrl, isGitAuthError) and stub only the two async
// recovery functions the clone path drives.
vi.mock("@repo/integrations", async (importActual) => ({
	...(await importActual<typeof import("@repo/integrations")>()),
	forceReExchangeRepoCredentials: (...a: unknown[]) =>
		mockForceReExchange(...a),
	markRepoReauthRequired: (...a: unknown[]) => mockMarkReauth(...a),
}));

vi.mock("../queries", () => ({
	resolveRepoCredentials: (...a: unknown[]) =>
		mockResolveRepoCredentials(...a),
}));

vi.mock("@repo/database", () => ({ recordAudit: vi.fn() }));

vi.mock("@repo/ai", () => ({
	AIProviderNotConfiguredError: class AIProviderNotConfiguredError extends Error {},
	generateObject: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	logModelUsageAsync: vi.fn(),
	streamText: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Keep real `fs` but stub the two calls the clone path makes, so nothing touches
// the real filesystem and the sparse pattern + per-attempt cleanup are observable.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	// Reference the mocks lazily (inside wrappers) — a factory runs while service.ts
	// imports node:fs, before these top-level consts initialize, so accessing them
	// eagerly would hit the temporal-dead-zone.
	return {
		...actual,
		writeFileSync: (...a: unknown[]) => mockWriteFileSync(...a),
		rmSync: (...a: unknown[]) => mockRmSync(...a),
	};
});

vi.mock("simple-git", () => ({
	default: vi.fn(() => ({
		clone: (...a: unknown[]) => mockClone(...a),
		revparse: (...a: unknown[]) => mockRevparse(...a),
		show: (...a: unknown[]) => mockShow(...a),
		raw: (...a: unknown[]) => mockRaw(...a),
	})),
}));

import { AtlasError } from "../errors";
import { AtlasService } from "../service";

const ctx = { userId: "user-1", organizationId: "org-1" };

const creds = {
	provider: "GITHUB",
	repositoryUrl: "https://github.com/acme/widgets",
	owner: "acme",
	repo: "widgets",
	branch: "main",
	azureOrganization: null,
	token: "stale-token",
};

const authError = new Error(
	"fatal: Authentication failed for 'https://github.com/acme/widgets/'",
);

type Creds = typeof creds;

/** `cloneRepo` is private; drive it directly. */
function cloneRepo(
	service: AtlasService,
	c: Creds,
	clonePath: string,
	abortSignal?: AbortSignal,
) {
	return (
		service as unknown as {
			cloneRepo: (
				c: Creds,
				p: string,
				s?: AbortSignal,
			) => Promise<{ commitSha: string; commitAt: Date | null }>;
		}
	).cloneRepo(c, clonePath, abortSignal);
}

type AcquireInput = {
	creds: Creds;
	projectId: string;
	repositoryIntegrationId: string;
	analysisId: string;
	activityAttempt?: number;
	abortSignal?: AbortSignal;
	heartbeat?: () => void;
};

/** `acquireRepoForAnalysis` is private; drive it directly. */
function acquireRepoForAnalysis(service: AtlasService, input: AcquireInput) {
	return (
		service as unknown as {
			acquireRepoForAnalysis: (i: AcquireInput) => Promise<{
				clonePath: string;
				commitSha: string;
				commitAt: Date | null;
			}>;
		}
	).acquireRepoForAnalysis(input);
}

/** `makeClonePath` is private; drive it directly. */
function makeClonePath(
	service: AtlasService,
	analysisId: string,
	activityAttempt?: number,
): string {
	return (
		service as unknown as {
			makeClonePath: (a: string, n?: number) => string;
		}
	).makeClonePath(analysisId, activityAttempt);
}

/** Skip the real backoff so the retry test runs instantly. */
function stubSleep() {
	return vi
		.spyOn(
			AtlasService.prototype as unknown as {
				sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
			},
			"sleep",
		)
		.mockResolvedValue(undefined);
}

beforeEach(() => {
	vi.clearAllMocks();
	mockClone.mockResolvedValue(undefined);
	mockRevparse.mockResolvedValue("abc1234\n");
	mockShow.mockResolvedValue("2026-06-01T00:00:00Z\n");
	mockRaw.mockResolvedValue("");
	mockResolveRepoCredentials.mockResolvedValue(creds);
	mockForceReExchange.mockResolvedValue({ refreshed: false });
});

describe("cloneRepo — blobless shallow clone", () => {
	it("clones BLOBLESS with --filter=blob:none (minimal disk/wire footprint)", async () => {
		// Empty ls-tree → cloneRepo returns commit info without a sparse checkout.
		mockRaw.mockResolvedValue("");

		const service = new AtlasService(ctx);
		const result = await cloneRepo(service, creds, "/tmp/fabric-cu-x");

		expect(mockClone).toHaveBeenCalledTimes(1);
		const cloneArgs = mockClone.mock.calls[0]?.[2] as string[];
		expect(cloneArgs).toEqual([
			"--depth",
			"1",
			"--single-branch",
			"--branch",
			"main",
			"--filter=blob:none",
			"--no-checkout",
		]);
		// The partial-clone filter keeps the initial download (and `.git`) tiny —
		// blobs are back-filled lazily by the sparse-checkout. It is a download/disk
		// choice only; the analyzed file set is unaffected.
		expect(cloneArgs).toContain("--filter=blob:none");
		expect(result).toEqual({
			commitSha: "abc1234",
			commitAt: new Date("2026-06-01T00:00:00Z"),
		});
	});

	it("materializes only the parser's files via a client-side sparse-checkout", async () => {
		mockRaw.mockImplementation(async (args: string[]) => {
			if (args[0] === "ls-tree") {
				return "src/app.ts\nREADME.md\npackage.json\nassets/logo.png\n";
			}
			return "";
		});

		const service = new AtlasService(ctx);
		await cloneRepo(service, creds, "/tmp/fabric-cu-y");

		const rawCalls = mockRaw.mock.calls.map((c) => c[0] as string[]);
		expect(rawCalls).toContainEqual([
			"sparse-checkout",
			"init",
			"--no-cone",
		]);
		expect(rawCalls).toContainEqual(["checkout"]);

		// The sparse pattern selects source/manifest/markdown and excludes the
		// binary — only those blobs are back-filled from the promisor remote, so the
		// working tree (and `.git`) stay small even though the clone is blobless.
		expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
		const pattern = mockWriteFileSync.mock.calls[0]?.[1] as string;
		expect(pattern).toContain("/src/app.ts");
		expect(pattern).toContain("/README.md");
		expect(pattern).toContain("/package.json");
		expect(pattern).not.toContain("logo.png");
		const cloneArgs = mockClone.mock.calls[0]?.[2] as string[];
		expect(cloneArgs).toContain("--filter=blob:none");
	});
});

describe("cloneRepo — promisor back-fill retry on sparse-checkout", () => {
	const lsTree = "src/app.ts\npackage.json\n";

	it("retries a transient back-fill failure, then succeeds WITHOUT a full-checkout fallback", async () => {
		const sleepSpy = stubSleep();
		let checkoutCalls = 0;
		mockRaw.mockImplementation(async (args: string[]) => {
			if (args[0] === "ls-tree") {
				return lsTree;
			}
			if (args[0] === "checkout") {
				checkoutCalls++;
				// First two back-fill attempts die with the transient promisor
				// fetch errors a blobless checkout can hit; the third succeeds.
				if (checkoutCalls === 1) {
					throw new Error(
						"fatal: early EOF\nfatal: fetch-pack: invalid index-pack output",
					);
				}
				if (checkoutCalls === 2) {
					throw new Error(
						"error: could not fetch 0a1b2c3 from promisor remote",
					);
				}
				return "";
			}
			return "";
		});

		const service = new AtlasService(ctx);
		await cloneRepo(service, creds, "/tmp/fabric-cu-backfill");

		// The back-fill checkout was retried until it succeeded (2 fails + 1 ok)...
		expect(checkoutCalls).toBe(3);
		// ...recovering at the SMALL footprint: sparse was NEVER disabled, so it
		// never fell back to a (larger) full checkout.
		const rawCalls = mockRaw.mock.calls.map((c) => c[0] as string[]);
		expect(
			rawCalls.some(
				(a) => a[0] === "sparse-checkout" && a[1] === "disable",
			),
		).toBe(false);
		// Short escalating, abort-aware backoff between back-fill attempts.
		expect(sleepSpy).toHaveBeenCalledTimes(2);
		expect(sleepSpy.mock.calls[0]?.[0]).toBe(1000);
		expect(sleepSpy.mock.calls[1]?.[0]).toBe(2000);

		sleepSpy.mockRestore();
	});

	it("falls back to a full checkout after the back-fill retries are exhausted", async () => {
		const sleepSpy = stubSleep();
		let checkoutCalls = 0;
		let sparseDisabled = false;
		mockRaw.mockImplementation(async (args: string[]) => {
			if (args[0] === "ls-tree") {
				return lsTree;
			}
			if (args[0] === "sparse-checkout" && args[1] === "disable") {
				sparseDisabled = true;
				return "";
			}
			if (args[0] === "checkout") {
				checkoutCalls++;
				// Every blobless back-fill attempt keeps failing transiently; only
				// the full checkout (after sparse is disabled) succeeds.
				if (!sparseDisabled) {
					throw new Error(
						"fatal: fetch-pack: invalid index-pack output",
					);
				}
				return "";
			}
			return "";
		});

		const service = new AtlasService(ctx);
		await cloneRepo(service, creds, "/tmp/fabric-cu-exhaust");

		// 3 bounded back-fill attempts, then 1 full-checkout fallback.
		expect(checkoutCalls).toBe(4);
		expect(sparseDisabled).toBe(true);
		// Backoff ran only between the 3 back-fill attempts (not after the last).
		expect(sleepSpy).toHaveBeenCalledTimes(2);

		sleepSpy.mockRestore();
	});

	it("does NOT retry a non-transient checkout error — straight to full-checkout fallback", async () => {
		const sleepSpy = stubSleep();
		let checkoutCalls = 0;
		let sparseDisabled = false;
		mockRaw.mockImplementation(async (args: string[]) => {
			if (args[0] === "ls-tree") {
				return lsTree;
			}
			if (args[0] === "sparse-checkout" && args[1] === "disable") {
				sparseDisabled = true;
				return "";
			}
			if (args[0] === "checkout") {
				checkoutCalls++;
				if (!sparseDisabled) {
					// A non-transient sparse-checkout error (not a promisor blip).
					throw new Error("fatal: unable to write new index file");
				}
				return "";
			}
			return "";
		});

		const service = new AtlasService(ctx);
		await cloneRepo(service, creds, "/tmp/fabric-cu-nontransient");

		// One back-fill attempt (no retry) + the full-checkout fallback.
		expect(checkoutCalls).toBe(2);
		expect(sparseDisabled).toBe(true);
		// A non-transient error is not retried, so no backoff happened.
		expect(sleepSpy).not.toHaveBeenCalled();

		sleepSpy.mockRestore();
	});

	it("propagates a cancellation during back-fill WITHOUT a full-checkout fallback", async () => {
		const controller = new AbortController();
		controller.abort();
		let sparseDisabled = false;
		mockRaw.mockImplementation(async (args: string[]) => {
			if (args[0] === "ls-tree") {
				return lsTree;
			}
			if (args[0] === "sparse-checkout" && args[1] === "disable") {
				sparseDisabled = true;
			}
			return "";
		});

		const service = new AtlasService(ctx);
		await expect(
			cloneRepo(
				service,
				creds,
				"/tmp/fabric-cu-cancel",
				controller.signal,
			),
		).rejects.toBeInstanceOf(AtlasError);

		// The abort check short-circuits the back-fill before any checkout, and the
		// cancellation must NOT degrade into a full checkout.
		const rawCalls = mockRaw.mock.calls.map((c) => c[0] as string[]);
		expect(rawCalls.some((a) => a[0] === "checkout")).toBe(false);
		expect(sparseDisabled).toBe(false);
	});
});

describe("makeClonePath — per-attempt unique directory", () => {
	it("is unique per call and tags the Temporal activity attempt", () => {
		const service = new AtlasService(ctx);

		const p1 = makeClonePath(service, "an-1", 2);
		const p2 = makeClonePath(service, "an-1", 2);
		// Random suffix → two attempts of the SAME analysis never collide.
		expect(p1).not.toBe(p2);
		expect(path.basename(p1)).toMatch(/^fabric-cu-an-1-a2-[0-9a-f]{12}$/);
		expect(path.basename(p2)).toMatch(/^fabric-cu-an-1-a2-[0-9a-f]{12}$/);

		// No activity context (e.g. unit/non-activity) → still unique, tagged a0.
		const p3 = makeClonePath(service, "an-1", undefined);
		expect(path.basename(p3)).toMatch(/^fabric-cu-an-1-a0-[0-9a-f]{12}$/);

		expect(p1.startsWith(os.tmpdir())).toBe(true);
	});
});

describe("acquireRepoForAnalysis — bounded transient retry", () => {
	it("retries a transient clone failure into a FRESH dir, then succeeds", async () => {
		const sleepSpy = stubSleep();
		mockClone
			.mockRejectedValueOnce(
				new Error("fatal: fetch-pack: invalid index-pack output"),
			)
			.mockRejectedValueOnce(new Error("fatal: early EOF"))
			.mockResolvedValue(undefined);

		const heartbeat = vi.fn();
		const service = new AtlasService(ctx);
		const result = await acquireRepoForAnalysis(service, {
			creds,
			projectId: "p1",
			repositoryIntegrationId: "int-1",
			analysisId: "an-1",
			activityAttempt: 1,
			heartbeat,
		});

		expect(mockClone).toHaveBeenCalledTimes(3);
		expect(result.commitSha).toBe("abc1234");
		// Each attempt cloned into a DISTINCT directory.
		const dirs = mockClone.mock.calls.map((c) => c[1] as string);
		expect(new Set(dirs).size).toBe(3);
		// Each failed attempt cleaned up ONLY its own dir.
		expect(mockRmSync).toHaveBeenCalledTimes(2);
		// Never re-exchanged credentials (these are network, not auth, failures).
		expect(mockForceReExchange).not.toHaveBeenCalled();
		// Backoff escalates and the activity heartbeats between attempts.
		expect(sleepSpy).toHaveBeenCalledTimes(2);
		expect(sleepSpy.mock.calls[0]?.[0]).toBe(1500);
		expect(sleepSpy.mock.calls[1]?.[0]).toBe(3000);
		expect(heartbeat).toHaveBeenCalledTimes(2);

		sleepSpy.mockRestore();
	});

	it("does NOT retry a reconnect-required auth failure — fails fast", async () => {
		const sleepSpy = stubSleep();
		mockClone.mockRejectedValue(authError);

		const service = new AtlasService(ctx);
		await expect(
			acquireRepoForAnalysis(service, {
				// GitLab → no GitHub re-exchange; cloneForAnalysis flags reconnect
				// and raises a clean REPOSITORY_REAUTH_REQUIRED AtlasError.
				creds: { ...creds, provider: "GITLAB" },
				projectId: "p1",
				repositoryIntegrationId: "int-1",
				analysisId: "an-1",
				activityAttempt: 1,
			}),
		).rejects.toMatchObject({ code: "REPOSITORY_REAUTH_REQUIRED" });

		expect(mockClone).toHaveBeenCalledTimes(1);
		expect(mockMarkReauth).toHaveBeenCalledTimes(1);
		expect(sleepSpy).not.toHaveBeenCalled();

		sleepSpy.mockRestore();
	});

	it("surfaces a cancellation without cloning when already aborted", async () => {
		const controller = new AbortController();
		controller.abort();

		const service = new AtlasService(ctx);
		await expect(
			acquireRepoForAnalysis(service, {
				creds,
				projectId: "p1",
				repositoryIntegrationId: "int-1",
				analysisId: "an-1",
				activityAttempt: 1,
				abortSignal: controller.signal,
			}),
		).rejects.toBeInstanceOf(AtlasError);
		expect(mockClone).not.toHaveBeenCalled();
	});
});
