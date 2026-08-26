/**
 * Unit tests for the AI Update analyzer prompt construction.
 *
 * Locks in the DSU 2026-05-23 decision: the analyzer must no longer emit
 * `type: "story"` items. Story was producing duplicate Feature/Story
 * tickets for the same content. This file asserts the prompt forbids it
 * explicitly so future prompt edits don't regress the constraint.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		generateObject: vi.fn(),
		getAIModelWithMetadata: vi.fn(),
		logModelUsageAsync: vi.fn(),
		heartbeat: vi.fn(),
		setInterval: vi.fn(() => 1 as unknown as NodeJS.Timeout),
		clearInterval: vi.fn(),
		getBoundPromptForAgent: vi.fn(),
	},
}));

vi.mock("@repo/ai", () => ({
	generateObject: mocks.generateObject,
	getAIModelWithMetadata: mocks.getAIModelWithMetadata,
	logModelUsageAsync: mocks.logModelUsageAsync,
}));

vi.mock("@temporalio/activity", () => ({
	heartbeat: mocks.heartbeat,
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findFirst: vi.fn() },
	},
	tenantWhere: vi.fn(() => ({ organizationId: "org-1", userId: "user-1" })),
	// Fizzy #2048 (AC7): the analyzer resolves the type-specific body template
	// from the prompt catalog. Default is "nothing bound" so every pre-existing
	// assertion in this file keeps exercising the in-code fallback skeleton.
	getBoundPromptForAgent: mocks.getBoundPromptForAgent,
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

import {
	analyzeContextAndPropose,
	backlogChangeItemSchema,
	ChangeProposalSchema,
	extractWorkItemBodyStructure,
} from "../src/activities/backlog-context/analyze-context";
import {
	BUG_SIGNATURE_SECTIONS,
	detectDestructiveRewrite,
	extractSectionBody,
} from "../src/lib/structure-guards";

const EMPTY_BACKLOG = {
	epics: [],
	features: [],
	stories: [],
};

function makeAIModelMock() {
	return {
		model: { id: "test-model" } as unknown as object,
		metadata: {
			modelString: "anthropic:claude-test",
			provider: "anthropic",
			selectionSource: "test-fixture",
		},
		trackUsage: vi.fn(),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getBoundPromptForAgent.mockResolvedValue(null);
	mocks.getAIModelWithMetadata.mockResolvedValue(makeAIModelMock());
	mocks.generateObject.mockResolvedValue({
		object: { summary: "", contextSummary: "", changes: [] },
		usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
	});
});

describe("analyzer prompt — Story removal (DSU 2026-05-23)", () => {
	it('explicitly forbids emitting type: "story" anywhere in the system prompt', async () => {
		await analyzeContextAndPropose({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			fetchedContext: { teamsMessages: "some discussion" },
			existingBacklog: EMPTY_BACKLOG,
			userPrompt: "Analyze",
		});

		expect(mocks.generateObject).toHaveBeenCalledOnce();
		const callArgs = mocks.generateObject.mock.calls[0]?.[0];
		const prompt: string = callArgs.prompt;
		expect(prompt).toBeTypeOf("string");

		// Must explicitly tell the LLM not to use the retired story type.
		expect(prompt.toLowerCase()).toMatch(
			/do not propose .*type.*"?story"?|story.*has been retired|story.*forbidden|allowed leaf types.*feature.*bug/i,
		);
	});

	it("does NOT carry the old 'User Stories (type: story)' formatting section anymore", async () => {
		await analyzeContextAndPropose({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			fetchedContext: { teamsMessages: "some discussion" },
			existingBacklog: EMPTY_BACKLOG,
			userPrompt: "Analyze",
		});

		const callArgs = mocks.generateObject.mock.calls[0]?.[0];
		const prompt: string = callArgs.prompt;

		// The old section had the literal heading "User Stories (type: \"story\")".
		// If a future edit reintroduces it, this test fires.
		expect(prompt).not.toMatch(/User Stories \(type: "story"\)/);
		// And the "As a [role], I want [goal], so that [benefit]" pattern,
		// while still valid IN a feature, must not be tagged as belonging to
		// "type: story" anymore.
		expect(prompt).not.toMatch(/As a \[role\][\s\S]*type: "story"/);
	});

	it("PM tool constraint for flat tools instructs feature/bug, not story/bug", async () => {
		await analyzeContextAndPropose({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			fetchedContext: { teamsMessages: "some discussion" },
			existingBacklog: EMPTY_BACKLOG,
			userPrompt: "Analyze",
			pmToolType: "fizzy",
		});

		const callArgs = mocks.generateObject.mock.calls[0]?.[0];
		const prompt: string = callArgs.prompt;

		// New wording: "type: \"feature\"" or "type: \"bug\"". Old wording was
		// "type: \"story\"" or "type: \"bug\"". `[\s\S]*` instead of `.*/s`
		// to keep this file ES2017-compatible (the temporal tsconfig target
		// pre-dates the dotall regex flag).
		expect(prompt).toMatch(/type:\s*"feature"[\s\S]*type:\s*"bug"/);
		// The "ONLY propose" gate must explicitly forbid story (the most
		// brittle bit — easy to silently drift back).
		expect(prompt).toMatch(
			/Do NOT propose.*"?story"?|story.*has been retired/i,
		);
	});

	it("hierarchy rule references Epics → Features (no separate Story layer)", async () => {
		await analyzeContextAndPropose({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			fetchedContext: { teamsMessages: "some discussion" },
			existingBacklog: EMPTY_BACKLOG,
			userPrompt: "Analyze",
		});

		const callArgs = mocks.generateObject.mock.calls[0]?.[0];
		const prompt: string = callArgs.prompt;
		// The new hierarchy rule no longer mentions Stories as a layer.
		expect(prompt).not.toMatch(
			/Epics contain Features, Features contain Stories/,
		);
	});

	it('the GENERATION schema keeps type:"story" out of the result — story emission is structurally impossible', () => {
		// Story retirement is now enforced at the schema level, not via a
		// runtime warn: `generateObject` is called with `ChangeProposalSchema`,
		// whose `type` enum only permits epic/feature/bug. The model physically
		// cannot emit a User Story, so the old prompt-drift `logger.warn`
		// detector (and the warn block it asserted) was removed.
		const base = {
			action: "create" as const,
			title: { to: "Slipped through" },
			reasoning: "test",
			sourceContext: "teams_messages",
		};

		// `changes` validates element-wise, so a retired type is DROPPED rather
		// than rejecting the whole response with it. The guarantee this test
		// exists for is unchanged: a User Story never reaches the result.
		const storyResult = ChangeProposalSchema.safeParse({
			changes: [{ ...base, type: "story" }],
		});
		expect(storyResult.success).toBe(true);
		expect(storyResult.data?.changes).toHaveLength(0);

		// Positive control: the identical payload with an allowed leaf type
		// parses cleanly, proving the rejection is specifically the retired
		// "story" type — not some unrelated validation failure.
		const featureResult = ChangeProposalSchema.safeParse({
			changes: [{ ...base, type: "feature" }],
		});
		expect(featureResult.success).toBe(true);
		expect(featureResult.data?.changes).toHaveLength(1);
	});

	it("exposes exactly epic/feature/bug as the allowed generation types (no story)", () => {
		// Read off the element schema directly: `changes` is wrapped so it can
		// validate element-wise, so the element is exported rather than reached
		// through the array.
		const typeField = backlogChangeItemSchema.shape.type;
		expect(typeField.options).toEqual(["epic", "feature", "bug"]);
	});
});

describe("analyzer prompt — Epic suppression for channel-monitor flow (Bug 1429)", () => {
	it("with allowEpics:false, drops the 'large strategic initiatives' epic guidance", async () => {
		await analyzeContextAndPropose({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			fetchedContext: { teamsMessages: "some discussion" },
			existingBacklog: EMPTY_BACKLOG,
			userPrompt: "Analyze",
			allowEpics: false,
		});

		const callArgs = mocks.generateObject.mock.calls[0]?.[0];
		const prompt: string = callArgs.prompt;

		// Rule 8's epic description ("Use for large strategic initiatives that
		// span multiple features.") must NOT appear when epics are forbidden.
		expect(prompt).not.toMatch(/large strategic initiatives/i);
	});

	it("with allowEpics:false, adds an explicit 'do not propose epic' constraint", async () => {
		await analyzeContextAndPropose({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			fetchedContext: { teamsMessages: "some discussion" },
			existingBacklog: EMPTY_BACKLOG,
			userPrompt: "Analyze",
			allowEpics: false,
		});

		const callArgs = mocks.generateObject.mock.calls[0]?.[0];
		const prompt: string = callArgs.prompt;

		// Mirror the story-retirement wording: explicit "do not propose epic".
		expect(prompt.toLowerCase()).toMatch(
			/do not propose .*type.*"?epic"?|epic.*has been retired|do not propose .*epic/i,
		);
		// And the remediation: map large/strategic initiatives to features.
		expect(prompt.toLowerCase()).toMatch(
			/one or more .*"?feature"?|map .*(large|strategic).* to .*feature/i,
		);
	});

	it("with allowEpics:false, the epic constraint fires independent of pmToolType (no PM tool set)", async () => {
		await analyzeContextAndPropose({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			fetchedContext: { teamsMessages: "some discussion" },
			existingBacklog: EMPTY_BACKLOG,
			userPrompt: "Analyze",
			allowEpics: false,
			// pmToolType intentionally omitted — the existing Rule 11
			// epic-suppression only fired when pmToolType was a flat tool.
		});

		const callArgs = mocks.generateObject.mock.calls[0]?.[0];
		const prompt: string = callArgs.prompt;
		expect(prompt.toLowerCase()).toMatch(
			/do not propose .*type.*"?epic"?|epic.*has been retired|do not propose .*epic/i,
		);
	});

	it("default (allowEpics unset) ALSO suppresses epics — the Epic/Feature folder tables were dropped, so the constraint is unconditional", async () => {
		await analyzeContextAndPropose({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			fetchedContext: { teamsMessages: "some discussion" },
			existingBacklog: EMPTY_BACKLOG,
			userPrompt: "Analyze",
		});

		const callArgs = mocks.generateObject.mock.calls[0]?.[0];
		const prompt: string = callArgs.prompt;

		// Epic guidance must never appear — every flow is feature/bug-only now.
		expect(prompt).not.toMatch(/large strategic initiatives/i);
		// The "do not propose epic" gate fires for ALL callers.
		expect(prompt.toLowerCase()).toMatch(/do not propose .*"?epic"?/i);
	});
});

describe("analyzer prompt — capture-as-is (create-only) for monitored-channel flow", () => {
	const BASE = {
		projectId: "project-1",
		userId: "user-1",
		organizationId: "org-1",
		fetchedContext: { teamsMessages: "some discussion" },
		existingBacklog: EMPTY_BACKLOG,
		userPrompt: "Analyze",
	};

	it('with allowUpdates:false, adds an explicit CREATE-ONLY constraint and instructs action:"create"', async () => {
		await analyzeContextAndPropose({ ...BASE, allowUpdates: false });

		const callArgs = mocks.generateObject.mock.calls[0]?.[0];
		const prompt: string = callArgs.prompt;

		// The critical create-only constraint must be present.
		expect(prompt).toMatch(/CREATE-ONLY/);
		// And it must steer the model to create actions only.
		expect(prompt).toMatch(/action:\s*"create"/);
		expect(prompt.toLowerCase()).toMatch(/capture/);
	});

	it("with allowUpdates:false, drops the update-bearing Rule 1 / Rule 9 / Rule 10 directives", async () => {
		await analyzeContextAndPropose({ ...BASE, allowUpdates: false });

		const callArgs = mocks.generateObject.mock.calls[0]?.[0];
		const prompt: string = callArgs.prompt;

		// Rule 1's "Update existing items" heading must be gone.
		expect(prompt).not.toMatch(/\*\*Update existing items\*\*/);
		// Rule 9's "propose an `update` instead of a `create`" must be gone.
		expect(prompt).not.toMatch(
			/propose an `?update`? instead of a `?create`?/i,
		);
		// Rule 10's PM-tool update directive must be gone.
		expect(prompt).not.toMatch(/PM TOOL IS SOURCE OF TRUTH/);
	});

	it("with allowUpdates:false, a model-emitted update action is dropped from the returned proposal", async () => {
		mocks.generateObject.mockResolvedValueOnce({
			object: {
				summary: "",
				contextSummary: "",
				changes: [
					{
						type: "feature",
						action: "create",
						title: { to: "Brand new capability" },
						reasoning: "new",
						sourceContext: "teams_messages",
					},
					{
						type: "feature",
						action: "update",
						existingId: "story-1",
						existingIdentifier: "F-001",
						title: { to: "Existing capability" },
						reasoning: "matched existing",
						sourceContext: "teams_messages",
					},
				],
			},
			usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
		});

		const proposal = await analyzeContextAndPropose({
			...BASE,
			allowUpdates: false,
		});

		// The update must be filtered out — only the create survives.
		expect(proposal.changes).toHaveLength(1);
		expect(proposal.changes[0]?.action).toBe("create");
		expect(proposal.changes.some((c) => c.action === "update")).toBe(false);
	});

	it("default (allowUpdates unset) keeps the update directives — regression guard for AI Update (AC2)", async () => {
		await analyzeContextAndPropose({ ...BASE });

		const callArgs = mocks.generateObject.mock.calls[0]?.[0];
		const prompt: string = callArgs.prompt;

		// The AI Update / document analyzer / ADO flow MUST still get the full
		// update behavior so its proposals can suggest updating existing items.
		expect(prompt).toMatch(/\*\*Update existing items\*\*/);
		expect(prompt).toMatch(/PM TOOL IS SOURCE OF TRUTH/);
		// And must NOT carry the channel-monitor create-only gate.
		expect(prompt).not.toMatch(/CREATE-ONLY/);
	});

	it("default (allowUpdates unset) does NOT drop update actions from the proposal (AC2)", async () => {
		mocks.generateObject.mockResolvedValueOnce({
			object: {
				summary: "",
				contextSummary: "",
				changes: [
					{
						type: "feature",
						action: "update",
						existingId: "story-1",
						existingIdentifier: "F-001",
						title: { to: "Existing capability" },
						reasoning: "matched existing",
						sourceContext: "teams_messages",
					},
				],
			},
			usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
		});

		const proposal = await analyzeContextAndPropose({
			...BASE,
			existingBacklog: {
				stories: [
					{
						id: "story-1",
						identifier: "F-001",
						title: "Existing capability",
						externalId: null,
					},
				],
			},
		});

		// AI Update flow keeps update actions intact.
		expect(proposal.changes.some((c) => c.action === "update")).toBe(true);
	});
});

/**
 * Fizzy #2048 — the analyzer's bug sections must be guard-visible.
 *
 * `detectDestructiveRewrite` protects a bug body from being reformatted into
 * feature shape, but `countHeadingMatches` only counts lines matching
 * `/^#{1,6}\s/`. The analyzer used to describe a bug's diagnostic sections as
 * inline bold labels (`- **Steps to Reproduce**: …`) under two names the guard
 * does not carry ("Expected Behavior" / "Actual Behavior"). Both together meant
 * an analyzer-drafted bug scored ZERO signature sections: the guard could never
 * arm on it and never fire, while looking perfectly correct in review.
 *
 * These tests assert through the guard's own exported helpers, so they fail if
 * either side drifts — the prompt back to bold labels, or the guard's canonical
 * names away from the ones the prompt now emits.
 */
