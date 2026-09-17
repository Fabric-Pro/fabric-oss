import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Publishing Suite's confirm-time change summary.
 *
 * Mirrors `summarize-spec-changes.test.ts` for the shared mechanics (trimming,
 * the identical-input short-circuit, the role clause), and then pins the thing
 * that is different and that can actually break in production: the SECTION
 * VOCABULARY, and whether a bullet built from it can be resolved by the web
 * layer's click handler.
 *
 * `parseBulletSection` below is a copy of `scrollDiffToSection`'s parse in
 * `StoryWorkspace.tsx`, and `findTargetHeading` a copy of its match. They are
 * copied rather than imported because that code lives in `apps/web` and is a
 * DOM walk over the TipTap editor; what is portable is the two string
 * operations it performs, and those are the entire contract between this
 * producer and that consumer. If either changes there, these tests are where
 * the producer finds out.
 */

const mocks = vi.hoisted(() => ({
	getAIModelWithMetadata: vi.fn(),
	generateObject: vi.fn(),
	getProjectFunctionTagClause: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: mocks.getAIModelWithMetadata,
	generateObject: mocks.generateObject,
}));

vi.mock("@repo/ai/lib/function-tag-context", () => ({
	getProjectFunctionTagClause: mocks.getProjectFunctionTagClause,
}));

const {
	summarizeAnalysisChanges,
	buildAnalysisChangeSummaryPrompt,
	collectAnalysisSections,
	PLANNING_ANALYSIS_SECTIONS,
} = await import("../summarize-analysis-changes");

const tenantFilter = { organizationId: "org-1", userId: "user-1" } as const;

/** `scrollDiffToSection`'s parse, verbatim. */
function parseBulletSection(bullet: string): string | undefined {
	return bullet.split(" — ")[0]?.trim().toLowerCase();
}

/** `scrollDiffToSection`'s match against the rendered headings, verbatim. */
function findTargetHeading(
	headings: string[],
	section: string,
): string | undefined {
	return headings.find((h) => h.trim().toLowerCase().startsWith(section));
}

/** The headings the editor renders for a Markdown document under review. */
function renderedHeadings(...documents: string[]): string[] {
	return documents.flatMap((doc) =>
		doc
			.split("\n")
			.map((line) => /^#{1,6}\s+(.+)$/.exec(line.trim())?.[1])
			.filter((h): h is string => h !== undefined),
	);
}

const STOCK_ANALYSIS = `### Topic angle
The migration, told as a before and after.

### Why worth publishing
Nobody else has written this up.

### Key details
  Released:
    The new pipeline.
  The problem:
    Builds took forty minutes.

### Recommended authors
The two engineers who did the work.

### Risks
Names a customer by name.`;

const REWRITTEN_ANALYSIS = `### Topic angle
The migration, told as a cost story.

### Why worth publishing
Nobody else has written this up.

### Key details
  Released:
    The new pipeline.
  The problem:
    Builds took forty minutes.

### Recommended authors
The staff engineer who led it.

### Audience and distribution fit
Platform leads evaluating build tooling.`;

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		m.mockReset();
	}
	mocks.getAIModelWithMetadata.mockResolvedValue({ model: {} });
	mocks.getProjectFunctionTagClause.mockResolvedValue("");
});

describe("collectAnalysisSections", () => {
	it("takes the vocabulary from the two documents, as their UNION", () => {
		const sections = collectAnalysisSections(
			STOCK_ANALYSIS,
			REWRITTEN_ANALYSIS,
		);

		// From `after` only — a section the rewrite added.
		expect(sections).toContain("Audience and distribution fit");
		// From `before` only — a section the rewrite dropped. It still renders
		// in the diff document inside a deletion mark, so a removal bullet
		// naming it is still clickable.
		expect(sections).toContain("Risks");
	});

	it("deduplicates case-insensitively and keeps the first spelling", () => {
		const sections = collectAnalysisSections(
			"### Topic Angle\nbefore",
			"### topic angle\nafter",
		);
		expect(sections).toEqual(["Topic Angle"]);
	});

	it("sees a heading the author decorated in the editor", () => {
		// TipTap emits these the moment somebody bolds or highlights a heading.
		const sections = collectAnalysisSections(
			"### **Risks**\nbefore",
			'### <mark data-color="#fde68a">Risks</mark>\nafter',
		);
		expect(sections).toEqual(["Risks"]);
	});

	it("never promotes a decorated BODY line into a section", () => {
		// `stripInlineDecoration`'s heading-forgery guard: an inline-code line
		// normalizes to heading shape and must not be treated as one.
		const sections = collectAnalysisSections(
			"### Risks\n`### Not a section`",
			"### Risks\nstill one section",
		);
		expect(sections).toEqual(["Risks"]);
	});

	it("falls back to the schema-derived sections when neither version has a heading", () => {
		expect(collectAnalysisSections("plain before", "plain after")).toEqual([
			...PLANNING_ANALYSIS_SECTIONS,
		]);
	});
});

