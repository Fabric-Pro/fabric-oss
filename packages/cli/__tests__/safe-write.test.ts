/**
 * The one guarded writer (Fizzy #2539, review round 1 finding 2).
 *
 * Every file this feature creates goes through here — instruction files, the
 * lock, and the Claude Code settings file. Before, three writers existed and
 * only one was guarded, so `.claude -> ..` or `.fabric -> ..` in a checkout
 * turned `init` and `sync` into writes outside the destination. These cases
 * are the reason the writer is shared.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
	access,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertSafeTarget,
	assertWritableTarget,
	deleteFileSafely,
	isAllowedMode,
	resolveDestinationRoot,
	resolvesInside,
	writeFileSafely,
} from "../src/lib/instructions/safe-write.js";

function sha256(text: string): string {
	return createHash("sha256").update(Buffer.from(text)).digest("hex");
}

async function makeTree(): Promise<string> {
	return resolveDestinationRoot(
		await mkdtemp(path.join(tmpdir(), "fabric-safe-")),
	);
}

function bytes(text: string): Uint8Array {
	return new Uint8Array(Buffer.from(text));
}

describe("resolveDestinationRoot", () => {
	it("creates a missing destination and canonicalises it", async () => {
		const parent = await mkdtemp(path.join(tmpdir(), "fabric-safe-"));
		const nested = path.join(parent, "checkout");

		const root = await resolveDestinationRoot(nested);

		await expect(access(root, constants.F_OK)).resolves.toBeUndefined();
		// Canonical: equal to its own realpath, whatever the input spelling.
		expect(root).toBe(await resolveDestinationRoot(root));
	});

	/**
	 * A `--dest` reached through a symlink is legitimate and common —
	 * `/tmp` itself is a symlink on macOS. It is canonicalised rather than
	 * refused; everything BELOW the canonical root is held to the strict
	 * rule.
	 */
	it("resolves a symlinked destination instead of refusing it", async () => {
		const parent = await mkdtemp(path.join(tmpdir(), "fabric-safe-"));
		const real = path.join(parent, "real");
		const link = path.join(parent, "link");
		await mkdir(real);
		await symlink(real, link, "dir");

		const root = await resolveDestinationRoot(link);

		await writeFileSafely({
			root,
			relativePath: "AGENTS.md",
			bytes: bytes("hello"),
		});
		expect(await readFile(path.join(real, "AGENTS.md"), "utf8")).toBe(
			"hello",
		);
	});
});

describe("assertSafeTarget", () => {
	it("accepts a path with no links on the way down", async () => {
		const root = await makeTree();
		await mkdir(path.join(root, "docs"), { recursive: true });
		expect((await assertSafeTarget(root, "docs/a.md")).ok).toBe(true);
	});

	it("refuses a path that resolves to the destination itself", async () => {
		const root = await makeTree();
		const result = await assertSafeTarget(root, "..");
		expect(result.ok).toBe(false);
	});

	it.each([
		["a symlinked directory", "linked", "linked/a.md"],
		[
			"a symlinked dotfile directory",
			".claude",
			".claude/settings.local.json",
		],
		["a symlinked Codex directory", ".codex", ".codex/hooks.json"],
		["a symlinked lock directory", ".fabric", ".fabric/instructions.lock"],
	])("refuses to write through %s", async (_label, linkName, target) => {
		const root = await makeTree();
		const outside = await makeTree();
		await symlink(outside, path.join(root, linkName), "dir");

		const result = await assertSafeTarget(root, target);

		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toBe("symlink");
	});

	it("refuses a symlinked file target", async () => {
		const root = await makeTree();
		const outside = await makeTree();
		const victim = path.join(outside, "victim.md");
		await writeFile(victim, "original");
		await symlink(victim, path.join(root, "AGENTS.md"));

		const result = await assertSafeTarget(root, "AGENTS.md");

		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toBe("symlink");
	});
});

