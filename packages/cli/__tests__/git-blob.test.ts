import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	gitBlobOid,
	matchesBlobOid,
	objectFormatOf,
} from "../src/lib/git-blob.js";

const encode = (text: string) => new TextEncoder().encode(text);

describe("gitBlobOid", () => {
	it("matches git's own object id for the same bytes", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "fabric-blob-"));
		try {
			const file = path.join(directory, "note.md");
			const text = "# A note\né 😀\r\nsecond line\n";
			await writeFile(file, text);

			const git = execFileSync(
				"git",
				["hash-object", "--no-filters", file],
				{ encoding: "utf8" },
			).trim();

			expect(gitBlobOid(encode(text))).toBe(git);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("knows the well-known ids", () => {
		expect(gitBlobOid(encode(""))).toBe(
			"e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
		);
		expect(gitBlobOid(encode("hello\n"))).toBe(
			"ce013625030ba8dba906f756967f9e9ca394464a",
		);
	});

	it("hashes the way the id it is compared with was made", () => {
		const sha1 = gitBlobOid(encode("x"));
		const sha256 = gitBlobOid(encode("x"), "sha256");

		expect(objectFormatOf(sha1)).toBe("sha1");
		expect(objectFormatOf(sha256)).toBe("sha256");
		expect(objectFormatOf("abc")).toBeNull();
		expect(matchesBlobOid(encode("x"), sha1)).toBe(true);
		expect(matchesBlobOid(encode("x"), sha256)).toBe(true);
		expect(matchesBlobOid(encode("y"), sha1)).toBe(false);
		expect(matchesBlobOid(encode("x"), "not an id")).toBe(false);
	});
});
