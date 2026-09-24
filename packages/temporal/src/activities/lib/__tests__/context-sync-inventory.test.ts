/**
 * The Living Memory sync's `ls-tree -r -z` parser (design 2026-09-23
 * §5.3.1 step 4): every entry with its mode, names as exact bytes, the entry
 * cap and the record bound. The real `git ls-tree` runs in
 * `__tests__/project-context-repository-sync-real-git.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
	createContextInventoryParser,
	listContextInventory,
} from "../context-sync-inventory";
import { GitCommandError } from "../instruction-sync-git";

const OID = "e".repeat(40);
const record = (mode: string, type: string, path: Buffer | string) =>
	Buffer.concat([
		Buffer.from(`${mode} ${type} ${OID}\t`, "latin1"),
		Buffer.isBuffer(path) ? path : Buffer.from(path, "utf8"),
		Buffer.from([0]),
	]);

describe("createContextInventoryParser", () => {
	it("keeps every entry with its mode and type, across chunk boundaries", () => {
		const stream = Buffer.concat([
			record("100644", "blob", "docs/a.md"),
			record("120000", "blob", "docs/link.md"),
			record("160000", "commit", "vendor/lib"),
			record("100755", "blob", "docs/tab\there.md"),
		]);
		const parser = createContextInventoryParser(10);
		for (let i = 0; i < stream.length; i += 7) {
			expect(parser.push(stream.subarray(i, i + 7))).toBe("ok");
		}
		expect(parser.finish()).toEqual([
			{
				path: "docs/a.md",
				utf8: true,
				mode: "100644",
				type: "blob",
				oid: OID,
			},
			{
				path: "docs/link.md",
				utf8: true,
				mode: "120000",
				type: "blob",
				oid: OID,
			},
			{
				path: "vendor/lib",
				utf8: true,
				mode: "160000",
				type: "commit",
				oid: OID,
			},
			{
				path: "docs/tab\there.md",
				utf8: true,
				mode: "100755",
				type: "blob",
				oid: OID,
			},
		]);
	});

	it("flags a name that is not UTF-8 and still reports it under its folder", () => {
		const parser = createContextInventoryParser(10);
		parser.push(
			record(
				"100644",
				"blob",
				Buffer.from([0x64, 0x6f, 0x63, 0x73, 0x2f, 0xff]),
			),
		);
		expect(parser.finish()).toEqual([
			{
				path: "docs/\ufffd",
				utf8: false,
				mode: "100644",
				type: "blob",
				oid: OID,
			},
		]);
	});

	it("answers limit past the entry cap, and past the record bound for a NUL-free stream", () => {
		const capped = createContextInventoryParser(2);
		expect(
			capped.push(
				Buffer.concat([
					record("100644", "blob", "a.md"),
					record("100644", "blob", "b.md"),
					record("100644", "blob", "c.md"),
				]),
			),
		).toBe("limit");
		const unbounded = createContextInventoryParser(10);
		expect(unbounded.push(Buffer.alloc(70_000, 0x61))).toBe("limit");
	});
});

describe("listContextInventory", () => {
	it("refuses anything but an object id before git runs", async () => {
		await expect(
			listContextInventory({
				dir: "/nonexistent",
				sha: "--output=/tmp/x",
				paths: ["docs"],
				env: {},
				maxEntries: 10,
			}),
		).rejects.toBeInstanceOf(GitCommandError);
	});
});
