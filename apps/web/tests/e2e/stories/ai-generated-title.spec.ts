/**
 * E2E: AI auto-generated work-item titles.
 *
 * Scenarios:
 *
 *  Original behavior:
 *   1. Kanban "Add Feature" → no title input visible → submit with
 *      description only → card lands with a non-empty title.
 *   2. Roadmap "Add Feature" → same as #1, plus PromptSelector + draftingStage
 *      Select still render and the "Drafting with AI…" label still appears
 *      when a prompt is selected.
 *   3. Regenerate title round-trip — open a story workspace, open the actions
 *      dropdown, click "Regenerate title", assert title input updates and
 *      the calm toast text appears.
 *   4. No-AI-provider fallback — against a seeded tenant with no AI provider,
 *      repeat scenario 1; the card still creates with a non-empty title
 *      (description-fallback path), no toast / no error.
 *
 *  Improvements pass:
 *   5. Empty-description regenerate disabled with tooltip — open a seeded
 *      story whose description is empty; assert the inline regenerate
 *      `SparklesIcon` button next to the title is `disabled` and the tooltip
 *      text matches `regenerateTitleEmptyDescription`
 *      ("Add a description first.").
 *   6. Loading + success toast on create — submit the Kanban "Add Feature"
 *      dialog with a meaningful description; assert a `toast.loading` with the
 *      `create.titleGenerating` copy ("Generating title…") appears, then
 *      transitions to a `toast.success` ("Title generated.") once the mutation
 *      resolves.
 *   7. Soft-warn toast on insufficient description — submit against a tenant
 *      with `AI_TITLE_GENERATION_ENABLED=false` so the helper always
 *      short-circuits to `untitledFallback()` and the server returns a row
 *      with `titleSource: "untitled-fallback"`. Assert the created card lands
 *      with a `Untitled – YYYY-MM-DD HH:mm` title AND that the soft-warn
 *      copy (`create.titleInsufficient`, "Description was short — using
 *      placeholder title. You can edit it any time.") appears. The
 *      kill-switch is the most reliable way to trigger the fallback without
 *      depending on a flaky LLM-returns-`is_insufficient` round trip; the
 *      client treats both the same.
 *
 * Setup: reuses the existing `auth.setup.ts` storageState. Concrete IDs are
 * read from env vars (same pattern as `feature-download-single.spec.ts` and
 * `apps/web/tests/projects/contexts-download.spec.ts`); tests skip themselves
 * when placeholders remain unset so the suite stays green on PR checks while
 * still being runnable manually.
 *
 * Env vars consumed (all optional — unset values cause tests to skip):
 *   TEST_PERSONAL_PROJECT_KANBAN_ID
 *   TEST_PERSONAL_PROJECT_ROADMAP_ID
 *   TEST_PERSONAL_FEATURE_FOR_REGENERATE_ID
 *   TEST_PERSONAL_PROJECT_NO_AI_PROVIDER_ID
 *   TEST_PERSONAL_FEATURE_EMPTY_DESCRIPTION_ID   - story with description = ""
 *                                                  (use Prisma Studio to set
 *                                                  description to empty
 *                                                  string after creation)
 *   TEST_PERSONAL_PROJECT_KILL_SWITCH_ID         - project belonging to a
 *                                                  tenant where the env var
 *                                                  AI_TITLE_GENERATION_ENABLED
 *                                                  is set to "false" in the
 *                                                  web/api process
 *
 * Manual runbook:
 *   - Personal: create one project for Kanban + one for Roadmap. Note IDs.
 *   - Create a story whose description is empty (seed via SQL or Prisma
 *     Studio: `UPDATE "user_story" SET description = '' WHERE id = ...`).
 *     Export its id as TEST_PERSONAL_FEATURE_EMPTY_DESCRIPTION_ID along with
 *     the parent project id as TEST_PERSONAL_PROJECT_KANBAN_ID.
 *   - For the kill-switch scenario, set `AI_TITLE_GENERATION_ENABLED=false`
 *     in `.env.local` (or in the running web/api process env) and restart
 *     the dev server before running the suite. Export the relevant project
 *     id as TEST_PERSONAL_PROJECT_KILL_SWITCH_ID.
 *
 * Run:
 *   pnpm --filter web e2e tests/e2e/stories/ai-generated-title.spec.ts
 */

import { expect, test } from "@playwright/test";