describe("writeFileSafely", () => {
	it("writes bytes exactly and applies an allowed mode", async () => {
		const root = await makeTree();

		await writeFileSafely({
			root,
			relativePath: "scripts/run.sh",
			bytes: bytes("#!/bin/sh\nexit 0\n"),
			mode: 0o100755,
		});

		expect(await readFile(path.join(root, "scripts/run.sh"))).toEqual(
			Buffer.from("#!/bin/sh\nexit 0\n"),
		);
		if (process.platform !== "win32") {
			expect(
				(await stat(path.join(root, "scripts/run.sh"))).mode & 0o777,
			).toBe(0o755);
		}
	});

	it("leaves no temp file behind", async () => {
		const root = await makeTree();
		await writeFileSafely({
			root,
			relativePath: "AGENTS.md",
			bytes: bytes("x"),
		});
		expect(await readdir(root)).toEqual(["AGENTS.md"]);
	});

	it("refuses a symlinked ancestor and writes nothing outside", async () => {
		const root = await makeTree();
		const outside = await makeTree();
		await symlink(outside, path.join(root, ".claude"), "dir");

		await expect(
			writeFileSafely({
				root,
				relativePath: ".claude/settings.local.json",
				bytes: bytes("{}"),
			}),
		).rejects.toThrow(/symlink/);

		expect(await readdir(outside)).toEqual([]);
	});

	it("refuses when a path component is an existing file, not a directory", async () => {
		const root = await makeTree();
		await writeFile(path.join(root, "docs"), "I am a file");

		await expect(
			writeFileSafely({
				root,
				relativePath: "docs/a.md",
				bytes: bytes("x"),
			}),
		).rejects.toThrow(/not a directory/);
	});

	it.each([[0o100777], [0o104755], [0o100666], [0o100600]])(
		"refuses file mode %s",
		async (mode) => {
			const root = await makeTree();
			await expect(
				writeFileSafely({
					root,
					relativePath: "a.md",
					bytes: bytes("x"),
					mode,
				}),
			).rejects.toThrow(/only 644 and 755 are accepted/);
			expect(await readdir(root)).toEqual([]);
		},
	);
});

describe("isAllowedMode", () => {
	it.each([[null], [undefined], [0o100644], [0o100755], [0o644], [0o755]])(
		"accepts %s",
		(mode) => {
			expect(isAllowedMode(mode as number | null)).toBe(true);
		},
	);

	it.each([
		// setuid, setgid, sticky and world-write all survived a 0o7777 mask.
		[0o104755],
		[0o102755],
		[0o101755],
		[0o100777],
		[0o100666],
		[0o100700],
		[-1],
		[1.5],
		// A directory or a symlink mode is not a regular file.
		[0o040755],
		[0o120755],
	])("refuses %s", (mode) => {
		expect(isAllowedMode(mode)).toBe(false);
	});
});

/**
 * Review round 2, finding 2: the delete is bound to the OBJECT now, not only
 * to the path. Planning hashes a departed file, then a download, an extract
 * and every write happen before the unlink runs — an editor saving in that
 * window used to lose its work to a hash that no longer described the file.
 */
