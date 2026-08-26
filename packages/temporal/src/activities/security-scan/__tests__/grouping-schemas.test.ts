import { describe, expect, it } from "vitest";
import {
	assembleTicketBody,
	buildNewFindingsSummary,
	categoryLabel,
	deriveFindingScanner,
	describeFindingScanner,
	type GroupingFindingInput,
	mapRawTicketDraftToContent,
	maxSeverityToPriority,
	type RawTicketDraft,
	TicketDraftSchema,
} from "../grouping-schemas";

function makeFinding(
	overrides: Partial<GroupingFindingInput> = {},
): GroupingFindingInput {
	return {
		title: "Hardcoded credential in config",
		severity: "HIGH",
		description: "A credential is embedded directly in the config file.",
		location: "Document: config.yaml",
		confidence: 0.9,
		...overrides,
	};
}

describe("TicketDraftSchema — lenient schema (ADR-007)", () => {
	it("accepts a minimal object with every field omitted, without throwing", () => {
		expect(() => TicketDraftSchema.parse({})).not.toThrow();
		const parsed = TicketDraftSchema.parse({});
		expect(parsed.title).toBeUndefined();
		expect(parsed.summary).toBeUndefined();
		expect(parsed.remediation).toBeUndefined();
	});

	it("accepts a fully-populated object", () => {
		const parsed = TicketDraftSchema.parse({
			title: "Exposed credentials in Git history",
			summary: "Several secrets were found across the commit history.",
			remediation: "Rotate every exposed credential and purge history.",
		});
		expect(parsed.title).toBe("Exposed credentials in Git history");
	});

	it("accepts arbitrary free-text values (black-box proof there is no z.enum restricting the field)", () => {
		// If any field were a z.enum, an arbitrary out-of-set string would fail
		// to parse. Every field here is a plain optional string (lenient — see
		// file header), so arbitrary prose must always be accepted.
		const parsed = TicketDraftSchema.parse({
			title: "not one of a fixed set of literal values",
			summary: "also arbitrary free text, not restricted to an enum",
			remediation: "same here — arbitrary free text",
		});
		expect(parsed.title).toBe("not one of a fixed set of literal values");
		expect(parsed.summary).toBe(
			"also arbitrary free text, not restricted to an enum",
		);
		expect(parsed.remediation).toBe("same here — arbitrary free text");
	});

	it("rejects a non-string value for title (proof the field is z.string(), not z.preprocess'd-anything)", () => {
		const result = TicketDraftSchema.safeParse({ title: 12345 });
		expect(result.success).toBe(false);
	});
});

describe("mapRawTicketDraftToContent — fallbacks", () => {
	const theme = {
		category: "SECURITY" as const,
		ruleSource: "OWASP Top 10 — A03:2021 Injection",
		findingCount: 3,
	};

	it("uses the raw title/summary/remediation verbatim when all are present", () => {
		const raw: RawTicketDraft = {
			title: "Raw SQL string concatenation",
			summary: "User input flows unsanitized into a SQL query.",
			remediation: "Use parameterized queries everywhere.",
		};
		const content = mapRawTicketDraftToContent(raw, theme);
		expect(content.title).toBe("Raw SQL string concatenation");
		expect(content.summary).toBe(
			"User input flows unsanitized into a SQL query.",
		);
		expect(content.remediation).toBe(
			"Use parameterized queries everywhere.",
		);
	});

	it("falls back to theme.ruleSource verbatim when title is omitted", () => {
		const content = mapRawTicketDraftToContent({}, theme);
		expect(content.title).toBe(theme.ruleSource);
	});

	it("falls back to theme.ruleSource verbatim when title is blank/whitespace-only", () => {
		const content = mapRawTicketDraftToContent({ title: "   " }, theme);
		expect(content.title).toBe(theme.ruleSource);
	});

	it("falls back to a deterministic sentence when summary is omitted", () => {
		const content = mapRawTicketDraftToContent({}, theme);
		expect(content.summary.length).toBeGreaterThan(0);
		expect(content.summary).toContain(String(theme.findingCount));
		expect(content.summary).toContain(theme.ruleSource);
		// Deterministic — calling again with the same input yields byte-identical text.
		const again = mapRawTicketDraftToContent({}, theme);
		expect(again.summary).toBe(content.summary);
	});

	it("falls back to a deterministic sentence when remediation is omitted", () => {
		const content = mapRawTicketDraftToContent({}, theme);
		expect(content.remediation.length).toBeGreaterThan(0);
		const again = mapRawTicketDraftToContent({}, theme);
		expect(again.remediation).toBe(content.remediation);
	});

	it("never leaves any section blank even when the drafting call returns nothing usable", () => {
		const content = mapRawTicketDraftToContent(
			{ title: "", summary: "", remediation: "" },
			theme,
		);
		expect(content.title).toBe(theme.ruleSource);
		expect(content.summary.length).toBeGreaterThan(0);
		expect(content.remediation.length).toBeGreaterThan(0);
	});
});