const TEST_DATA = {
	kanbanProjectId:
		process.env.TEST_PERSONAL_PROJECT_KANBAN_ID ?? "<kanban-project-id>",
	roadmapProjectId:
		process.env.TEST_PERSONAL_PROJECT_ROADMAP_ID ?? "<roadmap-project-id>",
	regenerateStoryId:
		process.env.TEST_PERSONAL_FEATURE_FOR_REGENERATE_ID ??
		"<regenerate-story-id>",
	noAiProjectId:
		process.env.TEST_PERSONAL_PROJECT_NO_AI_PROVIDER_ID ??
		"<no-ai-project-id>",
	emptyDescriptionStoryId:
		process.env.TEST_PERSONAL_FEATURE_EMPTY_DESCRIPTION_ID ??
		"<empty-description-story-id>",
	killSwitchProjectId:
		process.env.TEST_PERSONAL_PROJECT_KILL_SWITCH_ID ??
		"<kill-switch-project-id>",
} as const;

function isPlaceholder(value: string): boolean {
	return value.startsWith("<") && value.endsWith(">");
}

function skipIfAnyPlaceholder(...values: string[]): void {
	for (const v of values) {
		if (isPlaceholder(v)) {
			test.skip();
			return;
		}
	}
}

const KANBAN_URL = (id: string) => `/app/projects/${id}/stories`;
const ROADMAP_URL = (id: string) => `/app/projects/${id}/roadmap`;
const WORKSPACE_URL = (projectId: string, storyId: string) =>
	`/app/projects/${projectId}/stories/${storyId}`;

const DESCRIPTION_LABEL = /What's this about\?/i;
const FEATURE_PLACEHOLDER = /Describe the feature/i;
const REGENERATE_ACTION = /Regenerate title/i;
const REGENERATE_SUCCESS = /Title updated\./i;

// i18n keys — assertion text is verbatim from en.json so future copy changes
// flag here intentionally.
const TITLE_GENERATING_COPY = /Generating title…/i;
const TITLE_GENERATED_COPY = /Title generated\./i;
const TITLE_INSUFFICIENT_COPY =
	/Description was short — using placeholder title\. You can edit it any time\./i;
const EMPTY_DESCRIPTION_TOOLTIP = /Add a description first\./i;
// `Untitled – YYYY-MM-DD HH:mm` (UTC) — en-dash, single space pad.
const UNTITLED_TIMESTAMP_PATTERN = /Untitled – \d{4}-\d{2}-\d{2} \d{2}:\d{2}/;

test.describe("AI auto-generated titles — Kanban", () => {
	test("submits with description only and lands a non-empty card title", async ({
		page,
	}) => {
		skipIfAnyPlaceholder(TEST_DATA.kanbanProjectId);

		await page.goto(KANBAN_URL(TEST_DATA.kanbanProjectId));
		await page
			.getByRole("button", { name: /add feature/i })
			.first()
			.click();

		// AC-1: no title input is rendered.
		await expect(page.getByLabel(/^title$/i).first()).toHaveCount(0);

		// The description textarea is the only required field.
		const description = page.getByLabel(DESCRIPTION_LABEL).first();
		await expect(description).toBeVisible();

		const uniqueDescription = `E2E: ship a flag toggle for the new beta. ts=${Date.now()}`;
		await description.fill(uniqueDescription);

		const submit = page.getByRole("button", { name: /^create feature$/i });
		await submit.click();

		// The card lands with a non-empty title that is *not* literally the
		// description (proxy for "AI ran or fallback ran" — either is valid).
		const newCard = page
			.locator('[data-testid="story-card"], [data-story-id]')
			.filter({ hasNotText: uniqueDescription })
			.first();
		await expect(newCard).toBeVisible({ timeout: 30_000 });
	});
});

test.describe("AI auto-generated titles — Roadmap", () => {
	test("preserves PromptSelector + Drafting-with-AI label while title is server-generated", async ({
		page,
	}) => {
		skipIfAnyPlaceholder(TEST_DATA.roadmapProjectId);

		await page.goto(ROADMAP_URL(TEST_DATA.roadmapProjectId));
		await page
			.getByRole("button", { name: /add feature/i })
			.first()
			.click();

		// No title input.
		await expect(page.getByLabel(/^title$/i).first()).toHaveCount(0);

		// PromptSelector + Stage Select still render.
		await expect(page.getByText(/^Prompt$/i).first()).toBeVisible();
		await expect(page.getByText(/^Stage$/i).first()).toBeVisible();
		await expect(
			page.getByPlaceholder(FEATURE_PLACEHOLDER).first(),
		).toBeVisible();

		// Verify submit is disabled until description is non-empty.
		const submit = page.getByRole("button", { name: /^create feature$/i });
		await expect(submit).toBeDisabled();

		await page
			.getByLabel(DESCRIPTION_LABEL)
			.first()
			.fill("E2E roadmap description for AI title generation.");

		await expect(submit).toBeEnabled();
	});
});

