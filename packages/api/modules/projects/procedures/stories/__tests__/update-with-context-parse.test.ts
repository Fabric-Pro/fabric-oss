/**
 * Unit tests for `parseUpdatedDocument` in `updateWithContextProcedure`.
 *
 * This is the function that splits the AI-updated document back into the two
 * stored columns (`description`, `acceptanceCriteria`). Its split point used to
 * be `/^##\s+Acceptance\s+Criteria\s*$/im` — the strictest heading matcher in
 * this codebase, `$`-anchored on exact text — so the moment a user highlighted
 * or bolded the heading in the editor, the header stopped matching and the
 * whole document collapsed into `description` (and, in the `## Description`
 * case, the header itself leaked into the stored body).
 *
 * The fix normalizes each line with `stripInlineDecoration` for MATCHING ONLY.
 * The two invariants these tests defend:
 *
 *  1. Decorated headings split exactly like undecorated ones.
 *  2. What is STORED is sliced out of the ORIGINAL document. The normalizer is
 *     lossy — it deletes `*`, `_`, backtick and `~` anywhere on the line and
 *     collapses whitespace — so an offset taken from a normalized copy does not
 *     map back onto the original string, and normalized text must never reach
 *     the database.
 *
 * Mocks `@repo/database`, `@repo/storage`, `@repo/config`, `@repo/logs`,
 * `@repo/temporal`, `enqueuePmSync` and the oRPC procedure base so the module
 * can be imported without its runtime dependency graph.
 */

import { stripInlineDecoration } from "@repo/utils/markdown-heading";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	getStoryById: vi.fn(),
	updateStory: vi.fn(),
	setLastContextUpdateAt: vi.fn(),
}));

vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { projectContexts: "test-bucket" } } },
}));

vi.mock("@repo/storage", () => ({
	getStorageProvider: () => ({ type: "s3", getSignedUrl: vi.fn() }),
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/temporal", () => ({
	fetchProjectContextSources: vi.fn(),
	runContextUpdate: vi.fn(),
	ContextUpdateTruncatedError: class ContextUpdateTruncatedError extends Error {},
}));

vi.mock("../../../lib/enqueue-pm-sync", () => ({
	enqueuePmSync: vi.fn(),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	});
	const Permissions = new Proxy({}, { get: (_t, p) => String(p) }) as Record<
		string,
		string
	>;
	return {
		tenantProtectedProcedure: chainable,
		Permissions,
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? null,
	};
});

const { parseUpdatedDocument } = await import("../update-with-context");

/** A TipTap highlight, as the editor actually serializes one. */
const HIGHLIGHT_OPEN =
	'<mark data-color="#fef08a" style="background-color:#fef08a">';

describe("parseUpdatedDocument — decorated `## Acceptance Criteria` split", () => {
	it("a highlighted AC heading splits identically to an undecorated one", () => {
		const body = "The modal closes on Escape.";
		const criteria =
			"- Given a modal\n- When Escape is pressed\n- Then it closes";
		const undecorated = `## Description\n\n${body}\n\n## Acceptance Criteria\n\n${criteria}`;
		const decorated = `## Description\n\n${body}\n\n## ${HIGHLIGHT_OPEN}Acceptance Criteria</mark>\n\n${criteria}`;

		const fromUndecorated = parseUpdatedDocument(undecorated, true);
		const fromDecorated = parseUpdatedDocument(decorated, true);

		expect(fromDecorated).toEqual(fromUndecorated);
		expect(fromDecorated).toEqual({
			description: body,
			acceptanceCriteria: criteria,
		});
	});

	it.each([
		["bold", "## **Acceptance Criteria**"],
		["italic", "## *Acceptance Criteria*"],
		["inline code", "## `Acceptance Criteria`"],
		["strikethrough", "## ~~Acceptance Criteria~~"],
		["underline span", "## <u>Acceptance Criteria</u>"],
		["trailing whitespace", "## Acceptance Criteria   "],
	])("splits on a %s AC heading", (_label, heading) => {
		const parsed = parseUpdatedDocument(
			`## Description\n\nBody text.\n\n${heading}\n\n- one\n- two`,
			true,
		);

		expect(parsed).toEqual({
			description: "Body text.",
			acceptanceCriteria: "- one\n- two",
		});
	});

	it("before the fix the whole document collapsed into description — regression fixture", () => {
		const decorated = `## Description\n\nBody text.\n\n## ${HIGHLIGHT_OPEN}Acceptance Criteria</mark>\n\n- one`;

		// The old `$`-anchored matcher found nothing here, so `description` came
		// back carrying the AC heading and every criterion.
		const parsed = parseUpdatedDocument(decorated, true);

		expect(parsed.description).not.toContain("Acceptance Criteria");
		expect(parsed.description).not.toContain("- one");
		expect(parsed.acceptanceCriteria).toBe("- one");
	});
});