describe("deleteFileSafely", () => {
	it("removes a file that still matches its hash", async () => {
		const root = await makeTree();
		await writeFile(path.join(root, "gone.md"), "x");
		expect(await deleteFileSafely(root, "gone.md", sha256("x"))).toBe(
			"deleted",
		);
		await expect(
			access(path.join(root, "gone.md"), constants.F_OK),
		).rejects.toThrow();
	});

	it("treats a missing file as nothing to do", async () => {
		const root = await makeTree();
		expect(
			await deleteFileSafely(root, "never-existed.md", sha256("x")),
		).toBe("missing");
	});

	it("keeps a file that was edited after the plan hashed it", async () => {
		const root = await makeTree();
		const file = path.join(root, "notes.md");
		await writeFile(file, "edited since planning");

		expect(
			await deleteFileSafely(
				root,
				"notes.md",
				sha256("what was planned"),
			),
		).toBe("modified");
		expect(await readFile(file, "utf8")).toBe("edited since planning");
	});

	it("refuses a symlink rather than unlinking the link", async () => {
		const root = await makeTree();
		const outside = await makeTree();
		await writeFile(path.join(outside, "victim.md"), "original");
		await symlink(path.join(outside, "victim.md"), path.join(root, "a.md"));

		await expect(
			deleteFileSafely(root, "a.md", sha256("original")),
		).rejects.toThrow(/symlink/);
		expect(await readFile(path.join(outside, "victim.md"), "utf8")).toBe(
			"original",
		);
	});

	it("refuses a directory standing where a file was", async () => {
		const root = await makeTree();
		await mkdir(path.join(root, "a.md"));

		await expect(
			deleteFileSafely(root, "a.md", sha256("x")),
		).rejects.toThrow(/not a regular file/);
	});

	it("refuses to unlink through a symlinked directory", async () => {
		const root = await makeTree();
		const outside = await makeTree();
		await writeFile(path.join(outside, "victim.md"), "original");
		await symlink(outside, path.join(root, "linked"), "dir");

		await expect(
			deleteFileSafely(root, "linked/victim.md", sha256("original")),
		).rejects.toThrow(/symlink/);
		expect(await readFile(path.join(outside, "victim.md"), "utf8")).toBe(
			"original",
		);
	});
});

/**
 * Review round 2, finding 8: `assertSafeTarget` answers "may this land here"
 * and says nothing about what is already there. A directory passed it and was
 * only refused by the eventual rename — after earlier entries in the same plan
 * had been written.
 */
describe("assertWritableTarget", () => {
	it("accepts an absent path and an ordinary file", async () => {
		const root = await makeTree();
		await writeFile(path.join(root, "there.md"), "x");

		expect((await assertWritableTarget(root, "there.md")).ok).toBe(true);
		expect((await assertWritableTarget(root, "absent.md")).ok).toBe(true);
	});

	it("refuses a directory at a file path", async () => {
		const root = await makeTree();
		await mkdir(path.join(root, "AGENTS.md"));

		const check = await assertWritableTarget(root, "AGENTS.md");
		expect(check).toMatchObject({
			ok: false,
			reason: "not_a_regular_file",
		});
	});

	it("refuses a symlink at a file path", async () => {
		const root = await makeTree();
		const outside = await makeTree();
		await writeFile(path.join(outside, "real.md"), "x");
		await symlink(path.join(outside, "real.md"), path.join(root, "a.md"));

		const check = await assertWritableTarget(root, "a.md");
		expect(check).toMatchObject({ ok: false, reason: "symlink" });
	});
});

describe("resolvesInside", () => {
	it("is false for an unrelated path", async () => {
		const root = await makeTree();
		const other = await makeTree();
		expect(
			await resolvesInside(root, path.join(other, "config.json")),
		).toBe(false);
	});

	it("is true for a path that does not exist yet", async () => {
		const root = await makeTree();
		expect(
			await resolvesInside(root, path.join(root, "cfg", "config.json")),
		).toBe(true);
	});

	/**
	 * The reason lexical comparison was not enough: a config directory
	 * reached through a symlink is inside the checkout however the string is
	 * spelled, and `path.resolve` said it was not.
	 */
	it("follows a symlink that leads back into the destination", async () => {
		const root = await makeTree();
		const parent = await mkdtemp(path.join(tmpdir(), "fabric-safe-"));
		await mkdir(path.join(root, "inside"));
		const link = path.join(parent, "cfg-link");
		await symlink(path.join(root, "inside"), link, "dir");

		expect(await resolvesInside(root, path.join(link, "config.json"))).toBe(
			true,
		);
	});
});
