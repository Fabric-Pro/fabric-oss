import { describe, expect, it } from "vitest";
import { readFolderFiles } from "../../../lib/read-folder";

function file(path: string, content = "x"): File {
	const f = new File([content], path.slice(path.lastIndexOf("/") + 1), {
		type: "text/plain",
	});
	Object.defineProperty(f, "webkitRelativePath", { value: path });
	return f;
}

describe("readFolderFiles", () => {
	it("strips the picked folder name, hashes, classifies, applies ignore rules and picks up .fabricignore", async () => {
		const { entries, fabricIgnoreText } = await readFolderFiles([
			file("example-skills/CLAUDE.md", "# hi"),
			file("example-skills/tasks/1/notes.md"),
			file("example-skills/docs/a.md"),
			file("example-skills/.fabricignore", "docs/\n"),
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
			file("repo/CLAUDE.md", "# hi"),
			file("repo/.env", "PORT=3000"),
			file("repo/certs/server.pem", "cert"),
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
});
