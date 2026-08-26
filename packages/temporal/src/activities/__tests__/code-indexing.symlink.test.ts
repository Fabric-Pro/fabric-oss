import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { walkDirWith } from "../code-indexing";

describe("walkDirWith — symlink handling", () => {
	let root: string;

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "walkdir-symlink-"));
		// Layout (names ordered so the symlink lands between the two files):
		//   root/
		//     a-before-symlink.ts
		//     sym -> /tmp (a real existing target so symlinkSync doesn't fail)
		//     z-after-symlink.ts
		//     sub/
		//       deep.ts
		writeFileSync(join(root, "a-before-symlink.ts"), "// a");
		symlinkSync(tmpdir(), join(root, "sym"));
		writeFileSync(join(root, "z-after-symlink.ts"), "// z");
		mkdirSync(join(root, "sub"));
		writeFileSync(join(root, "sub", "deep.ts"), "// deep");
	});

	afterAll(() => {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			/* ignore cleanup errors */
		}
	});

	it("visits files after a symlink and recurses into subdirectories", () => {
		const visited: string[] = [];
		walkDirWith(root, (_full, rel) => {
			visited.push(rel);
		});
		const sorted = visited.sort();
		expect(sorted).toContain("a-before-symlink.ts");
		expect(sorted).toContain("z-after-symlink.ts");
		expect(sorted).toContain(join("sub", "deep.ts"));
		expect(sorted).not.toContain("sym");
	});
});
