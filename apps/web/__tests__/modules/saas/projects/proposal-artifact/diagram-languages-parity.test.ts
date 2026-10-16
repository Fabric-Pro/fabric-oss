/**
 * The prose hash and the editor agree on which fences are diagrams
 * (Fizzy #2946).
 *
 * A Proposal section's prose hash counts a diagram fence for nothing, and
 * knows one by `DIAGRAM_LANGUAGES`: a restatement of the editor's
 * `MERMAID_LANGUAGES`, the fence languages it renders as a diagram and saves
 * as `mermaid`, since the shared package cannot import the editor. A
 * language on one list only would let a save that changes no text change a
 * section's hash, so the two lists must stay equal.
 *
 * The editor's first-line diagram keywords are a local list inside its
 * parse rule, not an export, so they are not compared here.
 */

import { DIAGRAM_LANGUAGES } from "@repo/utils/proposal-artifact/section-hash";
import { MERMAID_LANGUAGES } from "@saas/projects/lib/tiptap-mermaid-extension";
import { describe, expect, it } from "vitest";

describe("diagram fence languages", () => {
	it("are the same for the prose hash as for the editor", () => {
		expect([...DIAGRAM_LANGUAGES].sort()).toEqual(
			[...new Set(MERMAID_LANGUAGES)].sort(),
		);
	});
});
