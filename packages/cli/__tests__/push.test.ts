/**
 * `fabric instructions push` plan computation (Fizzy #2539).
 *
 * The plan is the whole of the command's judgement — what leaves the machine
 * and what does not — so every branch is pinned here: which locked paths turn
 * into a `put`, which into a `delete`, which are silently correct, how bytes
 * are encoded, and what a path the tool refuses to touch does to the run.
 *
 * The refusal cases matter more than usual on this command. `sync` reads a
 * server manifest and writes files; `push` reads local files and SENDS them, so
 * a lock naming `.git/config` or a symlinked instruction file is an
 * exfiltration path rather than an overwrite.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { InstructionManifestEntry } from "@fabricorg/sdk";
import { describe, expect, it } from "vitest";
import type { InstructionsLock } from "../src/lib/instructions/lock.js";
import { computePushPlan } from "../src/lib/instructions/push.js";
import { resolveExistingRoot } from "../src/lib/instructions/safe-write.js";

function sha256(text: string): string {
	return createHash("sha256").update(Buffer.from(text)).digest("hex");
}

async function makeTree(files: Record<string, string> = {}): Promise<string> {
	const dest = await mkdtemp(path.join(tmpdir(), "fabric-push-"));
	for (const [relative, contents] of Object.entries(files)) {
		const target = path.join(dest, relative);
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, contents);
	}
	return resolveExistingRoot(dest);
}

/**
 * The lock AND the published manifest it claims to record, from one record.
 *
 * They are built together because agreeing is the normal case: the ledger is
 * what the last sync wrote out of that manifest. A test that wants them to
 * DISAGREE says so explicitly, which is the point — the disagreement is what
 * `computePushPlan` refuses on, and it is the only thing standing between a
 * tampered lock and an upload of whatever it names.
 */
function lockAndManifest(files: Record<string, string>): {
	lock: InstructionsLock;
	manifest: InstructionManifestEntry[];
} {
	return { lock: lockOf(files), manifest: manifestOf(files) };
}

/** The server's manifest for the same files. */
function manifestOf(files: Record<string, string>): InstructionManifestEntry[] {
	return Object.entries(files).map(([path, contents]) => ({
		path,
		sha256: sha256(contents),
		size: Buffer.byteLength(contents),
		mode: 33188,
		kind: "INSTRUCTIONS" as const,
	}));
}

/** A lock whose ledger records each path's hash as it is given here. */
function lockOf(files: Record<string, string>): InstructionsLock {
	const locked: InstructionsLock["files"] = {};
	for (const [key, contents] of Object.entries(files)) {
		locked[key] = { sha256: sha256(contents), mode: 33188 };
	}
	return {
		version: 1,
		projectId: "project-1",
		snapshotId: "snap-7",
		snapshotVersion: 7,
		digest: "d".repeat(64),
		syncedAt: "2026-09-17T10:00:00.000Z",
		files: locked,
	};
}

describe("the push plan against the lock's ledger", () => {
	it("sends nothing for a file that still matches the lock", async () => {
		const root = await makeTree({ "AGENTS.md": "one\n" });

		const plan = await computePushPlan({
			root,
			...lockAndManifest({ "AGENTS.md": "one\n" }),
		});

		expect(plan.changes).toEqual([]);
		expect(plan.unchanged).toEqual(["AGENTS.md"]);
	});

	it("sends an edited file as a put carrying its whole new content", async () => {
		const root = await makeTree({ "AGENTS.md": "edited\n" });

		const plan = await computePushPlan({
			root,
			...lockAndManifest({ "AGENTS.md": "one\n" }),
		});

		expect(plan.changes).toEqual([
			{
				op: "put",
				path: "AGENTS.md",
				content: "edited\n",
				encoding: "utf8",
			},
		]);
		expect(plan.entries).toEqual([
			{ path: "AGENTS.md", action: "put", size: 7 },
		]);
	});

	it("sends a deleted file as a delete", async () => {
		const root = await makeTree({ "AGENTS.md": "one\n" });

		const plan = await computePushPlan({
			root,
			...lockAndManifest({
				"AGENTS.md": "one\n",
				".claude/skills/a.md": "s",
			}),
		});

		expect(plan.changes).toEqual([
			{ op: "delete", path: ".claude/skills/a.md" },
		]);
	});

	// A push reads local files and sends them, so "text" cannot be assumed.
	// The round trip is the test rather than a guess at the bytes: a lossy
	// decode would send U+FFFD where the file has a byte.
	it("base64-encodes bytes that are not valid UTF-8", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "fabric-push-bin-"));
		const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x41]);
		await writeFile(path.join(root, "logo.png"), bytes);
		const canonical = await resolveExistingRoot(root);

		const plan = await computePushPlan({
			root: canonical,
			...lockAndManifest({ "logo.png": "placeholder" }),
		});

		expect(plan.changes).toEqual([
			{
				op: "put",
				path: "logo.png",
				content: bytes.toString("base64"),
				encoding: "base64",
			},
		]);
	});

	it("reports changed and deleted paths in sorted order", async () => {
		const root = await makeTree({
			"AGENTS.md": "edited\n",
			".claude/skills/b.md": "edited\n",
		});

		const plan = await computePushPlan({
			root,
			...lockAndManifest({
				"AGENTS.md": "one\n",
				".claude/skills/b.md": "two\n",
				"gone.md": "three\n",
			}),
		});

		expect(plan.entries.map((e) => e.path)).toEqual([
			".claude/skills/b.md",
			"AGENTS.md",
			"gone.md",
		]);
	});
});

