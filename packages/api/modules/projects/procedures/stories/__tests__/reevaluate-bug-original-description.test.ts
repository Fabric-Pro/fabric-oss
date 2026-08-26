/**
 * Unit tests for the "Original Description from User (Do Not Modify)"
 * verbatim-preserve guard in `reevaluateBugProcedure` (REQ-7 / AC4).
 *
 * The guard reads the section out of the PRIOR description, reads it out of the
 * model's rewrite, and either rejects (section dropped) or splices the user's
 * words back in (section mutated). All of that hangs off one lookup: find the
 * heading line. When the lookup misses, `extractOriginalDescriptionBody` returns
 * `null` and the whole guard is skipped — it fails OPEN, so the model's rewrite
 * of the reporter's own words is persisted with nothing raised. That is why a
 * heading the PO merely HIGHLIGHTED in the editor (TipTap stores
 * `## <mark data-color="#fef08a">…</mark>`) is a data-integrity bug and not a
 * cosmetic one, and why these tests exist.
 *
 * The section TERMINATORS are deliberately not normalized; the last two tests
 * pin that decision from both sides.
 *
 * Only the two pure helpers are exercised here — the procedure's LLM/persistence
 * path is covered by `reevaluate-bug-attachment-guard.test.ts`. The module still
 * has to be importable, hence the mock preamble.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	getStoryById: vi.fn(),
	getBoundPromptForAgent: vi.fn(),
	updateStory: vi.fn(),
	setLastContextUpdateAt: vi.fn(),
	buildFabricStoryUrl: vi.fn(),
	placeFabricBackLink: vi.fn(),
	db: {},
}));

vi.mock("@repo/ai", () => {
	class AIProviderNotConfiguredError extends Error {}
	return {
		AIProviderNotConfiguredError,
		getAIModelWithMetadata: vi.fn(),
		generateObject: vi.fn(),
		logModelUsageAsync: vi.fn(),
	};
});

vi.mock("@repo/ai/lib/function-tag-context", () => ({
	getProjectFunctionTagClause: vi.fn(),
}));

vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { projectContexts: "test-bucket" } } },
}));

vi.mock("@repo/storage", () => ({
	getStorageProvider: () => ({ getSignedUrl: vi.fn() }),
}));

vi.mock("@repo/rag", () => ({
	retrieveProjectContexts: vi.fn(),
	formatContextsForPrompt: vi.fn(),
}));

vi.mock("@repo/rag/lib/project-contexts/live-integration-context", () => ({
	fetchLiveIntegrationContext: vi.fn(),
	formatLiveContextForPrompt: vi.fn(),
}));

// The BARREL only — `@repo/utils/markdown-heading` is a separate specifier and
// stays REAL, because the normalizer under test is exactly what these assert.
vi.mock("@repo/utils", () => ({
	renderTemplate: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
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
		requireOrganizationMembership: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? null,
	};
});

const { extractOriginalDescriptionBody, spliceOriginalDescription } =
	await import("../reevaluate-bug");

/** The reporter's words, verbatim — multi-line so truncation is detectable. */
const ORIGINAL_BODY = [
	"the login button is broken, clicking does nothing",
	"",
	"happens on my work laptop every morning, first click only",
	"tried a hard refresh, no change",
].join("\n");

/** A bug card whose Original Description heading is written `heading`. */
function bugCard(heading: string): string {
	return [
		"## Bug: Login button does nothing",
		"",
		"## Steps to Reproduce",
		"1. Open /login",
		'2. Click "Sign in"',
		"",
		heading,
		ORIGINAL_BODY,
		"",
		"## Environment",
		"Chrome 120, Windows 11",
		"",
	].join("\n");
}

const PLAIN_HEADING = "## Original Description from User (Do Not Modify)";
// What TipTap stores once the heading is highlighted in the editor.
const HIGHLIGHTED_HEADING =
	'## <mark data-color="#fef08a">Original Description from User (Do Not Modify)</mark>';
const BOLD_HEADING = "## **Original Description from User (Do Not Modify)**";
const CODE_HEADING = "## `Original Description from User (Do Not Modify)`";