describe("categoryLabel", () => {
	it("maps SECURITY -> Security and ACCESSIBILITY -> Accessibility", () => {
		expect(categoryLabel("SECURITY")).toBe("Security");
		expect(categoryLabel("ACCESSIBILITY")).toBe("Accessibility");
	});
});

describe("maxSeverityToPriority — D5 tight 1:1 mapping", () => {
	it("maps each single severity to its corresponding priority", () => {
		expect(maxSeverityToPriority([{ severity: "CRITICAL" }])).toBe(
			"P0_CRITICAL",
		);
		expect(maxSeverityToPriority([{ severity: "HIGH" }])).toBe("P1_HIGH");
		expect(maxSeverityToPriority([{ severity: "MEDIUM" }])).toBe(
			"P2_MEDIUM",
		);
		expect(maxSeverityToPriority([{ severity: "LOW" }])).toBe("P3_LOW");
	});

	it("mixed-severity theme (CRITICAL + LOW) resolves to P0_CRITICAL — highest severity wins", () => {
		const findings = [
			{ severity: "CRITICAL" },
			{ severity: "LOW" },
		] as const;
		expect(maxSeverityToPriority(findings)).toBe("P0_CRITICAL");
	});

	it("is order-independent — the max wins regardless of array position", () => {
		expect(
			maxSeverityToPriority([
				{ severity: "LOW" },
				{ severity: "MEDIUM" },
				{ severity: "CRITICAL" },
				{ severity: "HIGH" },
			]),
		).toBe("P0_CRITICAL");
		expect(
			maxSeverityToPriority([
				{ severity: "LOW" },
				{ severity: "MEDIUM" },
			]),
		).toBe("P2_MEDIUM");
	});
});

describe("deriveFindingScanner / describeFindingScanner — ported scanner attribution (PR #1658)", () => {
	it("attributes a Semgrep-prefixed ruleSource to SEMGREP", () => {
		expect(
			deriveFindingScanner(
				"Semgrep: js.express.audit.xss.foo",
				"SECURITY",
			),
		).toBe("SEMGREP");
		expect(
			describeFindingScanner(
				"Semgrep: js.express.audit.xss.foo",
				"SECURITY",
			),
		).toBe("Semgrep");
	});

	it("attributes a 'Secret history:'-prefixed ruleSource to GIT_HISTORY", () => {
		expect(
			deriveFindingScanner(
				"Secret history: aws-access-token",
				"SECURITY",
			),
		).toBe("GIT_HISTORY");
		expect(
			describeFindingScanner(
				"Secret history: aws-access-token",
				"SECURITY",
			),
		).toBe("Git history");
	});

	it("attributes an unprefixed SECURITY ruleSource to AI_SECURITY", () => {
		expect(
			deriveFindingScanner(
				"OWASP Top 10 — A03:2021 Injection",
				"SECURITY",
			),
		).toBe("AI_SECURITY");
		expect(
			describeFindingScanner(
				"OWASP Top 10 — A03:2021 Injection",
				"SECURITY",
			),
		).toBe("AI review");
	});

	it("attributes an unprefixed ACCESSIBILITY ruleSource to AI_ACCESSIBILITY", () => {
		expect(
			deriveFindingScanner(
				"WCAG 2.1 AA — 1.4.3 Contrast (Minimum)",
				"ACCESSIBILITY",
			),
		).toBe("AI_ACCESSIBILITY");
		expect(
			describeFindingScanner(
				"WCAG 2.1 AA — 1.4.3 Contrast (Minimum)",
				"ACCESSIBILITY",
			),
		).toBe("AI review");
	});

	it("attributes a Custom-prefixed ruleSource to the category's AI reviewer (not a distinct engine)", () => {
		// "Custom: <rule name>" isn't a Semgrep/git-history prefix, so it falls
		// through to the category-based AI attribution — matching the frontend
		// original exactly (only Semgrep/Secret-history are distinct engines).
		expect(deriveFindingScanner("Custom: Acme PII Rule", "SECURITY")).toBe(
			"AI_SECURITY",
		);
	});
});