describe("parseUpdatedDocument — decorated `## Description` strip", () => {
	it("a highlighted Description heading is stripped, not leaked into the stored body", () => {
		const parsed = parseUpdatedDocument(
			`## ${HIGHLIGHT_OPEN}Description</mark>\n\nBody text.\n\n## Acceptance Criteria\n\n- one`,
			true,
		);

		expect(parsed.description).toBe("Body text.");
		expect(parsed.description).not.toContain("Description");
		expect(parsed.description).not.toContain("<mark");
	});

	it("strips a decorated Description heading on the no-AC-heading path too", () => {
		const parsed = parseUpdatedDocument(
			"## **Description**\n\nBody text only.",
			false,
		);

		expect(parsed).toEqual({
			description: "Body text only.",
			acceptanceCriteria: undefined,
		});
	});

	it("keeps a prepended conflict block that precedes the decorated Description heading", () => {
		const doc = [
			"⚠️ Ambiguous Recent Context",
			"",
			"Two sources disagree on the retention window.",
			"",
			`## ${HIGHLIGHT_OPEN}Description</mark>`,
			"",
			"Body text.",
			"",
			"## Acceptance Criteria",
			"",
			"- one",
		].join("\n");

		const parsed = parseUpdatedDocument(doc, true);

		// The conflict flag survives the round-trip, and stripping the header in
		// the middle of the chunk does not widen the blank gap around it.
		expect(parsed.description).toBe(
			"⚠️ Ambiguous Recent Context\n\nTwo sources disagree on the retention window.\n\nBody text.",
		);
		expect(parsed.acceptanceCriteria).toBe("- one");
	});
});

