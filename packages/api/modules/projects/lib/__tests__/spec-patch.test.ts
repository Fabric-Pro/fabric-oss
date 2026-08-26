// Deterministic core of decision-driven spec propagation (Feature Maturation V2).
// Proves a confirmed Decision applies as a scoped `{ from, to }` patch to the
// existing freetext Clean Spec without rewriting the whole document and without
// stored anchors. The model half (does the LLM emit a tight patch?) is validated
// separately against the live AI gateway.

import { describe, expect, it } from "vitest";
import { applySpecPatch, applySpecPatches } from "../spec-patch";

// A realistic Clean Spec as stored today: freetext markdown, description plus an
// `## Acceptance Criteria` section (the shape `story-content.ts` splits on save).
const SPEC = `# Login

Users need to authenticate before reaching the dashboard.

## Acceptance Criteria

- AC#1: The user can log in via email and password.
- AC#2: The user can reset a forgotten password via emailed link.
- AC#3: The user is locked out after 5 failed attempts.`;

describe("applySpecPatch (scoped, no stored anchors)", () => {
	it("replaces only the targeted block; everything else stays byte-identical", () => {
		const out = applySpecPatch(
			SPEC,
			"- AC#1: The user can log in via email and password.",
			"- AC#1: The user logs in via email only — no MFA for now.",
		);
		expect(out.ok).toBe(true);
		if (!out.ok) {
			return;
		}
		expect(out.result).toContain("via email only — no MFA for now.");
		expect(out.result).toContain(
			"- AC#2: The user can reset a forgotten password",
		);
		expect(out.result).toContain("# Login");
		expect(out.result).toContain("## Acceptance Criteria");
		// Exactly one line differs between the old and new document.
		const before = SPEC.split("\n");
		const after = out.result.split("\n");
		const changed = before.filter((line, i) => line !== after[i]);
		expect(changed).toEqual([
			"- AC#1: The user can log in via email and password.",
		]);
	});

	it("patches a description paragraph without disturbing the AC section", () => {
		const out = applySpecPatch(
			SPEC,
			"Users need to authenticate before reaching the dashboard.",
			"Users authenticate via email magic-link before reaching the dashboard.",
		);
		expect(out.ok).toBe(true);
		if (!out.ok) {
			return;
		}
		expect(out.result).toContain(
			"magic-link before reaching the dashboard",
		);
		expect(out.result).toContain(
			"- AC#1: The user can log in via email and password.",
		);
	});

	it("deletes a block when `to` is empty", () => {
		const out = applySpecPatch(
			SPEC,
			"- AC#2: The user can reset a forgotten password via emailed link.",
			"",
		);
		expect(out.ok).toBe(true);
		if (!out.ok) {
			return;
		}
		expect(out.result).not.toContain("reset a forgotten password");
		expect(out.result).toContain("- AC#3:");
	});

	it("tolerates differing surrounding whitespace/indentation in `from`", () => {
		const out = applySpecPatch(
			SPEC,
			"  - AC#3: The user is locked out after 5 failed attempts.  ",
			"- AC#3: The user is locked out after 3 failed attempts.",
		);
		expect(out.ok).toBe(true);
		if (!out.ok) {
			return;
		}
		expect(out.result).toContain("after 3 failed attempts.");
	});

	it("matches a multi-line block", () => {
		const out = applySpecPatch(
			SPEC,
			"## Acceptance Criteria\n\n- AC#1: The user can log in via email and password.",
			"## Acceptance Criteria\n\n- AC#1: The user logs in via SSO.",
		);
		expect(out.ok).toBe(true);
		if (!out.ok) {
			return;
		}
		expect(out.result).toContain("- AC#1: The user logs in via SSO.");
		expect(out.result).toContain("- AC#2:");
	});

	it("refuses (not-found) rather than corrupting the doc when the block is missing", () => {
		const out = applySpecPatch(SPEC, "- AC#9: nonexistent criterion.", "x");
		expect(out.ok).toBe(false);
		if (out.ok) {
			return;
		}
		expect(out.reason).toBe("not-found");
	});

	it("refuses (ambiguous) when the block appears more than once", () => {
		const dup = `${SPEC}\n- AC#1: The user can log in via email and password.`;
		const out = applySpecPatch(
			dup,
			"- AC#1: The user can log in via email and password.",
			"changed",
		);
		expect(out.ok).toBe(false);
		if (out.ok) {
			return;
		}
		expect(out.reason).toBe("ambiguous");
		expect(out.matchCount).toBe(2);
	});

	it("refuses (empty) when `from` is blank", () => {
		const out = applySpecPatch(SPEC, "   \n  ", "x");
		expect(out.ok).toBe(false);
		if (out.ok) {
			return;
		}
		expect(out.reason).toBe("empty");
	});
});

describe("applySpecPatches (batch)", () => {
	it("applies landed patches and reports failures without throwing", () => {
		const batch = applySpecPatches(SPEC, [
			{
				from: "- AC#1: The user can log in via email and password.",
				to: "- AC#1: The user logs in via email only.",
				summary: "Decided: email-only login, defer MFA.",
			},
			{
				from: "- AC#404: does not exist.",
				to: "- AC#404: ...",
				summary: "Should fail cleanly.",
			},
		]);
		expect(batch.applied).toHaveLength(1);
		expect(batch.failed).toHaveLength(1);
		expect(batch.result).toContain("logs in via email only.");
		expect(batch.failed[0]?.reason).toBe("not-found");
	});

	it("returns the original document when every patch fails", () => {
		const batch = applySpecPatches(SPEC, [
			{ from: "nope", to: "x", summary: "no-op" },
		]);
		expect(batch.result).toBe(SPEC);
		expect(batch.applied).toHaveLength(0);
	});
});

describe("applySpecPatch — sub-line fragment fallback", () => {
	// The exact shape that refused against a real staging spec: the model
	// returned a clause WITHIN a longer description line, not a whole line.
	const LINE =
		"The generated PDF should include all currently visible data (respecting applied filters), be formatted for readability, and include a timestamp and the user's name in the document header.";

	it("applies a unique sub-line fragment (whole-line match misses)", () => {
		const out = applySpecPatch(
			LINE,
			"be formatted for readability, and include a timestamp and the user's name in the document header.",
			"be formatted for readability, and include the organization name, the user's name, and a timestamp in the document header.",
		);
		expect(out.ok).toBe(true);
		if (!out.ok) {
			return;
		}
		expect(out.result).toContain("(respecting applied filters),"); // prefix kept
		expect(out.result).toContain("include the organization name,");
		expect(out.result).not.toContain(
			"a timestamp and the user's name in the document header.",
		);
	});

	it("refuses an ambiguous fragment that appears more than once", () => {
		const out = applySpecPatch(
			"see the header. then see the header.",
			"see the header.",
			"see the footer.",
		);
		expect(out.ok).toBe(false);
		if (out.ok) {
			return;
		}
		expect(out.reason).toBe("ambiguous");
		expect(out.matchCount).toBe(2);
	});

	it("still refuses a fragment that is absent entirely", () => {
		const out = applySpecPatch(LINE, "a clause not in the line", "x");
		expect(out.ok).toBe(false);
		if (out.ok) {
			return;
		}
		expect(out.reason).toBe("not-found");
	});

	it("inserts `to` literally even when it contains `$` sequences", () => {
		const out = applySpecPatch(
			"charge the AMOUNT now",
			"AMOUNT",
			"$5 and $10",
		);
		expect(out.ok).toBe(true);
		if (!out.ok) {
			return;
		}
		expect(out.result).toBe("charge the $5 and $10 now");
	});
});