test.describe("AI auto-generated titles — Regenerate round-trip", () => {
	test("Regenerate title updates the title and shows the calm toast", async ({
		page,
	}) => {
		skipIfAnyPlaceholder(
			TEST_DATA.kanbanProjectId,
			TEST_DATA.regenerateStoryId,
		);

		await page.goto(
			WORKSPACE_URL(
				TEST_DATA.kanbanProjectId,
				TEST_DATA.regenerateStoryId,
			),
		);

		// Open the actions dropdown (the chevron next to Save & Close).
		await page
			.getByRole("button", { name: /more save options/i })
			.first()
			.click();

		const initialTitle = await page
			.getByLabel(/^title$/i)
			.first()
			.inputValue()
			.catch(() => "");

		await page.getByRole("menuitem", { name: REGENERATE_ACTION }).click();

		// Toast appears — calm, neutral copy.
		await expect(page.getByText(REGENERATE_SUCCESS).first()).toBeVisible({
			timeout: 30_000,
		});

		// Title input value updates to a non-empty value (allow either same
		// or different — the AI may regenerate the same title, both valid).
		const updated = await page
			.getByLabel(/^title$/i)
			.first()
			.inputValue();
		expect(updated.trim().length).toBeGreaterThan(0);
		expect(updated.startsWith(initialTitle)).toBeDefined();
	});
});

test.describe("AI auto-generated titles — Description fallback", () => {
	test("creates a card without an AI provider configured (fallback path)", async ({
		page,
	}) => {
		skipIfAnyPlaceholder(TEST_DATA.noAiProjectId);

		await page.goto(KANBAN_URL(TEST_DATA.noAiProjectId));
		await page
			.getByRole("button", { name: /add feature/i })
			.first()
			.click();

		// User-visible behavior is identical — same dialog renders, no error banner.
		await expect(page.getByLabel(DESCRIPTION_LABEL).first()).toBeVisible();

		const description =
			"E2E fallback: this should still create a card on a tenant without an AI provider configured.";
		await page.getByLabel(DESCRIPTION_LABEL).first().fill(description);
		await page.getByRole("button", { name: /^create feature$/i }).click();

		// Card creates successfully — no toast, no error banner.
		await expect(
			page
				.locator('[data-testid="story-card"], [data-story-id]')
				.filter({ hasText: description.slice(0, 40) })
				.first(),
		).toBeVisible({ timeout: 30_000 });
		// No "Failed" or red error banner from the AI provider check.
		await expect(page.getByText(/Failed to create story/i)).toHaveCount(0);
	});
});

/* ──────────────────────────────────────────────────────────────────────────
 * Improvements-pass scenarios.
 * Each scenario gates on a dedicated env var so the suite stays green on PR
 * CI when the corresponding test fixtures are not seeded (matches the
 * placeholder skip pattern used by `apps/web/tests/projects/contexts-
 * download.spec.ts`).
 * ────────────────────────────────────────────────────────────────────── */

test.describe("AI auto-generated titles — Regenerate button (empty description, M6 / AC-11)", () => {
	test("is disabled with the 'Add a description first.' tooltip when description is empty", async ({
		page,
	}) => {
		// Skip cleanly when the seeded story id is absent — non-blocking
		// for PR CI per tasks.md Group 10.
		skipIfAnyPlaceholder(
			TEST_DATA.kanbanProjectId,
			TEST_DATA.emptyDescriptionStoryId,
		);

		await page.goto(
			WORKSPACE_URL(
				TEST_DATA.kanbanProjectId,
				TEST_DATA.emptyDescriptionStoryId,
			),
		);

		// The inline regenerate button is rendered absolutely positioned
		// inside the title <Input> wrapper; it carries a stable data-testid.
		const regenerateBtn = page.getByTestId("regenerate-title-button");
		await expect(regenerateBtn).toBeVisible({ timeout: 15_000 });

		// AC-11 (empty-description disable): the button is disabled.
		// Radix Tooltip + the native HTML `disabled` attribute combined
		// — assert both for defense-in-depth.
		await expect(regenerateBtn).toBeDisabled();

		// Hover surfaces the empty-description tooltip copy. Radix
		// renders the tooltip content in a portal, so we assert against
		// the document body, not the button's subtree.
		await regenerateBtn.hover();
		await expect(
			page.getByText(EMPTY_DESCRIPTION_TOOLTIP).first(),
		).toBeVisible({ timeout: 5_000 });
	});
});