describe("parseUpdatedDocument — undecorated inputs are byte-identical", () => {
	it.each([
		[
			"canonical document",
			"## Description\n\nBody text.\n\n## Acceptance Criteria\n\n- one\n- two",
			true,
			{ description: "Body text.", acceptanceCriteria: "- one\n- two" },
		],
		[
			"no AC heading, story had criteria",
			"## Description\n\nBody text.",
			true,
			{ description: "Body text.", acceptanceCriteria: "" },
		],
		[
			"no AC heading, story had none",
			"## Description\n\nBody text.",
			false,
			{ description: "Body text.", acceptanceCriteria: undefined },
		],
		[
			"no headings at all",
			"Just a body with no headings.",
			false,
			{
				description: "Just a body with no headings.",
				acceptanceCriteria: undefined,
			},
		],
		[
			"prepended conflict block",
			"⚠️ Ambiguous Recent Context\n\nConflict note.\n\n## Description\n\nBody.\n\n## Acceptance Criteria\n\n- one",
			true,
			{
				description:
					"⚠️ Ambiguous Recent Context\n\nConflict note.\n\nBody.",
				acceptanceCriteria: "- one",
			},
		],
		[
			"extra whitespace inside the headings",
			"##   Description   \n\n\n\nBody.\n\n##  Acceptance   Criteria  \n\n- one",
			true,
			{ description: "Body.", acceptanceCriteria: "- one" },
		],
		[
			"CRLF line endings",
			"## Description\r\n\r\nBody.\r\n\r\n## Acceptance Criteria\r\n\r\n- one",
			true,
			{ description: "Body.", acceptanceCriteria: "- one" },
		],
		[
			"H3 is not a boundary",
			"## Description\n\nBody.\n\n### Acceptance Criteria\n\n- not a split",
			false,
			{
				description:
					"Body.\n\n### Acceptance Criteria\n\n- not a split",
				acceptanceCriteria: undefined,
			},
		],
		[
			"bare Description heading with no body",
			"## Description",
			false,
			{ description: "## Description", acceptanceCriteria: undefined },
		],
	])("%s", (_label, doc, hadAc, expected) => {
		expect(parseUpdatedDocument(doc as string, hadAc as boolean)).toEqual(
			expected,
		);
	});

	it("never stores the normalizer's lossy output — emphasis characters in the body survive verbatim", () => {
		// `stripInlineDecoration` deletes `*`, `_`, backtick and `~` wherever they
		// appear, so `5 * 3 rules` normalizes to `5 3 rules`. None of that may
		// reach the stored columns.
		const body =
			"A grid of 5 * 3 rules, **bold text**, `code_span` and a ~tilde~.";
		const criteria = "- 2 * 2 = 4 and _snake_case_ stays intact";
		const parsed = parseUpdatedDocument(
			`## Description\n\n${body}\n\n## Acceptance Criteria\n\n${criteria}`,
			true,
		);

		expect(parsed.description).toBe(body);
		expect(parsed.acceptanceCriteria).toBe(criteria);
	});
});

describe("parseUpdatedDocument — offsets map back onto the original document", () => {
	// The failure this guards: normalize the whole document, run the matcher on
	// the normalized copy, then slice the ORIGINAL with the normalized offset.
	// Every stripped tag and collapsed whitespace run shifts that offset, and
	// multi-byte content makes the truncation obvious.
	const BODY =
		"Résumé flow 🚀 — the modal shows «Ünicode» and an emoji 😀 before the split.";
	const CRITERIA = "- Émoji 🎉 in the criteria too\n- Ünicode ✅ preserved";
	const doc = [
		"## **Description**",
		"",
		BODY,
		"",
		`## ${HIGHLIGHT_OPEN}Acceptance Criteria</mark>`,
		"",
		CRITERIA,
	].join("\n");

	it("slices at the correct offset when a decorated heading follows multi-byte content", () => {
		const parsed = parseUpdatedDocument(doc, true);

		expect(parsed.description).toBe(BODY);
		expect(parsed.acceptanceCriteria).toBe(CRITERIA);
	});

	it("the fixture actually discriminates — a normalized-copy offset lands elsewhere", () => {
		// Compute what the buggy implementation would have done, and assert it is
		// materially different from the truth. Without this, the test above could
		// pass under the very bug it exists to catch.
		const normalizedDoc = doc
			.split("\n")
			.map((line) => stripInlineDecoration(line))
			.join("\n");
		const naiveIndex = normalizedDoc.search(
			/^##\s+Acceptance\s+Criteria\s*$/im,
		);
		const trueIndex = doc.indexOf(`## ${HIGHLIGHT_OPEN}`);

		expect(naiveIndex).toBeGreaterThan(-1);
		expect(trueIndex).toBeGreaterThan(-1);
		expect(naiveIndex).not.toBe(trueIndex);

		// Slicing the ORIGINAL with the naive offset truncates the body mid-run.
		const naiveDescription = doc.slice(0, naiveIndex).trim();
		expect(naiveDescription).not.toBe(
			parseUpdatedDocument(doc, true).description,
		);
	});

	it("both stored columns are verbatim substrings of the original document", () => {
		const parsed = parseUpdatedDocument(doc, true);

		expect(doc).toContain(parsed.description);
		expect(doc).toContain(parsed.acceptanceCriteria);
		// Surrogate pairs come through whole — no lone halves from a bad offset.
		expect(parsed.description).toContain("🚀");
		expect(parsed.description).toContain("😀");
		expect(
			/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(parsed.description),
		).toBe(false);
	});
});

