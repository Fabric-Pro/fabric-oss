import { describe, expect, it } from "vitest";
import { writeFolderProblem } from "../context-write-targets";

const SELECTION = { paths: [""], excludedPaths: [] };

describe("writeFolderProblem", () => {
	it("says a folder past the storage limit is too long, not misspelled", () => {
		expect(writeFolderProblem("x".repeat(513), SELECTION, [])).toBe(
			"PATH_TOO_LONG",
		);
		expect(writeFolderProblem("x".repeat(512), SELECTION, [])).toBeNull();
	});

	it("keeps the spelling refusal for a folder within the limit", () => {
		expect(writeFolderProblem("docs/ai/", SELECTION, [])).toBe(
			"INVALID_PATH",
		);
	});
});