describe("--add", () => {
	it("sends a file the lock does not name", async () => {
		const root = await makeTree({
			"AGENTS.md": "one\n",
			".claude/skills/new.md": "new\n",
		});

		const plan = await computePushPlan({
			root,
			...lockAndManifest({ "AGENTS.md": "one\n" }),
			added: [".claude/skills/new.md"],
		});

		expect(plan.changes).toEqual([
			{
				op: "put",
				path: ".claude/skills/new.md",
				content: "new\n",
				encoding: "utf8",
			},
		]);
	});

	// Naming a locked path twice would be a change set the server refuses
	// outright ("The same file is changed twice"), for an operation that was
	// already going to happen on its own.
	it("does not duplicate a path the lock already names", async () => {
		const root = await makeTree({ "AGENTS.md": "edited\n" });

		const plan = await computePushPlan({
			root,
			...lockAndManifest({ "AGENTS.md": "one\n" }),
			added: ["AGENTS.md"],
		});

		expect(plan.changes).toHaveLength(1);
	});

	it("refuses a path with nothing at it", async () => {
		const root = await makeTree({ "AGENTS.md": "one\n" });

		await expect(
			computePushPlan({
				root,
				...lockAndManifest({ "AGENTS.md": "one\n" }),
				added: ["missing.md"],
			}),
		).rejects.toThrow(/there is no file at missing\.md/);
	});

	it("refuses a path that escapes the destination", async () => {
		const root = await makeTree({ "AGENTS.md": "one\n" });

		await expect(
			computePushPlan({
				root,
				...lockAndManifest({ "AGENTS.md": "one\n" }),
				added: ["../outside.md"],
			}),
		).rejects.toThrow(/Refusing to push/);
	});

	it("refuses a reserved root", async () => {
		const root = await makeTree({ "AGENTS.md": "one\n" });

		await expect(
			computePushPlan({
				root,
				...lockAndManifest({ "AGENTS.md": "one\n" }),
				added: [".git/config"],
			}),
		).rejects.toThrow(/Refusing to push/);
	});
});

describe("a lock this tool will not read from", () => {
	it("refuses a ledger naming a reserved path", async () => {
		const root = await makeTree({ "AGENTS.md": "one\n" });

		await expect(
			computePushPlan({
				root,
				...lockAndManifest({ ".fabric/instructions.lock": "{}" }),
			}),
		).rejects.toThrow(/Refusing to push/);
	});

	it("refuses a ledger naming a traversing path", async () => {
		const root = await makeTree({ "AGENTS.md": "one\n" });

		await expect(
			computePushPlan({
				root,
				...lockAndManifest({ "../outside.md": "x" }),
			}),
		).rejects.toThrow(/Refusing to push/);
	});

	it("refuses two ledger paths one filesystem cannot tell apart", async () => {
		const root = await makeTree({ "AGENTS.md": "one\n" });

		await expect(
			computePushPlan({
				root,
				...lockAndManifest({
					"AGENTS.md": "one\n",
					"agents.md": "one\n",
				}),
			}),
		).rejects.toThrow(/Refusing to push/);
	});

	// The reason the reads go through the guarded walk: a symlink standing
	// where an instruction file belongs would otherwise be hashed, read and
	// UPLOADED, whatever it points at.
	it("refuses a symlink standing where an instruction file belongs", async () => {
		const root = await makeTree({ "secret.txt": "credentials\n" });
		await symlink(
			path.join(root, "secret.txt"),
			path.join(root, "AGENTS.md"),
		);

		await expect(
			computePushPlan({
				root,
				...lockAndManifest({ "AGENTS.md": "one\n" }),
			}),
		).rejects.toThrow(/Refusing to sync|Refusing to push/);
	});
});