describe("assembleTicketBody — deterministic Markdown assembly (§6)", () => {
	const draft = {
		title: "Exposed credentials in Git history",
		summary:
			"Several credentials were committed to the repository history.",
		remediation: "Rotate every exposed credential and purge git history.",
	};

	it("includes all five sections in order", () => {
		const body = assembleTicketBody({
			category: "SECURITY",
			ruleSource: "Secret history: aws-access-token",
			findings: [makeFinding()],
			draft,
			scanCompletedAt: new Date("2026-06-30T12:00:00.000Z"),
		});
		const summaryIndex = body.indexOf("## Summary");
		const severityIndex = body.indexOf("## Severity breakdown");
		const findingsIndex = body.indexOf("## Findings");
		const remediationIndex = body.indexOf("## Suggested remediation");
		const sourceIndex = body.indexOf("## Source");

		expect(summaryIndex).toBeGreaterThanOrEqual(0);
		expect(severityIndex).toBeGreaterThan(summaryIndex);
		expect(findingsIndex).toBeGreaterThan(severityIndex);
		expect(remediationIndex).toBeGreaterThan(findingsIndex);
		expect(sourceIndex).toBeGreaterThan(remediationIndex);

		expect(body).toContain(draft.summary);
		expect(body).toContain(draft.remediation);
	});

	it("shows the finding count in the Findings header and numbers each finding", () => {
		const body = assembleTicketBody({
			category: "SECURITY",
			ruleSource: "OWASP Top 10 — A03:2021 Injection",
			findings: [
				makeFinding({ title: "Finding A" }),
				makeFinding({ title: "Finding B" }),
			],
			draft,
			scanCompletedAt: null,
		});
		expect(body).toContain("## Findings (2)");
		expect(body).toContain("1. **Finding A**");
		expect(body).toContain("2. **Finding B**");
	});

	it("includes a Confidence suffix only when confidence is present", () => {
		const withConfidence = assembleTicketBody({
			category: "SECURITY",
			ruleSource: "OWASP Top 10 — A03:2021 Injection",
			findings: [makeFinding({ confidence: 0.75 })],
			draft,
			scanCompletedAt: null,
		});
		expect(withConfidence).toContain("Confidence: 0.75");

		const withoutConfidence = assembleTicketBody({
			category: "SECURITY",
			ruleSource: "OWASP Top 10 — A03:2021 Injection",
			findings: [makeFinding({ confidence: null })],
			draft,
			scanCompletedAt: null,
		});
		expect(withoutConfidence).not.toContain("Confidence:");
	});

	it("falls back to 'Not specified' when a finding has no location", () => {
		const body = assembleTicketBody({
			category: "SECURITY",
			ruleSource: "OWASP Top 10 — A03:2021 Injection",
			findings: [makeFinding({ location: null })],
			draft,
			scanCompletedAt: null,
		});
		expect(body).toContain("Location: Not specified");
	});

	it("attributes the Source section via the ported scanner-derivation helper", () => {
		const semgrepBody = assembleTicketBody({
			category: "SECURITY",
			ruleSource: "Semgrep: js.rule.foo",
			findings: [makeFinding()],
			draft,
			scanCompletedAt: null,
		});
		expect(semgrepBody).toContain("Detected by: Semgrep");

		const aiBody = assembleTicketBody({
			category: "ACCESSIBILITY",
			ruleSource: "WCAG 2.1 AA — 1.4.3 Contrast (Minimum)",
			findings: [makeFinding({ severity: "MEDIUM" })],
			draft,
			scanCompletedAt: null,
		});
		expect(aiBody).toContain("Detected by: AI review");
	});

	it("formats the scan-completed timestamp, and shows 'Unknown' when null", () => {
		const withDate = assembleTicketBody({
			category: "SECURITY",
			ruleSource: "OWASP Top 10 — A03:2021 Injection",
			findings: [makeFinding()],
			draft,
			scanCompletedAt: new Date("2026-06-30T12:00:00.000Z"),
		});
		expect(withDate).toContain("Scan: completed 2026-06-30T12:00:00.000Z");

		const withoutDate = assembleTicketBody({
			category: "SECURITY",
			ruleSource: "OWASP Top 10 — A03:2021 Injection",
			findings: [makeFinding()],
			draft,
			scanCompletedAt: null,
		});
		expect(withoutDate).toContain("Scan: completed Unknown");
	});

	describe("mixed-severity edge case (critical spec requirement)", () => {
		it("a theme with a CRITICAL + a LOW finding: priority is P0_CRITICAL, but the breakdown shows BOTH counts", () => {
			const findings = [
				makeFinding({ title: "Critical issue", severity: "CRITICAL" }),
				makeFinding({ title: "Low issue", severity: "LOW" }),
			];

			// Priority derivation (maxSeverityToPriority) — highest wins.
			expect(maxSeverityToPriority(findings)).toBe("P0_CRITICAL");

			// The assembled description must still show BOTH per-severity
			// counts, not just the max — this is the whole point of the
			// "full breakdown" requirement.
			const body = assembleTicketBody({
				category: "SECURITY",
				ruleSource: "OWASP Top 10 — A01:2021 Broken Access Control",
				findings,
				draft,
				scanCompletedAt: null,
			});
			expect(body).toContain(
				"- Critical: 1   - High: 0   - Medium: 0   - Low: 1",
			);
			// Both findings still individually enumerated too.
			expect(body).toContain("1. **Critical issue** — Critical");
			expect(body).toContain("2. **Low issue** — Low");
		});
	});
});