describe("PLANNING_ANALYSIS_SECTIONS — derived, never hand-copied", () => {
	/**
	 * The discrepancy this constant exists to avoid. `apps/web`'s
	 * `planning-analysis-content.ts` labels `whyWorthPublishing` "Why this is
	 * worth publishing"; `renderAnalysisProse` emits "Why worth publishing".
	 * The click handler matches with `startsWith`, so the longer label never
	 * matches the shorter heading — copying the wrong list is a silent,
	 * whole-section failure, not a typo.
	 */
	it("matches what renderAnalysisProse actually emits, not the web labels", () => {
		expect(PLANNING_ANALYSIS_SECTIONS).toContain("Why worth publishing");
		expect(PLANNING_ANALYSIS_SECTIONS).not.toContain(
			"Why this is worth publishing",
		);
	});

	it("covers every prose section the generator can write", () => {
		expect(PLANNING_ANALYSIS_SECTIONS).toEqual([
			"Topic angle",
			"Why worth publishing",
			"Key details",
			"Recommended authors",
			"Author voice and perspective",
			"Audience and distribution fit",
			"Risks",
			"Pre draft guidance",
		]);
	});
});

describe("the bullet format the click handler has to parse", () => {
	it("every allowed section resolves to a heading the editor renders", () => {
		const headings = renderedHeadings(STOCK_ANALYSIS, REWRITTEN_ANALYSIS);

		for (const section of collectAnalysisSections(
			STOCK_ANALYSIS,
			REWRITTEN_ANALYSIS,
		)) {
			const bullet = `${section} — the change the model described`;
			const parsed = parseBulletSection(bullet);
			expect(parsed).toBeDefined();
			expect(findTargetHeading(headings, parsed as string)).toBeDefined();
		}
	});

	it("resolves a RENAMED heading, which a schema-derived list could not", () => {
		const renamed = STOCK_ANALYSIS.replace(
			"### Risks",
			"### Legal and disclosure risks",
		);
		const sections = collectAnalysisSections(renamed, renamed);

		expect(sections).toContain("Legal and disclosure risks");
		// The stock name is gone from the author's document, so it must not be
		// offered: a bullet prefixed "Risks" would find no heading to scroll to.
		expect(sections).not.toContain("Risks");

		const parsed = parseBulletSection(
			"Legal and disclosure risks — added a customer-consent caveat",
		);
		expect(
			findTargetHeading(renderedHeadings(renamed), parsed as string),
		).toBe("Legal and disclosure risks");
	});

	it("a nested keyDetails label is NOT a section — the prompt forbids it", () => {
		const headings = renderedHeadings(STOCK_ANALYSIS);
		// `renderValue` writes these as indented body lines under "Key details",
		// so a bullet filed under one is permanently dead.
		const parsed = parseBulletSection(
			"The problem — restated the build time in developer-hours",
		);
		expect(findTargetHeading(headings, parsed as string)).toBeUndefined();

		expect(
			buildAnalysisChangeSummaryPrompt("a", "b", ["Key details"]),
		).toMatch(/body text, not sections/i);
	});
});

describe("buildAnalysisChangeSummaryPrompt", () => {
	it("lists the allowed sections and demands them verbatim", () => {
		const prompt = buildAnalysisChangeSummaryPrompt("old", "new", [
			"Topic angle",
			"Audience and distribution fit",
		]);
		expect(prompt).toContain("  - Topic angle");
		expect(prompt).toContain("  - Audience and distribution fit");
		expect(prompt).toMatch(/copied VERBATIM/);
		expect(prompt).toMatch(/never invent a section/i);
	});

	it("asks for the em-dash separator the click handler splits on", () => {
		expect(
			buildAnalysisChangeSummaryPrompt("old", "new", ["Risks"]),
		).toContain('" — "');
	});

	it("prompts for additions, not just removals", () => {
		const prompt = buildAnalysisChangeSummaryPrompt("old", "new", [
			"Risks",
		]);
		expect(prompt).toMatch(/additions equal weight to removals/i);
		expect(prompt).toMatch(/removal-only summary/i);
	});

	it("is about a planning analysis, never a feature specification", () => {
		const prompt = buildAnalysisChangeSummaryPrompt("old", "new", [
			"Risks",
		]);
		expect(prompt).toContain("Planning & Analysis");
		expect(prompt).not.toMatch(/feature specification/i);
	});

	it("renders an empty version as (empty) rather than a blank block", () => {
		expect(
			buildAnalysisChangeSummaryPrompt("", "new", ["Risks"]),
		).toContain("PREVIOUS VERSION:\n(empty)");
	});
});

