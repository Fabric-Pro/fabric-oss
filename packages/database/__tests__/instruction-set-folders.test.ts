/**
 * "A set is a folder" (spec 2026-11-11, decision 2026-11-12): which files of
 * the project's one instructions source belong to a set, and where.
 */
import { describe, expect, it } from "vitest";
import {
	instructionSetFolder,
	pathInInstructionSet,
} from "../prisma/queries/instruction-set-management";

const defaultSet = {
	folder: "",
	excludedFolders: ["instructions/mobile/", "instructions/web/"],
};
const mobile = { folder: "instructions/mobile/", excludedFolders: [] };

describe("instruction set folders", () => {
	it("puts a set in instructions/<slug>/ and the default set at the root", () => {
		expect(instructionSetFolder({ slug: "mobile", isDefault: false })).toBe(
			"instructions/mobile/",
		);
		expect(instructionSetFolder({ slug: "default", isDefault: true })).toBe(
			"",
		);
	});

	it("gives a set its folder's files, relative to the folder", () => {
		expect(
			pathInInstructionSet(
				"instructions/mobile/skills/a/SKILL.md",
				mobile,
			),
		).toBe("skills/a/SKILL.md");
		expect(pathInInstructionSet("CLAUDE.md", mobile)).toBeNull();
		expect(
			pathInInstructionSet("instructions/mobile-old/CLAUDE.md", mobile),
		).toBeNull();
	});

	it("gives the default set the root minus every other set's folder", () => {
		expect(pathInInstructionSet("CLAUDE.md", defaultSet)).toBe("CLAUDE.md");
		expect(pathInInstructionSet("instructions/notes.md", defaultSet)).toBe(
			"instructions/notes.md",
		);
		expect(
			pathInInstructionSet("instructions/web/CLAUDE.md", defaultSet),
		).toBeNull();
	});

	it("leaves every file in place for a project without sets", () => {
		expect(pathInInstructionSet("instructions/web/CLAUDE.md", null)).toBe(
			"instructions/web/CLAUDE.md",
		);
	});
});
