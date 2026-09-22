/**
 * `fabric instructions push` end to end (Fizzy #2539), with the SDK client
 * mocked at the `getClient` boundary.
 *
 * Four promises are pinned here, and each one is a way the command could be
 * quietly wrong rather than loudly broken:
 *
 *  - it refuses to run at all without a lock, because a push is a diff and
 *    there is nothing to diff against;
 *  - it sends the lock's snapshot id as the base, so a checkout that has
 *    fallen behind is refused rather than rebased;
 *  - the server's reason codes become sentences a developer can act on,
 *    `PULL_FIRST` above all;
 *  - it NEVER writes the lock. A proposal changes nothing about what is
 *    published, and a lock that claimed otherwise would make the next `sync`
 *    believe this checkout already held a version nobody has approved.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildInstructionsCommand } from "../src/commands/instructions/index.js";
import type { InstructionsLock } from "../src/lib/instructions/lock.js";

const OUTSIDE_CONFIG_PATH = path.join(tmpdir(), "fabricai", "config.json");

const { mocks } = vi.hoisted(() => ({
	mocks: {
		submitChange: vi.fn(),
		publishChange: vi.fn(),
		getPublished: vi.fn(),
		getApiKey: vi.fn<() => string | undefined>(),
		getConfigPath: vi.fn<() => string>(),
		/** The overrides `instructionsClient` handed `getClient`. */
		clientOverrides: vi.fn(),
	},
}));

vi.mock("../src/lib/config.js", () => ({
	getApiKey: mocks.getApiKey,
	getConfigPath: mocks.getConfigPath,
	getBaseUrl: () => undefined,
	getDefaultContext: () => undefined,
	getOutputFormat: () => "table",
}));

vi.mock("../src/lib/client.js", () => {
	const client = {
		instructions: {
			getPublished: mocks.getPublished,
			createDownloadUrl: vi.fn(),
			submitChange: mocks.submitChange,
			publishChange: mocks.publishChange,
		},
		withoutContext: () => client,
	};
	return {
		getClient: (overrides: unknown) => {
			mocks.clientOverrides(overrides);
			return client;
		},
	};
});

class ExitSignal extends Error {
	constructor(readonly code: number) {
		super(`exit ${code}`);
	}
}

function programWithInstructions(): Command {
	const program = new Command("fabric")
		.exitOverride()
		.option("--format <format>", "Output format", "table");
	program.addCommand(buildInstructionsCommand());
	return program;
}

async function runCli(
	argv: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
	let stdout = "";
	let stderr = "";
	const outSpy = vi
		.spyOn(process.stdout, "write")
		.mockImplementation((chunk: unknown) => {
			stdout += String(chunk);
			return true;
		});
	const errSpy = vi
		.spyOn(process.stderr, "write")
		.mockImplementation((chunk: unknown) => {
			stderr += String(chunk);
			return true;
		});
	const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
		code?: number,
	) => {
		throw new ExitSignal(code ?? 0);
	}) as never);

	let code = 0;
	try {
		await programWithInstructions().parseAsync(["instructions", ...argv], {
			from: "user",
		});
	} catch (error) {
		if (error instanceof ExitSignal) {
			code = error.code;
		} else {
			throw error;
		}
	} finally {
		outSpy.mockRestore();
		errSpy.mockRestore();
		exitSpy.mockRestore();
	}
	return { code, stdout, stderr };
}

function sha256(text: string): string {
	return createHash("sha256").update(Buffer.from(text)).digest("hex");
}

/**
 * A tree with a lock, whatever files the caller wants beside it, AND the
 * server response that agrees with that lock.
 *
 * The three are set up together because push checks all three before it reads
 * anything: the lock must name the published snapshot, and its ledger must BE
 * that snapshot's manifest. A test that wants one of them to disagree
 * overrides `mocks.getPublished` afterwards, which is exactly the shape of
 * the failures worth testing.
 */