/**
 * The lock is an ordinary JSON file inside the checkout, so anything that can
 * write to the working tree can write to it — a hostile dependency's install
 * script, a malicious patch, a compromised editor extension. A command that
 * read its ledger on trust would read and upload whatever that ledger named,
 * which makes it an exfiltration primitive rather than a sync record.
 *
 * So the server's manifest for the snapshot the lock CLAIMS decides which
 * paths may be touched, and it is checked before a single file is opened.
 */
describe("a lock that does not match the published manifest", () => {
	it("refuses an extra path, before reading anything", async () => {
		const root = await makeTree({
			"AGENTS.md": "one\n",
			"private-notes.md": "the secret\n",
		});
		const { lock } = lockAndManifest({
			"AGENTS.md": "one\n",
			"private-notes.md": "the secret\n",
		});

		await expect(
			computePushPlan({
				root,
				lock,
				// The published version never contained the second file.
				manifest: manifestOf({ "AGENTS.md": "one\n" }),
			}),
		).rejects.toThrow(/does not match the published version/);
	});

	it("names the offending path and says how to fix it", async () => {
		const root = await makeTree({ "AGENTS.md": "one\n" });
		const { lock } = lockAndManifest({
			"AGENTS.md": "one\n",
			"private-notes.md": "x\n",
		});

		const error = await computePushPlan({
			root,
			lock,
			manifest: manifestOf({ "AGENTS.md": "one\n" }),
		}).catch((e: unknown) => e);

		expect((error as Error).message).toContain("private-notes.md");
		expect((error as Error).message).toContain("fabric instructions sync");
		expect((error as Error).message).toContain("nothing was sent");
	});

	// Not an attack, but just as unusable: the diff is "what changed since the
	// last sync", and a ledger that disagrees with the version it claims to
	// record cannot answer that.
	it("refuses a hash that is not the published file's", async () => {
		const root = await makeTree({ "AGENTS.md": "one\n" });
		const { lock } = lockAndManifest({ "AGENTS.md": "tampered\n" });

		await expect(
			computePushPlan({
				root,
				lock,
				manifest: manifestOf({ "AGENTS.md": "one\n" }),
			}),
		).rejects.toThrow(/does not match the published version/);
	});

	/**
	 * The quiet direction, and the one a one-way check missed entirely.
	 *
	 * Deleting an entry from the ledger refuses nothing by itself — it makes
	 * the file INVISIBLE. The diff walks only what the lock names, so a local
	 * edit to `rules.md` is dropped from the proposal, a local deletion of it
	 * is never reported, and a checkout with that one file changed reports
	 * "Nothing to push". No alarm anywhere, and a proposal that is not the
	 * diff it claims to be.
	 */
	it("refuses a lock that omits a published file", async () => {
		const root = await makeTree({
			"AGENTS.md": "one\n",
			"rules.md": "edited locally\n",
		});
		// Correct in every respect except that `rules.md` was taken out of it.
		const { lock } = lockAndManifest({ "AGENTS.md": "one\n" });

		const error = await computePushPlan({
			root,
			lock,
			manifest: manifestOf({
				"AGENTS.md": "one\n",
				"rules.md": "two\n",
			}),
		}).catch((e: unknown) => e);

		expect((error as Error).message).toContain(
			"does not match the published version",
		);
		expect((error as Error).message).toContain("rules.md");
		expect((error as Error).message).toContain("fabric instructions sync");
		expect((error as Error).message).toContain("nothing was sent");
	});

	// An `--add` path is NOT in the manifest by definition — that is what
	// --add is for — so the check must not refuse it.
	it("still allows an explicit --add of a path the manifest does not have", async () => {
		const root = await makeTree({
			"AGENTS.md": "one\n",
			"docs/new.md": "fresh\n",
		});

		const plan = await computePushPlan({
			root,
			...lockAndManifest({ "AGENTS.md": "one\n" }),
			added: ["docs/new.md"],
		});

		expect(plan.changes).toEqual([
			{
				op: "put",
				path: "docs/new.md",
				content: "fresh\n",
				encoding: "utf8",
			},
		]);
	});
});