describe("parseUpdatedDocument — heading-forgery guard", () => {
	it("a body line that would only become a heading after stripping is not the boundary", () => {
		const doc = [
			"## Description",
			"",
			"Use this template for the section header:",
			"",
			"`## Acceptance Criteria`",
			"",
			"and keep the rest of the body below it.",
			"",
			"## Acceptance Criteria",
			"",
			"- the real criteria",
		].join("\n");

		const parsed = parseUpdatedDocument(doc, true);

		// The inline-code line stays in the description, verbatim backticks and
		// all; the split happened at the real heading further down.
		expect(parsed.description).toBe(
			"Use this template for the section header:\n\n`## Acceptance Criteria`\n\nand keep the rest of the body below it.",
		);
		expect(parsed.acceptanceCriteria).toBe("- the real criteria");
	});

	it("a tag-prefixed forged AC heading does not move the boundary", () => {
		const doc = [
			"## Description",
			"",
			"<span>## Acceptance Criteria</span>",
			"",
			"still description.",
			"",
			"## Acceptance Criteria",
			"",
			"- the real criteria",
		].join("\n");

		const parsed = parseUpdatedDocument(doc, true);

		expect(parsed.description).toBe(
			"<span>## Acceptance Criteria</span>\n\nstill description.",
		);
		expect(parsed.acceptanceCriteria).toBe("- the real criteria");
	});

	it("a forged Description heading in the body is not stripped", () => {
		const doc =
			"`## Description`\n\nBody text.\n\n## Acceptance Criteria\n\n- one";

		const parsed = parseUpdatedDocument(doc, true);

		expect(parsed.description).toBe("`## Description`\n\nBody text.");
		expect(parsed.acceptanceCriteria).toBe("- one");
	});
});

/**
 * The document this surface builds always writes `## Acceptance Criteria`, but
 * the reply comes back through a model, and models demote and re-word the
 * headings they are handed. When the strict anchor missed one, every criterion
 * stayed in `description` AND the column came back `""` — a proposal to wipe
 * criteria the user never asked to remove.
 */
describe("parseUpdatedDocument — a reworded acceptance heading is not a deletion", () => {
	const criteria = "- GIVEN a muted project THEN no notification is sent";

	it("recovers criteria under a DEMOTED heading instead of proposing a wipe", () => {
		const doc = `## Description\n\nBody text.\n\n### Acceptance Criteria\n\n${criteria}`;

		const parsed = parseUpdatedDocument(doc, true);

		expect(parsed.acceptanceCriteria).toBe(criteria);
		expect(parsed.description).toBe("Body text.");
	});

	it("recovers them when the model appends a colon", () => {
		const doc = `## Description\n\nBody text.\n\n## Acceptance Criteria:\n\n${criteria}`;

		const parsed = parseUpdatedDocument(doc, true);

		expect(parsed.acceptanceCriteria).toBe(criteria);
	});

	it("still clears the column when the model genuinely removed the section", () => {
		// No acceptance heading survives at any level, so "the user asked for
		// them to go" is the only reading left. The fallback must not turn a
		// deliberate removal into a no-op.
		const doc = "## Description\n\nBody text with no criteria at all.";

		const parsed = parseUpdatedDocument(doc, true);

		expect(parsed.acceptanceCriteria).toBe("");
	});

	it("leaves a story that never had criteria untouched", () => {
		// The fallback is only consulted when there is something to lose, so a
		// heading-shaped line here must not invent a criteria column.
		const doc = "## Description\n\nBody.\n\n### Acceptance testing notes";

		const parsed = parseUpdatedDocument(doc, false);

		expect(parsed.acceptanceCriteria).toBeUndefined();
	});
});
