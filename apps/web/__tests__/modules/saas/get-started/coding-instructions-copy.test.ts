import { describe, expect, it } from "vitest";
import { GET_STARTED_PAGES } from "../../../../modules/saas/get-started/lib/get-started-registry";

const page = GET_STARTED_PAGES.find(
	(candidate) => candidate.tab === "coding-instructions",
);

function body(id: string): string {
	const component = page?.components.find((c) => c.id === id);
	if (!component) {
		throw new Error(`no coding-instructions tour step ${id}`);
	}
	return component.body;
}

describe("Coding Instructions page tour copy", () => {
	it("describes Edit on a repository as a commit or a pull-request suggestion made in Fabric", () => {
		const copy = body("coding-instructions-commit");

		expect(copy).not.toMatch(/native Git/i);
		expect(copy).toMatch(/Commit to the branch/);
		expect(copy).toMatch(/Suggest as a pull request/);
	});

	it("points at the control that exists for pull requests, not a Pull requests button", () => {
		const copy = body("coding-instructions-history");

		expect(copy).not.toMatch(/Pull requests shows/);
		expect(copy).toMatch(/Your proposals/);
	});
});