async function syncedTree(
	ledger: Record<string, string>,
	actual: Record<string, string> = ledger,
): Promise<string> {
	const dest = await mkdtemp(path.join(tmpdir(), "fabric-push-cmd-"));
	for (const [relative, contents] of Object.entries(actual)) {
		const target = path.join(dest, relative);
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, contents);
	}
	const lock: InstructionsLock = {
		version: 1,
		projectId: "proj-1",
		snapshotId: "snap-7",
		snapshotVersion: 7,
		digest: "d".repeat(64),
		syncedAt: "2026-09-17T10:00:00.000Z",
		files: Object.fromEntries(
			Object.entries(ledger).map(([key, contents]) => [
				key,
				{ sha256: sha256(contents), mode: 33188 },
			]),
		),
	};
	await mkdir(path.join(dest, ".fabric"), { recursive: true });
	await writeFile(
		path.join(dest, ".fabric", "instructions.lock"),
		`${JSON.stringify(lock, null, 2)}\n`,
	);
	mocks.getPublished.mockResolvedValue(publishedFor(ledger));
	return dest;
}

/** What the server says about the published version the lock names. */
function publishedFor(
	ledger: Record<string, string>,
	overrides: Record<string, unknown> = {},
) {
	return {
		published: true,
		sourceOfTruth: "UPLOAD",
		snapshot: {
			id: "snap-7",
			version: 7,
			digest: "d".repeat(64),
			fileCount: Object.keys(ledger).length,
			publishedAt: "2026-09-17T09:00:00.000Z",
		},
		manifest: Object.entries(ledger).map(([filePath, contents]) => ({
			path: filePath,
			sha256: sha256(contents),
			size: Buffer.byteLength(contents),
			mode: 33188,
			kind: "INSTRUCTIONS",
		})),
		...overrides,
	};
}

/** A `FabricError`-shaped rejection: the SDK reads `code` off the body. */
function refusal(message: string, status: number, code?: string): Error {
	return Object.assign(new Error(message), { status, code });
}

function accepted(overrides: Record<string, unknown> = {}) {
	return {
		snapshotId: "snap-8",
		version: 8,
		baseSnapshotId: "snap-7",
		baseVersion: 7,
		fileCount: 12,
		inheritedCount: 11,
		putCount: 1,
		deleteCount: 0,
		proposalStatus: "PENDING",
		mode: "proposal",
		status: "VALIDATING",
		// A proposal never asks the workflow to publish, so this is false for
		// every default call; the publish tests override it explicitly.
		published: false,
		...overrides,
	};
}

beforeEach(() => {
	mocks.submitChange.mockReset();
	mocks.publishChange.mockReset();
	mocks.getPublished.mockReset();
	mocks.clientOverrides.mockReset();
	mocks.getApiKey.mockReset().mockReturnValue("fab_test");
	mocks.getConfigPath.mockReset().mockReturnValue(OUTSIDE_CONFIG_PATH);
});

