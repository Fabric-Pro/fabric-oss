/**
 * No Coding Instructions component may show the server's own `error.message`
 * to the person: it is not translated, and it can carry a provider's or a
 * proxy's wording. A failed action reads its line from
 * `projects.codingInstructions.actionErrors` by the error's code
 * (`useInstructionActionError`).
 *
 * A source guard rather than a render per call site: the sites are
 * `toast.error(...)` arguments and fallbacks inside handlers that need a
 * failing mutation each, and the next one added without the hook is what this
 * is here to catch.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const COMPONENTS_DIR = join(__dirname, "..");

const files = readdirSync(COMPONENTS_DIR)
	.filter((name) => name.endsWith(".tsx"))
	.map((name) => ({
		name,
		source: readFileSync(join(COMPONENTS_DIR, name), "utf8"),
	}));

describe("Coding Instructions action errors", () => {
	it("finds the components it guards", () => {
		expect(files.length).toBeGreaterThan(10);
	});

	it.each(files.map((file) => [file.name, file.source] as const))(
		"%s never shows a raw error message",
		(_name, source) => {
			expect(source).not.toMatch(/toast\.error\(\s*error\.message\s*\)/);
			expect(source).not.toMatch(/:\s*error\.message\s*,?\s*\)/);
		},
	);

	it("routes every site that turns an error into a toast through the hook", () => {
		const users = files.filter((file) =>
			file.source.includes("actionError("),
		);

		expect(users.map((file) => file.name).sort()).toEqual([
			"AddInstructionFileDialog.tsx",
			"InstructionFileView.tsx",
			"InstructionProposalBranchPanel.tsx",
			"InstructionProposals.tsx",
			"InstructionsHistory.tsx",
			"InstructionsPublishedView.tsx",
			"InstructionsSettingsDialog.tsx",
		]);
		for (const file of users) {
			expect(file.source).toContain("useInstructionActionError()");
		}
	});
});