describe("buildNewFindingsSummary — incremental AGENT comment body (D11)", () => {
	it("headlines the new-finding count (singular)", () => {
		const body = buildNewFindingsSummary([makeFinding()]);
		expect(body).toContain("Found 1 new finding for this theme");
	});

	it("headlines the new-finding count (plural)", () => {
		const body = buildNewFindingsSummary([
			makeFinding({ title: "A" }),
			makeFinding({ title: "B" }),
		]);
		expect(body).toContain("Found 2 new findings for this theme");
		expect(body).toContain("1. **A**");
		expect(body).toContain("2. **B**");
	});

	it("renders each finding identically to the ticket body's Findings section", () => {
		const finding = makeFinding({ confidence: 0.75, location: null });
		const summary = buildNewFindingsSummary([finding]);
		const ticketBody = assembleTicketBody({
			category: "SECURITY",
			ruleSource: "OWASP Top 10 — A03:2021 Injection",
			findings: [finding],
			draft: { title: "t", summary: "s", remediation: "r" },
			scanCompletedAt: null,
		});
		// Same per-finding rendering (title/severity/confidence/location/
		// description) in both surfaces — only the surrounding header differs.
		expect(summary).toContain(
			"1. **Hardcoded credential in config** — High, Confidence: 0.75",
		);
		expect(ticketBody).toContain(
			"1. **Hardcoded credential in config** — High, Confidence: 0.75",
		);
		expect(summary).toContain("Location: Not specified");
		expect(ticketBody).toContain("Location: Not specified");
	});
});