describe("analyzer prompt — bug sections are guard-visible (Fizzy #2048)", () => {
	const BASE = {
		projectId: "project-1",
		userId: "user-1",
		organizationId: "org-1",
		fetchedContext: { teamsMessages: "some discussion" },
		existingBacklog: EMPTY_BACKLOG,
		userPrompt: "Analyze",
	};

	async function buildPrompt(): Promise<string> {
		await analyzeContextAndPropose({ ...BASE });
		const callArgs = mocks.generateObject.mock.calls[0]?.[0];
		const prompt: string = callArgs.prompt;
		expect(prompt).toBeTypeOf("string");
		return prompt;
	}

	/** The `description.to` rules for `type: "bug"`, sliced out of the prompt. */
	function bugBodyRules(prompt: string): string {
		const start = prompt.indexOf('**Bugs** (type: "bug")');
		expect(start).toBeGreaterThan(-1);
		const rest = prompt.slice(start);
		const end = rest.indexOf("`acceptanceCriteria.to`");
		expect(end).toBeGreaterThan(-1);
		return rest.slice(0, end);
	}

	/** Markdown heading lines, indentation-insensitive — as the guard reads them. */
	function headingLines(markdown: string): string[] {
		return markdown
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => /^#{1,6}\s/.test(line));
	}

	/**
	 * A bug proposal body assembled from the section skeleton THE PROMPT ITSELF
	 * carries — not a hand-written fixture. That coupling is the point: if the
	 * prompt drifts back to bold labels, this body loses its headings and the
	 * guard assertions below fail rather than passing against a stale fixture.
	 *
	 * Kept well under the guard's 600-char body-collapse floor so the only thing
	 * that can trip `detectDestructiveRewrite` is the diagnostic-section
	 * signature.
	 */
	async function bugProposalBodyFromPrompt(): Promise<string> {
		const headings = headingLines(bugBodyRules(await buildPrompt()));
		expect(headings.length).toBeGreaterThanOrEqual(2);
		return headings
			.map((heading) => `${heading}\nDrafted content for this section.`)
			.join("\n\n");
	}

	/**
	 * The same content in the pre-fix shape: inline bold labels, and the two
	 * off-canon names. This is the regression control — it must score zero.
	 */
	const PRE_FIX_BOLD_LABEL_BODY = [
		"- **Steps to Reproduce**: Open the sign-in page, then click Sign in",
		"- **Expected Behavior**: The account is signed in and lands on the dashboard.",
		"- **Actual Behavior**: Nothing happens and no network request is issued.",
		"- **Impact**: Every returning account on the affected browser is locked out.",
	].join("\n");

	/** A feature-shaped rewrite carrying none of the bug signature sections. */
	const FEATURE_SHAPED_REWRITE = [
		"## Overview",
		"A smoother sign-in experience for returning accounts.",
		"",
		"## Business Value",
		"Returning accounts reach the dashboard without friction.",
		"",
		"## Success Criteria",
		"Sign-in completes on the affected browser.",
	].join("\n");

	it("Covers AE3 — the bug body rules emit the diagnostic sections as markdown headings, not bold labels", async () => {
		const rules = bugBodyRules(await buildPrompt());

		// The sections must be real heading lines. Before the fix this list was
		// empty: every section was a `- **Label**:` bullet.
		expect(headingLines(rules)).toEqual([
			"## Steps to Reproduce",
			"## Expected Result",
			"## Actual Result",
			"## Impact",
		]);

		// And the old bold-label form must not come back for any of them.
		for (const section of [
			"Steps to Reproduce",
			"Expected Result",
			"Actual Result",
			"Impact",
		]) {
			expect(rules).not.toMatch(new RegExp(`- \\*\\*${section}\\*\\*:`));
		}
	});

	it("Covers AE3 — every section name the prompt emits is one the guard carries", async () => {
		const emitted = headingLines(bugBodyRules(await buildPrompt())).map(
			(line) => line.replace(/^#+\s+/, ""),
		);

		expect(emitted.length).toBeGreaterThanOrEqual(2);
		for (const name of emitted) {
			expect(BUG_SIGNATURE_SECTIONS as readonly string[]).toContain(name);
		}

		// The two that used to disagree with the guard are gone by name.
		const prompt = await buildPrompt();
		expect(prompt).not.toMatch(/Expected Behavior/);
		expect(prompt).not.toMatch(/Actual Behavior/);
	});

	it("Covers AE3 — a bug body in the prompt's own shape exposes at least two sections to the guard's section reader", async () => {
		const body = await bugProposalBodyFromPrompt();
		const visible = BUG_SIGNATURE_SECTIONS.filter(
			(section) => extractSectionBody(body, section) !== null,
		);
		expect(visible.length).toBeGreaterThanOrEqual(2);

		// The pre-fix bold-label body exposes none — the guard was blind to it.
		expect(
			BUG_SIGNATURE_SECTIONS.filter(
				(section) =>
					extractSectionBody(PRE_FIX_BOLD_LABEL_BODY, section) !==
					null,
			),
		).toHaveLength(0);
	});

	it("Covers AE3 — the destructive-rewrite guard now ARMS on an analyzer-drafted bug body", async () => {
		// `existingSig >= 2 && candidateSig === 0` is the firing condition. With
		// headings the analyzer's own body clears the >= 2 threshold, so a
		// feature-shaped rewrite of it is caught instead of waved through.
		expect(
			detectDestructiveRewrite({
				existing: await bugProposalBodyFromPrompt(),
				candidate: FEATURE_SHAPED_REWRITE,
				kind: "BUG",
			}),
		).toEqual({ destructive: true, reason: "bug_sections_dropped" });
	});

	it("Covers AE3 — the SAME rewrite went undetected against the pre-fix bold-label body", () => {
		// The regression control: identical content, identical rewrite, but the
		// bold-label body scores zero signature sections so the guard never arms.
		// If this ever starts reporting `destructive: true`, the guard changed
		// rather than the prompt, and this unit's premise needs re-checking.
		expect(
			detectDestructiveRewrite({
				existing: PRE_FIX_BOLD_LABEL_BODY,
				candidate: FEATURE_SHAPED_REWRITE,
				kind: "BUG",
			}).destructive,
		).toBe(false);
	});

	it("does not flag the analyzer's own bug body as a destructive rewrite", async () => {
		// Guard-visible cuts both ways: the body must arm the guard as `existing`
		// without tripping it as `candidate`.
		const body = await bugProposalBodyFromPrompt();
		expect(
			detectDestructiveRewrite({
				existing: body,
				candidate: body.replace(
					"Drafted content for this section.",
					"Drafted content, refined by a targeted edit.",
				),
				kind: "BUG",
			}).destructive,
		).toBe(false);
	});

	it("leaves the FEATURE section rules unchanged — inline bold labels, same four sections", async () => {
		const prompt = await buildPrompt();
		const start = prompt.indexOf('**Features** (type: "feature")');
		expect(start).toBeGreaterThan(-1);
		const featureRules = prompt.slice(
			start,
			prompt.indexOf('**Bugs** (type: "bug")'),
		);

		// Features keep the inline bold-label form — nothing about them is in
		// scope here, and no structure guard reads them.
		expect(featureRules).toMatch(/- \*\*Overview\*\*:/);
		expect(featureRules).toMatch(/- \*\*Business Value\*\*:/);
		expect(featureRules).toMatch(/- \*\*Scope\*\*:/);
		expect(featureRules).toMatch(/- \*\*Success Criteria\*\*:/);
		// And gain no markdown headings.
		expect(headingLines(featureRules)).toEqual([]);
	});
});

/**
 * Fizzy #2048 (AC7) — the analyzer reads the type-specific placeholder prompt
 * for a work-item type instead of applying a hard-coded ticket structure.
 *
 * Two catalog records drive it, resolved at the activity's call site and passed
 * into the (still pure, still synchronous) prompt builder:
 *   FEATURE → documentType PLACEHOLDER  (the seeded `feature_placeholder`)
 *   BUG     → documentType DRAFT        (the seeded `bug_creation`)
 * The asymmetry is deliberate and mirrors `draftBodyByKind` — bugs are
 * single-stage and bind at DRAFT, features bind their create-time prompt at
 * PLACEHOLDER — so the analyzer drafts against the same template creation
 * drafts against, per type.
 *
 * The in-code skeletons are NOT deleted: they remain the last-resort text for an
 * unbound tenant or an environment where the prompt seed never ran. A missing
 * binding must cost wording, never output.
 */
describe("analyzer prompt — type-specific body template from the catalog (Fizzy #2048 AC7)", () => {
	const BASE = {
		projectId: "project-1",
		userId: "user-1",
		organizationId: "org-1",
		fetchedContext: { teamsMessages: "some discussion" },
		existingBacklog: EMPTY_BACKLOG,
		userPrompt: "Analyze",
	};

	/**
	 * Structurally faithful stand-ins for the seeded records: a drafting persona
	 * and hard rules ABOVE an `OUTPUT FORMAT` marker, the section skeleton below
	 * it. Abridged so a seed edit doesn't churn this file — what is asserted is
	 * the split, not the exact seeded wording.
	 */
	const BUG_CREATION_TEMPLATE = [
		"You are Fabric. Create a BUG work item document from the provided user input.",
		"",
		"Hard Rules",
		"- Output MUST be Markdown only.",
		"- Preserve the reporter's raw submission exactly.",
		"- You MUST output: needsMoreInfo: <true|false>",
		"",
		"OUTPUT FORMAT (use this exact structure)",
		"",
		"# Bug: <Concise Title>",
		"",
		"## Bug Metadata",
		"- kind: BUG",
		"- needsMoreInfo: <true|false>",
		"",
		"## Steps to Reproduce",
		"1. ...",
		"",
		"## Expected Result",
		"- ...",
		"",
		"## Actual Result",
		"- ...",
		"",
		"## Environment",
		"- App/Area:",
		"",
		"## Impact Assessment",
		"- User impact:",
	].join("\n");

	const FEATURE_PLACEHOLDER_TEMPLATE = [
		"You are Fabric. Create ONE feature stub AND immediately enrich it with passive context.",
		"",
		"Hard Rules",
		"- Output MUST be Markdown only.",
		"- Do NOT invent details; use TBD and Initial Questions.",
		"",
		"OUTPUT FORMAT",
		"",
		"# Feature Stub: <Title>",
		"",
		"## Big Picture (use at least one)",
		"### Feature Story",
		"As a <who>, I want <capability>, So that <benefit>.",
		"",
		"## Must Haves",
		"- ...",
		"",
		"## Use Cases",
		"- ...",
		"",
		"## Initial Questions",
		"- Q:",
	].join("\n");

	/** Catalog record shaped as `getBoundPromptForAgent` returns it. */
	function boundRecord(key: string, content: string) {
		return {
			id: `prompt-${key}`,
			key,
			name: key,
			format: "MARKDOWN",
			version: { id: `v-${key}`, version: 1, content },
		};
	}

	/**
	 * Bind templates per (documentType, storyKind). Anything not listed resolves
	 * to `null` — the unbound case.
	 */
	function bindTemplates(bindings: { feature?: string; bug?: string }) {
		mocks.getBoundPromptForAgent.mockImplementation(
			async (args: { documentType: string; storyKind: string }) => {
				if (
					args.storyKind === "FEATURE" &&
					args.documentType === "PLACEHOLDER" &&
					bindings.feature
				) {
					return boundRecord("feature_placeholder", bindings.feature);
				}
				if (
					args.storyKind === "BUG" &&
					args.documentType === "DRAFT" &&
					bindings.bug
				) {
					return boundRecord("bug_creation", bindings.bug);
				}
				return null;
			},
		);
	}

	async function buildPrompt(
		extra: Record<string, unknown> = {},
	): Promise<string> {
		await analyzeContextAndPropose({ ...BASE, ...extra });
		const prompt: string = mocks.generateObject.mock.calls[0]?.[0].prompt;
		expect(prompt).toBeTypeOf("string");
		return prompt;
	}

	/** The `type: "bug"` rule block, sliced out of the prompt. */
	function bugRules(prompt: string): string {
		const start = prompt.indexOf('**Bugs** (type: "bug")');
		expect(start).toBeGreaterThan(-1);
		const rest = prompt.slice(start);
		const end = rest.indexOf("`acceptanceCriteria.to`");
		expect(end).toBeGreaterThan(-1);
		return rest.slice(0, end);
	}

	/** The `type: "feature"` rule block, sliced out of the prompt. */
	function featureRules(prompt: string): string {
		const start = prompt.indexOf('**Features** (type: "feature")');
		expect(start).toBeGreaterThan(-1);
		return prompt.slice(start, prompt.indexOf('**Bugs** (type: "bug")'));
	}

	function headingLines(markdown: string): string[] {
		return markdown
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => /^#{1,6}\s/.test(line));
	}

	// The exact in-code skeleton lines, one per kind. Their presence means the
	// fallback ran; their absence means a catalog template displaced them.
	const FEATURE_SKELETON_MARKER =
		"- **Business Value**: Why this matters to users and the business";
	const BUG_SKELETON_MARKER = "Who is affected and how severely";

	it("resolves both types at the agent + (documentType, storyKind) pairs the creation path uses", async () => {
		bindTemplates({
			feature: FEATURE_PLACEHOLDER_TEMPLATE,
			bug: BUG_CREATION_TEMPLATE,
		});
		await buildPrompt();

		const calls = mocks.getBoundPromptForAgent.mock.calls.map(
			(call) => call[0],
		);
		expect(calls).toContainEqual(
			expect.objectContaining({
				agentName: "project_document_generator",
				documentType: "PLACEHOLDER",
				storyKind: "FEATURE",
				userId: "user-1",
				organizationId: "org-1",
			}),
		);
		expect(calls).toContainEqual(
			expect.objectContaining({
				agentName: "project_document_generator",
				documentType: "DRAFT",
				storyKind: "BUG",
				userId: "user-1",
				organizationId: "org-1",
			}),
		);
	});

	it("with both templates bound, the prompt carries THEIR structure and drops the in-code skeletons", async () => {
		bindTemplates({
			feature: FEATURE_PLACEHOLDER_TEMPLATE,
			bug: BUG_CREATION_TEMPLATE,
		});
		const prompt = await buildPrompt();

		// Catalog sections, per kind, in the matching rule block.
		expect(featureRules(prompt)).toContain("## Must Haves");
		expect(featureRules(prompt)).toContain("## Use Cases");
		expect(bugRules(prompt)).toContain("## Bug Metadata");
		expect(bugRules(prompt)).toContain("## Impact Assessment");

		// And the hard-coded skeletons are gone — this is the AC itself.
		expect(prompt).not.toContain(FEATURE_SKELETON_MARKER);
		expect(prompt).not.toContain(BUG_SKELETON_MARKER);
	});

	it("injects only the OUTPUT FORMAT section — the drafting procedure above it never reaches the analyzer", async () => {
		bindTemplates({
			feature: FEATURE_PLACEHOLDER_TEMPLATE,
			bug: BUG_CREATION_TEMPLATE,
		});
		const prompt = await buildPrompt();

		// A catalog record is a COMPLETE drafting prompt aimed at producing ONE
		// finished document. Those directives contradict the analyzer's contract
		// (many items, each a JSON field), so only the structure is spliced in.
		expect(prompt).not.toContain("You are Fabric.");
		expect(prompt).not.toContain("Output MUST be Markdown only");
		expect(prompt).not.toContain("Preserve the reporter's raw submission");
		// The analyzer's own persona is untouched.
		expect(prompt).toContain(
			"You are a senior product manager and backlog analyst",
		);

		// What the marker can NOT filter: the seeded bug OUTPUT FORMAT itself
		// carries flag/metadata lines (`needsMoreInfo`, `kind`, reporter fields)
		// that belong to a whole bug card, not to one item's `description.to`.
		// The caveat paragraph is what neutralizes them, so assert it is there.
		expect(bugRules(prompt)).toMatch(
			/IGNORE anything in it that tells you to.*emit metadata\/flag fields/,
		);
	});

	it("with NEITHER template bound, both kinds keep the in-code skeleton verbatim", async () => {
		bindTemplates({});
		const prompt = await buildPrompt();

		expect(prompt).toContain(FEATURE_SKELETON_MARKER);
		expect(prompt).toContain(BUG_SKELETON_MARKER);
		// The bug skeleton's canonical heading list, unchanged.
		expect(headingLines(bugRules(prompt))).toEqual([
			"## Steps to Reproduce",
			"## Expected Result",
			"## Actual Result",
			"## Impact",
		]);
		// No catalog framing anywhere.
		expect(prompt).not.toContain("MUST follow the project's configured");
	});

	it("with only the BUG template bound, the feature kind still falls back", async () => {
		bindTemplates({ bug: BUG_CREATION_TEMPLATE });
		const prompt = await buildPrompt();

		expect(bugRules(prompt)).toContain("## Bug Metadata");
		expect(bugRules(prompt)).not.toContain(BUG_SKELETON_MARKER);
		// Feature keeps its skeleton — fallback is per kind, not all-or-nothing.
		expect(featureRules(prompt)).toContain(FEATURE_SKELETON_MARKER);
		expect(featureRules(prompt)).not.toContain("## Must Haves");
	});

	it("with only the FEATURE template bound, the bug kind still falls back", async () => {
		bindTemplates({ feature: FEATURE_PLACEHOLDER_TEMPLATE });
		const prompt = await buildPrompt();

		expect(featureRules(prompt)).toContain("## Must Haves");
		expect(featureRules(prompt)).not.toContain(FEATURE_SKELETON_MARKER);
		expect(bugRules(prompt)).toContain(BUG_SKELETON_MARKER);
		expect(bugRules(prompt)).not.toContain("## Bug Metadata");
	});

	it("a failed catalog lookup never fails the analysis — it degrades to the skeleton", async () => {
		mocks.getBoundPromptForAgent.mockRejectedValue(
			new Error("connection terminated"),
		);

		const proposal = await analyzeContextAndPropose({ ...BASE });
		expect(proposal).toBeDefined();

		const prompt: string = mocks.generateObject.mock.calls[0]?.[0].prompt;
		expect(prompt).toContain(FEATURE_SKELETON_MARKER);
		expect(prompt).toContain(BUG_SKELETON_MARKER);
	});

	it("a bound record with blank content is treated as unbound", async () => {
		mocks.getBoundPromptForAgent.mockResolvedValue(
			boundRecord("bug_creation", "   \n\n  "),
		);
		const prompt = await buildPrompt();
		expect(prompt).toContain(BUG_SKELETON_MARKER);
	});

	/**
	 * The U5 guard property (AE3), re-checked on the CATALOG path. The seeded
	 * bug template names its sections `## Steps to Reproduce` / `## Expected
	 * Result` / `## Actual Result` / `## Environment` / `## Impact Assessment` —
	 * which is where `BUG_SIGNATURE_SECTIONS` came from in the first place — so
	 * routing the analyzer through it keeps the destructive-rewrite guard armed,
	 * and by construction keeps the analyzer's bug shape in step with the shape
	 * the creation path drafts.
	 */
	it("Covers AE3 on the catalog path — an analyzer bug body in the TEMPLATE's shape still arms the structure guard", async () => {
		bindTemplates({ bug: BUG_CREATION_TEMPLATE });
		const prompt = await buildPrompt();

		// Body assembled from the headings the prompt itself now carries — the
		// same coupling the fallback-path test uses, so a template that dropped
		// the diagnostic sections would fail here rather than pass silently.
		const body = headingLines(bugRules(prompt))
			.filter((heading) => heading.startsWith("## "))
			.map((heading) => `${heading}\nDrafted content for this section.`)
			.join("\n\n");

		const visible = BUG_SIGNATURE_SECTIONS.filter(
			(section) => extractSectionBody(body, section) !== null,
		);
		expect(visible.length).toBeGreaterThanOrEqual(2);

		const FEATURE_SHAPED_REWRITE = [
			"## Overview",
			"A smoother sign-in experience for returning accounts.",
			"",
			"## Business Value",
			"Returning accounts reach the dashboard without friction.",
		].join("\n");

		expect(
			detectDestructiveRewrite({
				existing: body,
				candidate: FEATURE_SHAPED_REWRITE,
				kind: "BUG",
			}),
		).toEqual({ destructive: true, reason: "bug_sections_dropped" });
	});

	it("Covers AE3 on the catalog path — the injected sections stay markdown headings, never bold labels", async () => {
		bindTemplates({ bug: BUG_CREATION_TEMPLATE });
		const rules = bugRules(await buildPrompt());

		expect(headingLines(rules)).toContain("## Steps to Reproduce");
		expect(rules).not.toMatch(/- \*\*Steps to Reproduce\*\*:/);
		// The heading discipline must still be spelled out for the model — it is
		// what keeps the guard able to see the body at all.
		expect(rules).toMatch(/MARKDOWN HEADINGS/);
	});
});

describe("extractWorkItemBodyStructure (Fizzy #2048 AC7)", () => {
	it("keeps only what follows the OUTPUT FORMAT marker", () => {
		const structure = extractWorkItemBodyStructure(
			"Persona line\n\nHard Rules\n- Output MUST be Markdown only.\n\nOUTPUT FORMAT\n\n## Steps to Reproduce\n1. ...",
		);
		expect(structure).toBe("## Steps to Reproduce\n1. ...");
	});

	it("tolerates marker decoration and a trailing qualifier", () => {
		for (const marker of [
			"OUTPUT FORMAT (use this exact structure)",
			"## OUTPUT FORMAT",
			"**Output Format**",
			"  output format",
		]) {
			expect(
				extractWorkItemBodyStructure(
					`Persona\n\n${marker}\n\n## Impact`,
				),
			).toBe("## Impact");
		}
	});

	it("degrades to the whole record when no marker is present", () => {
		// A tenant may author a bare section list with no marker at all. A
		// resolved template is still better evidence of the wanted structure than
		// the in-code skeleton, so nothing is dropped.
		const bare = "## Steps to Reproduce\n1. ...\n\n## Impact\n- ...";
		expect(extractWorkItemBodyStructure(bare)).toBe(bare);
	});

	it("degrades to the whole record when the marker has nothing under it", () => {
		const record = "Persona\n\nOUTPUT FORMAT";
		expect(extractWorkItemBodyStructure(record)).toBe(record);
	});

	it("returns empty for a blank record so the caller can treat it as unbound", () => {
		expect(extractWorkItemBodyStructure("   \n\n ")).toBe("");
	});

	it("clamps an oversized record on a line boundary — the system prompt is fixed budget", () => {
		const long = `OUTPUT FORMAT\n\n${"## Section\nfiller line\n".repeat(1000)}`;
		const structure = extractWorkItemBodyStructure(long);
		expect(structure.length).toBeLessThanOrEqual(6100);
		expect(structure.endsWith("\n…")).toBe(true);
		// Clamped between lines, so no half-written heading reaches the model.
		const lines = structure.split("\n");
		expect(lines[lines.length - 2]).toMatch(/^(## Section|filler line)$/);
	});
});

describe("analyzer prompt — application-log context (Fizzy #1234)", () => {
	// Section BODY only — no `###` heading. That mirrors what
	// `renderLogContextClause` actually returns; the prompt builder adds the
	// heading, the same as it does for every other context source.
	const LOG_CLAUSE = [
		"Source: Ops Logs. These entries were retrieved for this analysis",
		"",
		"- 2026-08-19T10:00:00Z [ERROR] checkout reservation timed out",
	].join("\n");

	// The regression this exists for: `analyzeContextAndPropose` flattened
	// `fetchedContext` by hand-listing keys, so `applicationLogs` was fetched,
	// redacted, and then dropped before the prompt was built — while the user
	// was still told the logs had been included. Every other assertion in this
	// feature passed, because none of them looked at the REAL prompt.
	it("puts the fetched log section into the prompt the model actually receives", async () => {
		await analyzeContextAndPropose({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			fetchedContext: {
				teamsMessages: "some discussion",
				applicationLogs: LOG_CLAUSE,
			},
			existingBacklog: EMPTY_BACKLOG,
			userPrompt: "Analyze",
		});

		const callArgs = mocks.generateObject.mock.calls[0]?.[0];
		const prompt: string = callArgs.prompt;

		expect(prompt).toContain("### Application Logs");
		expect(prompt).toContain("checkout reservation timed out");
		// The other sources must still be there — logs are additive.
		expect(prompt).toContain("some discussion");
	});

	it("omits the section entirely when no logs were fetched", async () => {
		await analyzeContextAndPropose({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			fetchedContext: { teamsMessages: "some discussion" },
			existingBacklog: EMPTY_BACKLOG,
			userPrompt: "Analyze",
		});

		const callArgs = mocks.generateObject.mock.calls[0]?.[0];
		const prompt: string = callArgs.prompt;

		expect(prompt).not.toContain("### Application Logs");
	});

	it("keeps the log section when the budget forces truncation of other sources", async () => {
		// Logs rank second in the truncation priority order, so a bloated
		// low-priority source must not push them out.
		await analyzeContextAndPropose({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			fetchedContext: {
				applicationLogs: LOG_CLAUSE,
				ragContext: "r".repeat(400_000),
			},
			existingBacklog: EMPTY_BACKLOG,
			userPrompt: "Analyze",
		});

		const callArgs = mocks.generateObject.mock.calls[0]?.[0];
		const prompt: string = callArgs.prompt;

		expect(prompt).toContain("### Application Logs");
		expect(prompt).toContain("checkout reservation timed out");
	});
});