describe("preconditions", () => {
	it("refuses a tree that has never been synced, naming the command to run", async () => {
		const dest = await mkdtemp(path.join(tmpdir(), "fabric-push-cmd-"));

		const result = await runCli([
			"push",
			"--project",
			"proj-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(7);
		expect(result.stderr).toContain("fabric instructions sync");
		expect(mocks.submitChange).not.toHaveBeenCalled();
	});

	it("refuses when nothing in the checkout has changed", async () => {
		const dest = await syncedTree({ "AGENTS.md": "one\n" });

		const result = await runCli([
			"push",
			"--project",
			"proj-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(7);
		expect(result.stderr).toContain("Nothing to push");
		expect(mocks.submitChange).not.toHaveBeenCalled();
	});

	// The server caps a change set at 50 and answers with a 400; refusing
	// locally means the developer is told what to do instead without a round
	// trip that carries every file's contents first.
	it("refuses a change set over the cap and points at the tab", async () => {
		const ledger: Record<string, string> = {};
		const actual: Record<string, string> = {};
		for (let i = 0; i < 51; i++) {
			ledger[`rules/${i}.md`] = "before\n";
			actual[`rules/${i}.md`] = "after\n";
		}
		const dest = await syncedTree(ledger, actual);

		const result = await runCli([
			"push",
			"--project",
			"proj-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(7);
		expect(result.stderr).toContain("Too many changes");
		expect(result.stderr).toContain("Coding Instructions tab");
		expect(mocks.submitChange).not.toHaveBeenCalled();
	});

	it("refuses a lock belonging to another project", async () => {
		const dest = await syncedTree({ "AGENTS.md": "one\n" });

		const result = await runCli([
			"push",
			"--project",
			"other",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(7);
		expect(result.stderr).toContain("belongs to project proj-1");
	});
});

describe("the request", () => {
	it("sends the diff against the lock's snapshot, as a proposal by default", async () => {
		mocks.submitChange.mockResolvedValue(accepted());
		const dest = await syncedTree(
			{ "AGENTS.md": "one\n", "gone.md": "two\n" },
			{ "AGENTS.md": "edited\n" },
		);

		const result = await runCli([
			"push",
			"--project",
			"proj-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(0);
		expect(mocks.submitChange).toHaveBeenCalledTimes(1);
		const [projectId, baseSnapshotId, changes, options] =
			mocks.submitChange.mock.calls[0] ?? [];
		expect(projectId).toBe("proj-1");
		// Positional and required: the lock's snapshot, never a default the
		// server picks.
		expect(baseSnapshotId).toBe("snap-7");
		expect(changes).toEqual([
			{
				op: "put",
				path: "AGENTS.md",
				content: "edited\n",
				encoding: "utf8",
			},
			{ op: "delete", path: "gone.md" },
		]);
		expect(options).toEqual({ org: undefined });
	});

	/**
	 * `--publish` is a different CALL, not a flag on the same one.
	 *
	 * The two authorities are two API-key scopes and a scope is checked per
	 * route, so choosing the method here is what makes a key that cannot
	 * publish fail with a scope refusal rather than quietly proposing. If this
	 * ever routed a publish through `submitChange`, the command would silently
	 * do the safe-sounding wrong thing.
	 */
	it("sends --publish through the publish call, not the proposal one", async () => {
		mocks.publishChange.mockResolvedValue(
			accepted({ mode: "publish", proposalStatus: null }),
		);
		const dest = await syncedTree(
			{ "AGENTS.md": "one\n", "gone.md": "two\n" },
			{ "AGENTS.md": "edited\n" },
		);

		const result = await runCli([
			"push",
			"--project",
			"proj-1",
			"--dest",
			dest,
			"--publish",
		]);

		expect(result.code).toBe(0);
		expect(mocks.submitChange).not.toHaveBeenCalled();
		expect(mocks.publishChange).toHaveBeenCalledTimes(1);
		const [projectId, baseSnapshotId, changes, options] =
			mocks.publishChange.mock.calls[0] ?? [];
		expect(projectId).toBe("proj-1");
		// The same base, the same diff: only the authority differs.
		expect(baseSnapshotId).toBe("snap-7");
		expect(changes).toEqual([
			{
				op: "put",
				path: "AGENTS.md",
				content: "edited\n",
				encoding: "utf8",
			},
			{ op: "delete", path: "gone.md" },
		]);
		expect(options).toEqual({ org: undefined });
	});

	// And the default stays the reviewed path: no flag, no publish call.
	it("never touches the publish call without the flag", async () => {
		mocks.submitChange.mockResolvedValue(accepted());
		const dest = await syncedTree(
			{ "AGENTS.md": "one\n" },
			{ "AGENTS.md": "x\n" },
		);

		await runCli(["push", "--project", "proj-1", "--dest", dest]);

		expect(mocks.publishChange).not.toHaveBeenCalled();
	});

	/**
	 * What a publish reports, and what it must not claim.
	 *
	 * The version is not published when the response arrives: the same verify
	 * → secret-scan → publish run a folder upload goes through decides, and
	 * the response normally names a snapshot still VALIDATING. "Published
	 * version 8" there would be a claim this command cannot make.
	 */
	it("says a publish is still validating rather than claiming it landed", async () => {
		mocks.publishChange.mockResolvedValue(
			accepted({
				mode: "publish",
				proposalStatus: null,
				status: "VALIDATING",
			}),
		);
		const dest = await syncedTree(
			{ "AGENTS.md": "one\n" },
			{ "AGENTS.md": "x\n" },
		);

		const result = await runCli([
			"push",
			"--project",
			"proj-1",
			"--dest",
			dest,
			"--publish",
		]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Sent as version 8");
		expect(result.stdout).toContain("once its checks pass");
		expect(result.stdout).not.toContain("pending review");
	});

	it("says so plainly when the version is already published", async () => {
		mocks.publishChange.mockResolvedValue(
			accepted({
				mode: "publish",
				proposalStatus: null,
				status: "READY",
				// `READY` alone is not the claim: this is what the server
				// says once it has re-read the project's pointer and found
				// this snapshot IS it.
				published: true,
			}),
		);
		const dest = await syncedTree(
			{ "AGENTS.md": "one\n" },
			{ "AGENTS.md": "x\n" },
		);

		const result = await runCli([
			"push",
			"--project",
			"proj-1",
			"--dest",
			dest,
			"--publish",
		]);

		expect(result.stdout).toContain("Published version 8");
	});

	/**
	 * READY does not prove the version was published (review finding).
	 *
	 * A publish's auto-publish is a fast-forward
	 * (`publishInstructionSnapshotActivity`, `requireBaseUnmoved`), and it runs
	 * as its own step, normally AFTER this command has already gotten its
	 * response — so `READY` alone does not mean this snapshot won the
	 * project's published pointer. The command cannot tell, at response time,
	 * whether an unpublished READY version is still catching up or has
	 * genuinely lost out to a concurrent edit, so it never guesses with words
	 * like "superseded" or "moved" — it names what it actually knows (the
	 * checks passed) and points at the tab for the rest.
	 */
	it("does not claim a READY publish landed when the server has not observed one", async () => {
		mocks.publishChange.mockResolvedValue(
			accepted({
				mode: "publish",
				proposalStatus: null,
				status: "READY",
				published: false,
			}),
		);
		const dest = await syncedTree(
			{ "AGENTS.md": "one\n" },
			{ "AGENTS.md": "x\n" },
		);

		const result = await runCli([
			"push",
			"--project",
			"proj-1",
			"--dest",
			dest,
			"--publish",
		]);

		expect(result.code).toBe(0);
		expect(result.stdout).not.toContain("Published version");
		expect(result.stdout).not.toContain("superseded");
		expect(result.stdout).not.toContain("moved");
		expect(result.stdout).not.toContain("was not published");
		expect(result.stdout).toContain("passed its checks");
		expect(result.stdout).toContain("Coding Instructions tab");
	});

	it("reports a publish that failed its checks as publishing nothing", async () => {
		mocks.publishChange.mockResolvedValue(
			accepted({
				mode: "publish",
				proposalStatus: null,
				status: "FAILED",
			}),
		);
		const dest = await syncedTree(
			{ "AGENTS.md": "one\n" },
			{ "AGENTS.md": "x\n" },
		);

		const result = await runCli([
			"push",
			"--project",
			"proj-1",
			"--dest",
			dest,
			"--publish",
		]);

		expect(result.stdout).toContain("nothing was published");
	});

	// A dry run has to describe the operation it is standing in for, or
	// `--publish --dry-run` reads as a rehearsal for a proposal.
	it("says what --publish --dry-run would have done, and sends nothing", async () => {
		const dest = await syncedTree(
			{ "AGENTS.md": "one\n" },
			{ "AGENTS.md": "x\n" },
		);

		const result = await runCli([
			"push",
			"--project",
			"proj-1",
			"--dest",
			dest,
			"--publish",
			"--dry-run",
		]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("with no review");
		expect(mocks.publishChange).not.toHaveBeenCalled();
		expect(mocks.submitChange).not.toHaveBeenCalled();
	});

	it("carries an explicit --org", async () => {
		mocks.submitChange.mockResolvedValue(accepted());
		const dest = await syncedTree(
			{ "AGENTS.md": "one\n" },
			{ "AGENTS.md": "x\n" },
		);

		await runCli([
			"push",
			"--project",
			"proj-1",
			"--dest",
			dest,
			"--org",
			"example-org",
		]);

		expect(mocks.submitChange.mock.calls[0]?.[3]).toMatchObject({
			org: "example-org",
		});
	});

	// Retries used to be off here: the change route created a snapshot row
	// per POST, so a retried push opened a second proposal for one edit. The
	// route now deduplicates by the content of the change set and returns the
	// proposal the first attempt opened, so a push that lost its response is
	// repaired by the retry instead of failing.
	it("leaves the SDK's retry policy alone", async () => {
		mocks.submitChange.mockResolvedValue(accepted());
		const dest = await syncedTree(
			{ "AGENTS.md": "one\n" },
			{ "AGENTS.md": "x\n" },
		);

		await runCli(["push", "--project", "proj-1", "--dest", dest]);

		expect(mocks.clientOverrides).toHaveBeenCalled();
		for (const [overrides] of mocks.clientOverrides.mock.calls) {
			expect(overrides).not.toMatchObject({
				retry: { maxRetries: 0 },
			});
		}
	});

	it("sends nothing on --dry-run and still prints the plan", async () => {
		const dest = await syncedTree(
			{ "AGENTS.md": "one\n" },
			{ "AGENTS.md": "x\n" },
		);

		const result = await runCli([
			"push",
			"--project",
			"proj-1",
			"--dest",
			dest,
			"--dry-run",
		]);

		expect(result.code).toBe(0);
		expect(mocks.submitChange).not.toHaveBeenCalled();
		expect(result.stdout).toContain("Would send");
		expect(result.stdout).toContain("AGENTS.md");
	});

	it("says the proposal is pending review when it is", async () => {
		mocks.submitChange.mockResolvedValue(accepted());
		const dest = await syncedTree(
			{ "AGENTS.md": "one\n" },
			{ "AGENTS.md": "x\n" },
		);

		const result = await runCli([
			"push",
			"--project",
			"proj-1",
			"--dest",
			dest,
		]);

		expect(result.stdout).toContain("pending review");
	});

	/**
	 * A retried push can be answered with a proposal that is no longer
	 * pending — the attempt it is repeating was closed out, or its validation
	 * rejected it. Printing "pending review" over that verdict tells the
	 * developer to wait for a review that will never come.
	 */
	it("reports a closed-out proposal instead of claiming it is pending", async () => {
		mocks.submitChange.mockResolvedValue(
			accepted({ proposalStatus: "REJECTED", status: "REJECTED" }),
		);
		const dest = await syncedTree(
			{ "AGENTS.md": "one\n" },
			{ "AGENTS.md": "x\n" },
		);

		const result = await runCli([
			"push",
			"--project",
			"proj-1",
			"--dest",
			dest,
		]);

		expect(result.stdout).not.toContain("pending review");
		expect(result.stdout).toContain("push again");
	});

	/**
	 * The remaining answers a replay can come back with, and the rule every
	 * one of them obeys: never advise an action the server's content dedup
	 * will swallow. "Send it again" is only honest when the proposal has
	 * stopped being PENDING, because a PENDING row is exactly what the next
	 * push would match.
	 */
	it("says an earlier attempt is still sending when the row is still receiving", async () => {
		mocks.submitChange.mockResolvedValue(
			accepted({ proposalStatus: "PENDING", status: "RECEIVING" }),
		);
		const dest = await syncedTree(
			{ "AGENTS.md": "one\n" },
			{ "AGENTS.md": "x\n" },
		);

		const result = await runCli([
			"push",
			"--project",
			"proj-1",
			"--dest",
			dest,
		]);

		expect(result.stdout).toContain("still sending");
		expect(result.stdout).not.toContain("pending review");
		// No push may be offered here at any age. The row is still PENDING,
		// so the next push dedups straight back onto it, and nothing in the
		// server closes a RECEIVING row out on a push's behalf — the tab
		// opens proposals through the same query and holds its upload
		// capabilities for an hour, so one that looks stalled from the
		// command line may be one somebody is still filling. Only the two
		// exits that do exist are named.
		expect(result.stdout).not.toContain("push again");
		expect(result.stdout).toContain(
			"cancel it in the project's Coding Instructions tab",
		);
		expect(result.stdout).toContain("six hours");
	});

	it("offers the retry, not a fresh push, when the checks failed", async () => {
		mocks.submitChange.mockResolvedValue(
			accepted({ proposalStatus: "PENDING", status: "FAILED" }),
		);
		const dest = await syncedTree(
			{ "AGENTS.md": "one\n" },
			{ "AGENTS.md": "x\n" },
		);

		const result = await runCli([
			"push",
			"--project",
			"proj-1",
			"--dest",
			dest,
		]);

		expect(result.stdout).toContain("did not pass its checks");
		expect(result.stdout).not.toContain("pending review");
		// NOT "push again": a FAILED proposal keeps `proposalStatus:
		// "PENDING"`, so the next push dedups straight back onto it. The tab's
		// Try again is the only thing that moves it.
		expect(result.stdout).not.toContain("push again");
	});

	// A row that vanished between the finalizer and the re-read reports
	// `proposalStatus: null` beside the finalizer's last status. There is no
	// version left to retry or cancel, so this must fall through to "push
	// again" rather than pointing at the tab.
	it("asks for a fresh push when the failed row is already gone", async () => {
		mocks.submitChange.mockResolvedValue(
			accepted({ proposalStatus: null, status: "FAILED" }),
		);
		const dest = await syncedTree(
			{ "AGENTS.md": "one\n" },
			{ "AGENTS.md": "x\n" },
		);

		const result = await runCli([
			"push",
			"--project",
			"proj-1",
			"--dest",
			dest,
		]);

		expect(result.stdout).toContain("push again");
		expect(result.stdout).not.toContain("did not pass its checks");
		expect(result.stdout).not.toContain("still sending");
	});

	it("points an already-approved proposal at sync rather than at another push", async () => {
		mocks.submitChange.mockResolvedValue(
			accepted({ proposalStatus: "APPROVED", status: "READY" }),
		);
		const dest = await syncedTree(
			{ "AGENTS.md": "one\n" },
			{ "AGENTS.md": "x\n" },
		);

		const result = await runCli([
			"push",
			"--project",
			"proj-1",
			"--dest",
			dest,
		]);

		expect(result.stdout).toContain("already been approved");
		expect(result.stdout).toContain("fabric instructions sync");
		expect(result.stdout).not.toContain("pending review");
	});
});

describe("the lock is never written", () => {
	it("leaves it exactly as it was after a successful proposal", async () => {
		mocks.submitChange.mockResolvedValue(accepted());
		const dest = await syncedTree(
			{ "AGENTS.md": "one\n" },
			{ "AGENTS.md": "x\n" },
		);
		const lockFile = path.join(dest, ".fabric", "instructions.lock");
		const before = await readFile(lockFile, "utf8");

		await runCli(["push", "--project", "proj-1", "--dest", dest]);

		expect(await readFile(lockFile, "utf8")).toBe(before);
	});
});

describe("refusals become sentences", () => {
	it("tells the developer to sync first on PULL_FIRST", async () => {
		mocks.submitChange.mockRejectedValue(
			refusal("The published version changed", 409, "PULL_FIRST"),
		);
		const dest = await syncedTree(
			{ "AGENTS.md": "one\n" },
			{ "AGENTS.md": "x\n" },
		);

		const result = await runCli([
			"push",
			"--project",
			"proj-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(7);
		expect(result.stderr).toContain(
			"published instructions moved past your last sync",
		);
		expect(result.stderr).toContain("fabric instructions sync");
	});

	it("names the repository when the project is repository-backed", async () => {
		mocks.submitChange.mockRejectedValue(
			refusal(
				"This project's coding instructions come from its repository.",
				412,
				"REPOSITORY_SOURCE_OF_TRUTH",
			),
		);
		const dest = await syncedTree(
			{ "AGENTS.md": "one\n" },
			{ "AGENTS.md": "x\n" },
		);

		const result = await runCli([
			"push",
			"--project",
			"proj-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(7);
		expect(result.stderr).toContain("repository");
		expect(result.stderr).toContain("nothing was sent");
	});

	it("passes the server's own words through for a proposal cap", async () => {
		mocks.submitChange.mockRejectedValue(
			refusal(
				"You already have five active coding-instructions proposals for this project.",
				409,
				"PROPOSAL_PROPOSER_LIMIT",
			),
		);
		const dest = await syncedTree(
			{ "AGENTS.md": "one\n" },
			{ "AGENTS.md": "x\n" },
		);

		const result = await runCli([
			"push",
			"--project",
			"proj-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(7);
		expect(result.stderr).toContain("five active coding-instructions");
	});

	/**
	 * A key without `instructions:publish` is the refusal a developer will
	 * actually hit the first time they try `--publish`, and it has to name the
	 * scope so they know what to ask for. Same 403, same documented exit code
	 * 5, and it must not be flattened into the generic 1.
	 */
	it("keeps the documented exit code when the key cannot publish", async () => {
		mocks.publishChange.mockRejectedValue(
			refusal("Missing required scope: instructions:publish", 403),
		);
		const dest = await syncedTree(
			{ "AGENTS.md": "one\n" },
			{ "AGENTS.md": "x\n" },
		);

		const result = await runCli([
			"push",
			"--project",
			"proj-1",
			"--dest",
			dest,
			"--publish",
		]);

		expect(result.code).toBe(5);
		expect(result.stderr).toContain("instructions:publish");
	});

	// A missing scope and a missing permission both arrive as a 403; the
	// documented exit code for that is 5, and it must not be flattened into
	// the generic 1 by the reason-code switch above.
	it("keeps the documented exit code for a permission refusal", async () => {
		mocks.submitChange.mockRejectedValue(
			refusal("Missing required scope: instructions:write", 403),
		);
		const dest = await syncedTree(
			{ "AGENTS.md": "one\n" },
			{ "AGENTS.md": "x\n" },
		);

		const result = await runCli([
			"push",
			"--project",
			"proj-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(5);
		expect(result.stderr).toContain("instructions:write");
	});
});

/**
 * Everything the command decides BEFORE it opens a file, and the reason it
 * decides it there.
 *
 * The lock is an ordinary JSON file in the checkout, so anything that can
 * write to the working tree can add a path to its ledger. Reading that ledger
 * on trust turns push into a way to exfiltrate whatever was added, so the
 * published manifest is fetched first and is the authority for which paths
 * may be touched.
 */
describe("what push checks before it reads a file", () => {
	it("refuses a lock whose ledger names a file the published version does not", async () => {
		const dest = await syncedTree(
			{ "AGENTS.md": "one\n", "private-notes.md": "the secret\n" },
			{ "AGENTS.md": "edited\n", "private-notes.md": "the secret\n" },
		);
		// The server's manifest has only the real instruction file; the lock
		// claims both.
		mocks.getPublished.mockResolvedValue(
			publishedFor({ "AGENTS.md": "one\n" }),
		);

		const result = await runCli([
			"push",
			"--project",
			"proj-1",
			"--dest",
			dest,
		]);

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("private-notes.md");
		expect(result.stderr).toContain("fabric instructions sync");
		expect(mocks.submitChange).not.toHaveBeenCalled();
	});

	it("refuses a lock whose recorded hash is not the published file's", async () => {
		const dest = await syncedTree(
			{ "AGENTS.md": "tampered\n" },
			{ "AGENTS.md": "edited\n" },
		);
		mocks.getPublished.mockResolvedValue(
			publishedFor({ "AGENTS.md": "one\n" }),
		);

		const result = await runCli([
			"push",
			"--project",
			"proj-1",
			"--dest",
			dest,
		]);

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("does not match the published version");
		expect(mocks.submitChange).not.toHaveBeenCalled();
	});

	/**
	 * End to end, because the consequence is a SUCCESSFUL push rather than a
	 * crash: with `rules.md` taken out of the ledger the command would have
	 * sent a one-file proposal, said so, and exited zero, while the edit to
	 * `rules.md` sat in the checkout unmentioned.
	 */
	it("refuses a lock that omits a published file", async () => {
		const dest = await syncedTree(
			{ "AGENTS.md": "one\n" },
			{ "AGENTS.md": "edited\n", "rules.md": "edited locally\n" },
		);
		// The published version has both; the lock lists only the first.
		mocks.getPublished.mockResolvedValue(
			publishedFor({ "AGENTS.md": "one\n", "rules.md": "two\n" }),
		);

		const result = await runCli([
			"push",
			"--project",
			"proj-1",
			"--dest",
			dest,
		]);

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("rules.md");
		expect(result.stderr).toContain("fabric instructions sync");
		expect(mocks.submitChange).not.toHaveBeenCalled();
	});

	// Decided locally now, from the manifest call that had to happen anyway,
	// so a stale checkout costs no upload at all.
	it("refuses locally when the published version has moved past the lock", async () => {
		const dest = await syncedTree(
			{ "AGENTS.md": "one\n" },
			{ "AGENTS.md": "edited\n" },
		);
		mocks.getPublished.mockResolvedValue(
			publishedFor(
				{ "AGENTS.md": "one\n" },
				{
					snapshot: {
						id: "snap-9",
						version: 9,
						digest: "e".repeat(64),
						fileCount: 1,
						publishedAt: null,
					},
				},
			),
		);

		const result = await runCli([
			"push",
			"--project",
			"proj-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(7);
		expect(result.stderr).toContain("fabric instructions sync");
		expect(mocks.submitChange).not.toHaveBeenCalled();
	});

	it("refuses a project with nothing published", async () => {
		const dest = await syncedTree(
			{ "AGENTS.md": "one\n" },
			{ "AGENTS.md": "edited\n" },
		);
		mocks.getPublished.mockResolvedValue({
			published: false,
			sourceOfTruth: "UPLOAD",
		});

		const result = await runCli([
			"push",
			"--project",
			"proj-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(4);
		expect(mocks.submitChange).not.toHaveBeenCalled();
	});
});
