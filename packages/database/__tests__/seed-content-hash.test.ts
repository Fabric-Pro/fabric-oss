/**
 * `deploy-seeds` skips a seed whose content hash is unchanged. The skills seed
 * reads every folder under prisma/skills-seed at run time, but only its own
 * file was hashed, so a new skill folder never reached any environment: the
 * hash stayed the same and the seed was skipped. A directory dependency now
 * counts every file under it.
 */
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedContentHash } from "../scripts/seed-content-hash";

let root: string;
let seedFile: string;
let folder: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "seed-hash-"));
	seedFile = join(root, "seed-example.ts");
	writeFileSync(seedFile, "export const seed = 1;\n");
	folder = join(root, "example-seed");
	mkdirSync(join(folder, "first", "assets"), { recursive: true });
	writeFileSync(join(folder, "first", "SKILL.md"), "# First\n");
	writeFileSync(
		join(folder, "first", "assets", "logo.bin"),
		Buffer.from([0, 1, 2]),
	);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("seedContentHash", () => {
	it("is the same for the same content", () => {
		expect(seedContentHash(seedFile, [folder])).toBe(
			seedContentHash(seedFile, [folder]),
		);
	});

	it("changes when a folder is added under a directory dependency", () => {
		const before = seedContentHash(seedFile, [folder]);
		mkdirSync(join(folder, "second"));
		writeFileSync(join(folder, "second", "SKILL.md"), "# Second\n");

		expect(seedContentHash(seedFile, [folder])).not.toBe(before);
	});

	it("changes when a file under it is edited, including a binary asset", () => {
		const before = seedContentHash(seedFile, [folder]);
		writeFileSync(
			join(folder, "first", "assets", "logo.bin"),
			Buffer.from([0, 1, 3]),
		);

		expect(seedContentHash(seedFile, [folder])).not.toBe(before);
	});

	it("changes when a file under it is renamed", () => {
		const before = seedContentHash(seedFile, [folder]);
		renameSync(
			join(folder, "first", "SKILL.md"),
			join(folder, "first", "README.md"),
		);

		expect(seedContentHash(seedFile, [folder])).not.toBe(before);
	});

	it("hashes file dependencies exactly as before, so no other seed re-runs", () => {
		const dependency = join(root, "catalog.ts");
		writeFileSync(dependency, "export const catalog = [];\n");
		const legacy = createHash("sha256");
		legacy.update("export const seed = 1;\n");
		legacy.update("export const catalog = [];\n");

		expect(seedContentHash(seedFile, [dependency])).toBe(
			legacy.digest("hex").slice(0, 16),
		);
	});

	it("covers the real skill folders, so the skills seed hash is no longer its file alone", () => {
		const prisma = join(__dirname, "..", "prisma");
		const seedSkills = join(prisma, "seed-skills.ts");

		expect(
			seedContentHash(seedSkills, [join(prisma, "skills-seed")]),
		).not.toBe(seedContentHash(seedSkills));
	});
});
