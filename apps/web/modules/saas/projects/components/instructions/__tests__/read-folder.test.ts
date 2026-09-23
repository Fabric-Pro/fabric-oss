import { describe, expect, it, vi } from "vitest";
import {
	FolderPathCollisionError,
	type PickedSource,
	readFolderFiles,
} from "../../../lib/read-folder";

function file(path: string, content = "x"): File {
	const f = new File([content], path.slice(path.lastIndexOf("/") + 1), {
		type: "text/plain",
	});
	Object.defineProperty(f, "webkitRelativePath", { value: path });
	return f;
}

/** A root file picked without a folder: no `webkitRelativePath` at all. */
function rootFile(name: string, content = "x"): File {
	return new File([content], name, { type: "text/plain" });
}

let nextId = 0;
function folder(name: string, files: File[], keepName = false): PickedSource {
	nextId += 1;
	return { id: `s${nextId}`, kind: "folder", name, files, keepName };
}

function files(list: File[]): PickedSource {
	nextId += 1;
	return { id: `s${nextId}`, kind: "files", files: list };
}

describe("readFolderFiles", () => {
	it("strips the picked folder name, hashes, classifies, applies ignore rules and picks up .fabricignore", async () => {
		const { entries, fabricIgnoreText } = await readFolderFiles([
			folder("example-skills", [
				file("example-skills/CLAUDE.md", "# hi"),
				file("example-skills/tasks/1/notes.md"),
				file("example-skills/docs/a.md"),
				file("example-skills/.fabricignore", "docs/\n"),
			]),
		]);
		expect(fabricIgnoreText).toBe("docs/\n");
		expect(
			entries.map((e) => [e.path, e.kind, e.excluded?.layer ?? null]),
		).toEqual([
			["CLAUDE.md", "INSTRUCTIONS", null],
			["tasks/1/notes.md", "KNOWLEDGE", null], // .fabricignore wins: tasks/ is NOT excluded when the file says only docs/
			["docs/a.md", "KNOWLEDGE", "fabricignore"],
			[".fabricignore", "OTHER", null],
		]);
		expect(entries[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
	});

	// R28/C1: the same name-based gate the scan activity applies server-side,
	// mirrored here so the dialog can say "this will be rejected" BEFORE the
	// user pays for a whole upload. The server stays the authority.
	it("flags credential file names so the dialog can warn before the upload", async () => {
		const { entries } = await readFolderFiles([
			folder("repo", [
				file("repo/CLAUDE.md", "# hi"),
				file("repo/.env", "PORT=3000"),
				file("repo/certs/server.pem", "cert"),
			]),
		]);
		expect(entries.map((e) => [e.path, e.secretRule])).toEqual([
			["CLAUDE.md", null],
			[".env", "**/.env"],
			["certs/server.pem", "**/*.pem"],
		]);
		// Not an exclusion: an excluded file is never sent, a flagged one is
		// sent and refused. Conflating them would hide the rejection.
		expect(entries[1]?.excluded).toBeNull();
	});

	// `classifyPath` only knows `.claude/agents/x.md` as an AGENT when
	// `.claude` is the first segment, so two dot-folders uploaded together
	// are only useful if each keeps its own name.
	it("keeps each folder's name as the top-level segment when keepName is set", async () => {
		const { entries } = await readFolderFiles([
			folder(".claude", [file(".claude/agents/a.md")], true),
			folder(".cursor", [file(".cursor/rules/r.md")], true),
		]);
		expect(entries.map((e) => e.path)).toEqual([
			".claude/agents/a.md",
			".cursor/rules/r.md",
		]);
		expect(entries[0]?.kind).toBe("AGENT");
	});

	it("lands a picked root file at the root under its own name", async () => {
		const { entries } = await readFolderFiles([
			files([rootFile("CLAUDE.md", "# hi")]),
		]);
		expect(entries.map((e) => [e.path, e.kind])).toEqual([
			["CLAUDE.md", "INSTRUCTIONS"],
		]);
	});

	// Root-anchored and exact, the same as the server: a nested
	// `.fabricignore` is content, so a kept folder name demotes it.
	it("reads .fabricignore only at the composed root", async () => {
		const nested = await readFolderFiles([
			folder(
				".claude",
				[
					file(".claude/.fabricignore", "docs/\n"),
					file(".claude/agents/a.md"),
				],
				true,
			),
			folder("docs", [file("docs/a.md")], true),
		]);
		expect(nested.fabricIgnoreText).toBeNull();
		expect(
			nested.entries.find((e) => e.path === "docs/a.md")?.excluded,
		).toBeNull();

		const atRoot = await readFolderFiles([
			folder("docs", [file("docs/a.md")], true),
			files([rootFile(".fabricignore", "docs/\n")]),
		]);
		expect(atRoot.fabricIgnoreText).toBe("docs/\n");
		expect(
			atRoot.entries.find((e) => e.path === "docs/a.md")?.excluded?.layer,
		).toBe("fabricignore");
	});

	// Excluded files are never sent, so their bytes must not be read either.
	it("hashes only kept entries, never reading an excluded file", async () => {
		const excludedFile = file("repo/node_modules/x/index.js");
		const neverRead = vi.fn(() => {
			throw new Error("an excluded file was read");
		});
		Object.defineProperty(excludedFile, "arrayBuffer", {
			value: neverRead,
		});
		const { entries } = await readFolderFiles([
			folder("repo", [file("repo/CLAUDE.md", "# hi"), excludedFile]),
		]);
		const [kept, excluded] = entries;
		expect(kept?.excluded).toBeNull();
		expect(kept?.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(excluded?.excluded).not.toBeNull();
		expect(excluded?.sha256).toBeNull();
		expect(neverRead).not.toHaveBeenCalled();
	});

	// The hash cache holds promises; a rejected one left in place would fail
	// every later recompute of the same pick even after the file is readable.
	it("retries a kept file whose first read failed", async () => {
		const flaky = file("repo/CLAUDE.md", "# hi");
		const read = vi
			.fn<() => Promise<ArrayBuffer>>()
			.mockRejectedValueOnce(new Error("file changed on disk"))
			.mockImplementation(() => Blob.prototype.arrayBuffer.call(flaky));
		Object.defineProperty(flaky, "arrayBuffer", { value: read });
		const source = folder("repo", [flaky]);

		await expect(readFolderFiles([source])).rejects.toThrow(
			"file changed on disk",
		);
		const { entries } = await readFolderFiles([source]);
		expect(entries[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(read).toHaveBeenCalledTimes(2);
	});

	it("refuses two sources that would store the same file", async () => {
		const attempt = readFolderFiles([
			folder("repo", [file("repo/docs/README.md")]),
			folder("docs", [file("docs/readme.md")], true),
		]);
		await expect(attempt).rejects.toBeInstanceOf(FolderPathCollisionError);
		await expect(attempt).rejects.toMatchObject({
			kind: "duplicate",
			path: "docs/readme.md",
		});
	});

	// `docs` as a root file and `docs/a.md` from a folder pass the duplicate
	// check, but no filesystem can hold both, so the version would publish
	// and then fail to install.
	it("refuses one name used as both a file and a folder", async () => {
		const attempt = readFolderFiles([
			files([rootFile("docs")]),
			folder("docs", [file("docs/a.md")], true),
		]);
		await expect(attempt).rejects.toMatchObject({
			kind: "file-directory",
			path: "docs/a.md",
			conflictsWith: "docs",
		});
	});
});