describe("extractOriginalDescriptionBody", () => {
	it("extracts the body verbatim under an undecorated heading", () => {
		expect(extractOriginalDescriptionBody(bugCard(PLAIN_HEADING))).toBe(
			ORIGINAL_BODY,
		);
	});

	it.each([
		["highlighted", HIGHLIGHTED_HEADING],
		["bolded", BOLD_HEADING],
		["inline-coded", CODE_HEADING],
	])(
		"still finds the section when the heading is %s, and extracts the same verbatim body",
		(_label, heading) => {
			// The guard must not fail open just because the heading was decorated
			// in the editor: same body, byte for byte, as the undecorated card.
			expect(extractOriginalDescriptionBody(bugCard(heading))).toBe(
				ORIGINAL_BODY,
			);
		},
	);

	it("matches a decorated heading case-insensitively", () => {
		expect(
			extractOriginalDescriptionBody(
				bugCard(
					"## **original description from user (do not modify)**",
				),
			),
		).toBe(ORIGINAL_BODY);
	});

	it("returns null when the section is absent", () => {
		expect(
			extractOriginalDescriptionBody(
				"## Steps to Reproduce\n1. Open /login\n",
			),
		).toBeNull();
	});

	it("does NOT match a body line that only LOOKS like the heading once stripped", () => {
		// The helper's forgery guard: an inline-code body line normalizes to
		// heading shape, and must never be allowed to move the section boundary.
		const forged = [
			"## Steps to Reproduce",
			"1. Open /login",
			"`## Original Description from User (Do Not Modify)`",
			"not the user's words at all",
		].join("\n");
		expect(extractOriginalDescriptionBody(forged)).toBeNull();
	});

	it("stops at the next undecorated heading, not at a `###` subsection", () => {
		const card = [
			PLAIN_HEADING,
			"reporter line one",
			"### Attachments the reporter pasted",
			"screenshot.png",
			"## Environment",
			"Chrome 120",
		].join("\n");
		expect(extractOriginalDescriptionBody(card)).toBe(
			"reporter line one\n### Attachments the reporter pasted\nscreenshot.png",
		);
	});

	it("stops at a DECORATED following heading (terminators are left un-normalized on purpose)", () => {
		// `/^##? \S/` is satisfied by `<`, `*`, `~` and a backtick, so a decorated
		// following heading already terminates the section. Normalizing the
		// terminator could only LOSE the match — a heading whose text sits
		// entirely inside the stripped tag collapses to a bare `##` — and the
		// body would then over-read to EOF, swallowing Environment.
		const card = [
			PLAIN_HEADING,
			"reporter line one",
			'## <mark data-color="#fef08a">Environment</mark>',
			"Chrome 120, Windows 11",
		].join("\n");
		expect(extractOriginalDescriptionBody(card)).toBe("reporter line one");
	});
});

describe("spliceOriginalDescription", () => {
	it("restores the FULL body under a decorated heading, not a truncated one", () => {
		// What the model returned: heading kept (decoration and all), body
		// rewritten down to a single tidied sentence.
		const mutated = bugCard(HIGHLIGHTED_HEADING).replace(
			ORIGINAL_BODY,
			"The login button does not respond to the first click.",
		);
		const restored = spliceOriginalDescription(mutated, ORIGINAL_BODY);

		// Every line of the reporter's text is back — this is the assertion the
		// truncation bug would fail.
		for (const line of ORIGINAL_BODY.split("\n").filter(Boolean)) {
			expect(restored).toContain(line);
		}
		expect(extractOriginalDescriptionBody(restored)).toBe(ORIGINAL_BODY);
		expect(restored).not.toContain(
			"The login button does not respond to the first click.",
		);
		// The rest of the model's card survives, and the heading line is carried
		// over unchanged — decoration included, since the normalized form is
		// match-only and must never be written back.
		expect(restored).toContain("## Steps to Reproduce");
		expect(restored).toContain("## Environment");
		expect(restored).toContain("Chrome 120, Windows 11");
		expect(restored).toContain(HIGHLIGHTED_HEADING);
	});

	it("restores the full body under an undecorated heading (unchanged behaviour)", () => {
		const mutated = bugCard(PLAIN_HEADING).replace(
			ORIGINAL_BODY,
			"shortened",
		);
		const restored = spliceOriginalDescription(mutated, ORIGINAL_BODY);
		expect(extractOriginalDescriptionBody(restored)).toBe(ORIGINAL_BODY);
		expect(restored).toContain("## Environment");
		expect(restored).not.toContain("shortened");
	});

	it("keeps a DECORATED following heading as the splice boundary", () => {
		const mutated = [
			HIGHLIGHTED_HEADING,
			"model rewrote this",
			"## **Environment**",
			"Chrome 120, Windows 11",
		].join("\n");
		const restored = spliceOriginalDescription(mutated, ORIGINAL_BODY);
		// Environment survives as its own section — proof the terminator matched
		// and the splice did not eat the tail of the document.
		expect(restored).toContain("## **Environment**");
		expect(restored).toContain("Chrome 120, Windows 11");
		expect(restored).not.toContain("model rewrote this");
		expect(extractOriginalDescriptionBody(restored)).toBe(ORIGINAL_BODY);
	});

	it("is a no-op when the section is absent", () => {
		const card = "## Steps to Reproduce\n1. Open /login\n";
		expect(spliceOriginalDescription(card, ORIGINAL_BODY)).toBe(card);
	});
});