describe("summarizeAnalysisChanges", () => {
	it("returns the model's bullets (trimmed, non-empty) for a real change", async () => {
		mocks.generateObject.mockResolvedValue({
			object: {
				changeSummary: [
					"  Topic angle — retold the migration as a cost story  ",
					"",
					"Recommended authors — narrowed to the staff engineer who led it",
				],
			},
		});

		const out = await summarizeAnalysisChanges({
			before: STOCK_ANALYSIS,
			after: REWRITTEN_ANALYSIS,
			tenantFilter,
			projectId: "project-1",
		});

		expect(out).toEqual([
			"Topic angle — retold the migration as a cost story",
			"Recommended authors — narrowed to the staff engineer who led it",
		]);
		expect(mocks.generateObject).toHaveBeenCalledTimes(1);
	});

	it("short-circuits to [] without a model call when before === after", async () => {
		const out = await summarizeAnalysisChanges({
			before: "  same  ",
			after: "same",
			tenantFilter,
			projectId: "project-1",
		});

		expect(out).toEqual([]);
		expect(mocks.getAIModelWithMetadata).not.toHaveBeenCalled();
		expect(mocks.generateObject).not.toHaveBeenCalled();
	});

	it("tags the call `publishing-suite`, so the suite's dashboards can add it up", async () => {
		mocks.generateObject.mockResolvedValue({
			object: { changeSummary: [] },
		});

		await summarizeAnalysisChanges({
			before: "old",
			after: "new",
			tenantFilter,
			projectId: "project-1",
		});

		expect(mocks.getAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "COMPLEX" },
			{
				userId: "user-1",
				organizationId: "org-1",
				featureKey: "publishing-suite",
			},
		);
	});

	it("resolves the model with no org when the project has none", async () => {
		mocks.generateObject.mockResolvedValue({
			object: { changeSummary: [] },
		});

		await summarizeAnalysisChanges({
			before: "old",
			after: "new",
			tenantFilter: { organizationId: null, userId: "user-1" },
			projectId: "project-1",
		});

		expect(mocks.getAIModelWithMetadata.mock.calls[0][1]).toEqual({
			userId: "user-1",
			organizationId: undefined,
			featureKey: "publishing-suite",
		});
	});

	it("builds the prompt from the sections in the two versions it was given", async () => {
		mocks.generateObject.mockResolvedValue({
			object: { changeSummary: [] },
		});

		await summarizeAnalysisChanges({
			before: STOCK_ANALYSIS,
			after: REWRITTEN_ANALYSIS,
			tenantFilter,
			projectId: "project-1",
		});

		const prompt = mocks.generateObject.mock.calls[0][0].prompt;
		expect(prompt).toContain("  - Audience and distribution fit");
		expect(prompt).toContain("  - Risks");
		// Not in either version, so it must not be offered.
		expect(prompt).not.toContain("  - Pre draft guidance");
	});

	it("lets a model failure THROW rather than degrading it into an empty summary", async () => {
		mocks.generateObject.mockRejectedValue(new Error("model refused"));

		await expect(
			summarizeAnalysisChanges({
				before: "old",
				after: "new",
				tenantFilter,
				projectId: "project-1",
			}),
		).rejects.toThrow("model refused");
	});
});

describe("summarizeAnalysisChanges — function-tag role clause", () => {
	const ROLE_CLAUSE_SENTINEL =
		"PROJECT CONTRIBUTOR ROLES — sentinel-test-clause-summarize-analysis-changes";

	beforeEach(() => {
		mocks.generateObject.mockResolvedValue({
			object: { changeSummary: [] },
		});
	});

	it("flag ON: resolves the clause with the caller's project/user and appends it", async () => {
		mocks.getProjectFunctionTagClause.mockResolvedValue(
			ROLE_CLAUSE_SENTINEL,
		);

		await summarizeAnalysisChanges({
			before: "old",
			after: "new",
			tenantFilter,
			projectId: "project-1",
		});

		expect(mocks.getProjectFunctionTagClause).toHaveBeenCalledWith({
			projectId: "project-1",
			requesterUserId: "user-1",
			surface: "summarize-analysis-changes",
		});
		expect(mocks.generateObject.mock.calls[0][0].prompt).toContain(
			ROLE_CLAUSE_SENTINEL,
		);
	});

	it("flag OFF: prompt is byte-for-byte the no-clause assembly (no dangling separator)", async () => {
		mocks.getProjectFunctionTagClause.mockResolvedValue(
			ROLE_CLAUSE_SENTINEL,
		);
		await summarizeAnalysisChanges({
			before: "old",
			after: "new",
			tenantFilter,
			projectId: "project-1",
		});
		const withClause = mocks.generateObject.mock.calls[0][0].prompt;

		mocks.generateObject.mockClear();
		mocks.getProjectFunctionTagClause.mockResolvedValue("");
		await summarizeAnalysisChanges({
			before: "old",
			after: "new",
			tenantFilter,
			projectId: "project-1",
		});
		const withoutClause = mocks.generateObject.mock.calls[0][0].prompt;

		expect(withoutClause).not.toContain(ROLE_CLAUSE_SENTINEL);
		expect(withClause).toBe(`${withoutClause}\n\n${ROLE_CLAUSE_SENTINEL}`);
	});
});