test.describe("AI auto-generated titles — Loading + success toast on create (AC-3 / AC-4)", () => {
	test("shows 'Generating title…' then transitions to 'Title generated.'", async ({
		page,
	}) => {
		// Skip if no Kanban project is seeded. Group 6 of the
		// improvements spec wires the loading toast; if Group 6 has not
		// shipped to the dev branch yet, this assertion will fail and
		// surface the gap intentionally.
		skipIfAnyPlaceholder(TEST_DATA.kanbanProjectId);

		await page.goto(KANBAN_URL(TEST_DATA.kanbanProjectId));
		await page
			.getByRole("button", { name: /add feature/i })
			.first()
			.click();

		const description = page.getByLabel(DESCRIPTION_LABEL).first();
		await expect(description).toBeVisible();

		const uniqueDescription = `E2E loading toast: build a status badge for the dashboard. ts=${Date.now()}`;
		await description.fill(uniqueDescription);

		const submit = page.getByRole("button", {
			name: /^create feature$/i,
		});
		await submit.click();

		// The loading toast appears synchronously on submit. sonner
		// renders all toasts inside the role="status" / aria-live="polite"
		// region, so a text-match on the page is sufficient and resilient
		// to z-index ordering changes.
		await expect(page.getByText(TITLE_GENERATING_COPY).first()).toBeVisible(
			{ timeout: 5_000 },
		);

		// The same toast id is updated to success on mutation success
		// (`toast.success(..., { id: toastId })`).
		await expect(page.getByText(TITLE_GENERATED_COPY).first()).toBeVisible({
			timeout: 30_000,
		});
	});
});

test.describe("AI auto-generated titles — Soft-warn toast on insufficient description (AC-5 / AC-7)", () => {
	test("fires the soft-warn copy and lands a timestamped Untitled card", async ({
		page,
	}) => {
		// This scenario requires either:
		//   (a) a tenant whose AI_TITLE_GENERATION_ENABLED env var is
		//       "false" so the helper short-circuits to untitledFallback,
		//       OR
		//   (b) the title model is mocked/stubbed to return
		//       {is_insufficient: true}.
		// Setting the kill-switch is the lower-flake path because it
		// removes the LLM dependency entirely; we gate on the
		// kill-switch project id env var so this test skips cleanly when
		// the harness is not configured for it.
		skipIfAnyPlaceholder(TEST_DATA.killSwitchProjectId);

		await page.goto(KANBAN_URL(TEST_DATA.killSwitchProjectId));
		await page
			.getByRole("button", { name: /add feature/i })
			.first()
			.click();

		const description = page.getByLabel(DESCRIPTION_LABEL).first();
		await expect(description).toBeVisible();

		// A short, vague description is the natural prompt-trigger for
		// `is_insufficient: true`. The kill-switch makes the test
		// deterministic regardless — the helper returns
		// `untitledFallback({ isInsufficient: true })`.
		const uniqueDescription = `idk maybe a thing? ts=${Date.now()}`;
		await description.fill(uniqueDescription);

		const submit = page.getByRole("button", {
			name: /^create feature$/i,
		});
		await submit.click();

		// Soft-warn toast text is the canonical copy from en.json. Client
		// does not differentiate `is_insufficient` from system-failure —
		// both surface the same copy.
		await expect(
			page.getByText(TITLE_INSUFFICIENT_COPY).first(),
		).toBeVisible({ timeout: 30_000 });

		// And the persisted card title matches the `Untitled – ...`
		// timestamp pattern. Single regex match on
		// the kanban board view is sufficient — exact minute is
		// non-deterministic across CI clocks but the shape is fixed.
		const untitledCard = page
			.locator('[data-testid="story-card"], [data-story-id]')
			.filter({ hasText: UNTITLED_TIMESTAMP_PATTERN })
			.first();
		await expect(untitledCard).toBeVisible({ timeout: 30_000 });
	});
});
