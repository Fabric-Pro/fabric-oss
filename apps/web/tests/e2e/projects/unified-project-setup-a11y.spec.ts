/**
 * E2E: Unified Project Setup Wizard — keyboard-only accessibility
 *
 * Spec: specs/2026-05-27-unified-project-setup-wizard/spec.md §7 (WCAG 2.1 AA;
 *   disclosure cards, focus management) + §12.3 (E2E A11y bullet).
 * Tasks: specs/2026-05-27-unified-project-setup-wizard/tasks.md task 7.2.
 *
 * Mirrors the harness/conventions of
 * `apps/web/tests/e2e/unified-context-wizard/a11y-wizard.spec.ts` — same auth
 * storage-state (the `chromium` project depends on `auth.setup.ts`), same
 * `test.skip(() => true, …)` CI deferral, no new fixtures invented.
 *
 * Where the sibling spec runs an axe-core audit, THIS spec exercises the one
 * a11y dimension axe cannot see: keyboard operability and focus order of the
 * two collapsed/expand optional cards introduced by TG1 (Backlog, Repository)
 * inside the wizard's Brief/Context step, plus the finish-setup step's focus
 * landing (TG4). It uses accessibility-tree / role / `aria-*` locators
 * throughout (this is an a11y test — prefer the AX tree over CSS), reaching for
 * the cards' `data-testid` disclosure triggers only because the trigger is a
 * generic `<button>` whose accessible name ("Connect a backlog" / "Connect a
 * code repository") is also rendered as visible card copy and so is a less
 * stable selector than the stable testid the component already ships.
 *
 * Component contract under test (from
 * `…/components/wizard/WizardBacklogCard.tsx` and `WizardRepositoryCard.tsx`,
 * rendered by `BasicInfoStep.tsx`):
 *   - Each disclosure trigger is a real `<button>` (Radix Collapsible) carrying
 *     `aria-expanded` (reflects open state) and `aria-controls` (points at the
 *     region id). The region's `id` matches that `aria-controls`.
 *   - On expand, focus moves to the FIRST focusable control inside the region.
 *   - Enter AND Space both toggle the trigger (native `<button>` semantics).
 *   - The finish-setup step (`WizardFinishStep.tsx`) focuses its `h2` on entry.
 *
 * Status: SKIPPED in CI by default — matches the deferral pattern of the
 * unified-context-wizard a11y spec (needs a live local stack for auth + the
 * wizard route to render). Run locally with:
 *   pnpm --filter web e2e tests/e2e/projects/unified-project-setup-a11y.spec.ts
 *
 * Run criteria (drop the `test.skip` when ALL are true):
 *   (a) `./aspire.sh restart` has the stack healthy (Postgres, Temporal,
 *       temporal-worker, web app all `Running`).
 *   (b) `tests/auth.setup.ts` has seeded a signed-in Personal-tenant user.
 *   (c) The wizard route `/app/projects/new` renders post-login.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";

/** The unified wizard renders directly at this route (TG1, spec §4.1). */
const WIZARD_URL = "/app/projects/new";

/**
 * Both optional cards share the same disclosure contract; parameterizing keeps
 * the assertions identical and self-documenting. `triggerTestId` selects the
 * card's `<button>`; `firstControl` resolves the first interactive element
 * inside the expanded region — the element the component is expected to focus.
 */
interface CardCase {
	label: string;
	triggerTestId: string;
	cardTestId: string;
	/** Resolve the control focus should land on after expand. */
	firstControl: (page: Page) => Locator;
}

const CARDS: CardCase[] = [
	{
		label: "Backlog",
		triggerTestId: "backlog-card-trigger",
		cardTestId: "backlog-card",
		// First focusable in WizardBacklogCard's region is the PMToolSelect
		// combobox trigger.
		firstControl: (page) =>
			page.getByTestId("backlog-card").getByRole("combobox").first(),
	},
	{
		label: "Repository",
		triggerTestId: "repository-card-trigger",
		cardTestId: "repository-card",
		// First focusable in WizardRepositoryCard's region is the
		// "Repository URLs" text input.
		firstControl: (page) =>
			page.getByTestId("repository-card").getByRole("textbox").first(),
	},
];

/**
 * Drive the wizard to the Brief step with the optional cards rendered. The
 * cards render unconditionally on the Brief step, so a fresh navigation is all
 * that's required — no project name / draft is needed just to inspect the
 * disclosure contract.
 */
async function gotoBriefStep(page: Page): Promise<void> {
	await page.goto(WIZARD_URL);
	// The two cards live in the `optional-integrations` group on the Brief
	// step; wait for the region rather than an arbitrary timeout.
	await expect(page.getByTestId("optional-integrations")).toBeVisible({
		timeout: 15_000,
	});
}

/** The disclosure trigger `<button>` for a card. */
function trigger(page: Page, card: CardCase): Locator {
	return page.getByTestId(card.triggerTestId);
}

test.describe("Unified Project Setup Wizard — keyboard a11y", () => {
	test.skip(
		() => true,
		"Deferred to local runs — same convention as unified-context-wizard/a11y-wizard.spec.ts. Needs a live local stack (auth fixtures + the /app/projects/new wizard route).",
	);

	test.beforeEach(async ({ page }) => {
		await gotoBriefStep(page);
	});

	// AC 7.2: `aria-expanded` toggles correctly and `aria-controls` points at
	// the region id on BOTH disclosure triggers.
	for (const card of CARDS) {
		test(`${card.label} card: aria-expanded / aria-controls reflect disclosure state`, async ({
			page,
		}) => {
			const triggerBtn = trigger(page, card);
			await expect(triggerBtn).toBeVisible();

			// Collapsed: aria-expanded="false"; aria-controls present and
			// non-empty (the static reference to the region id).
			await expect(triggerBtn).toHaveAttribute("aria-expanded", "false");
			const controlsId = await triggerBtn.getAttribute("aria-controls");
			expect(
				controlsId,
				"trigger must declare aria-controls",
			).toBeTruthy();

			// Expand via keyboard (Enter) and assert the state flips.
			await triggerBtn.focus();
			await expect(triggerBtn).toBeFocused();
			await page.keyboard.press("Enter");
			await expect(triggerBtn).toHaveAttribute("aria-expanded", "true");

			// The element referenced by aria-controls now exists and is the
			// expanded region (Radix mounts CollapsibleContent on open).
			const region = page.locator(`#${CSS.escape(controlsId as string)}`);
			await expect(region).toBeVisible();

			// Collapse again and assert it returns to false.
			await triggerBtn.focus();
			await page.keyboard.press("Enter");
			await expect(triggerBtn).toHaveAttribute("aria-expanded", "false");
		});
	}

	// AC 7.2: keyboard-only path expands AND collapses BOTH cards via Enter and
	// Space on the disclosure trigger (native <button> activates on both keys).
	for (const card of CARDS) {
		for (const key of ["Enter", "Space"] as const) {
			test(`${card.label} card: ${key} expands then collapses the disclosure`, async ({
				page,
			}) => {
				const triggerBtn = trigger(page, card);

				// Reach the trigger with the keyboard, then toggle open.
				await triggerBtn.focus();
				await expect(triggerBtn).toBeFocused();
				await page.keyboard.press(key);
				await expect(triggerBtn).toHaveAttribute(
					"aria-expanded",
					"true",
				);
				await expect(page.getByTestId(card.cardTestId)).toContainText(
					/.+/,
				);

				// Toggle closed with the same key. Focus may have moved into the
				// region on expand, so re-focus the trigger first (a keyboard
				// user does this with Shift+Tab; focusing directly keeps the
				// assertion about the trigger's own behavior).
				await triggerBtn.focus();
				await page.keyboard.press(key);
				await expect(triggerBtn).toHaveAttribute(
					"aria-expanded",
					"false",
				);
			});
		}
	}

	// AC 7.2: on expand, focus moves INTO the expanded region (first control).
	for (const card of CARDS) {
		test(`${card.label} card: expanding moves focus into the region's first control`, async ({
			page,
		}) => {
			const triggerBtn = trigger(page, card);
			await triggerBtn.focus();
			await page.keyboard.press("Enter");
			await expect(triggerBtn).toHaveAttribute("aria-expanded", "true");

			// The component's expand effect focuses the first focusable element
			// inside the region. Assert focus is no longer on the trigger and
			// has landed on that control.
			const first = card.firstControl(page);
			await expect(first).toBeFocused();
		});
	}

	// AC 7.2: the wizard is operable without a mouse — tab order is sane through
	// the Brief step and reaches BOTH card triggers in source order
	// (name → brief → … → backlog trigger → repository trigger).
	test("keyboard tab order reaches both card triggers in order", async ({
		page,
	}) => {
		// The name input autofocuses on mount; start tabbing from there and
		// assert each card trigger becomes focused as we advance, and that the
		// backlog trigger is reached before the repository trigger.
		const backlogTrigger = trigger(page, CARDS[0]);
		const repoTrigger = trigger(page, CARDS[1]);

		await expect(page.getByLabel(/project name/i)).toBeFocused();

		// Tab forward until the backlog trigger gains focus. Bounded so a
		// regression that drops the trigger from the tab order fails fast
		// instead of looping — this is a "reachable in a sane number of stops"
		// assertion, not an arbitrary timeout.
		await tabUntilFocused(page, backlogTrigger, 25);
		await expect(backlogTrigger).toBeFocused();

		// From the backlog trigger, the repository trigger is the next stop
		// (collapsed backlog card exposes no inner controls).
		await tabUntilFocused(page, repoTrigger, 5);
		await expect(repoTrigger).toBeFocused();
	});

	// AC 7.2 (focus management, §7): a keyboard user can expand a card, operate
	// its first control, and Shift+Tab back to the trigger to collapse it —
	// i.e. the card is fully operable in both directions without a mouse.
	test("Backlog card: Shift+Tab from the focused first control returns to the trigger", async ({
		page,
	}) => {
		const triggerBtn = trigger(page, CARDS[0]);
		await triggerBtn.focus();
		await page.keyboard.press("Enter");
		await expect(triggerBtn).toHaveAttribute("aria-expanded", "true");

		// Focus is on the first control inside the region (asserted elsewhere);
		// Shift+Tab walks back to the disclosure trigger.
		await page.keyboard.press("Shift+Tab");
		await expect(triggerBtn).toBeFocused();

		// And the trigger still collapses from there.
		await page.keyboard.press("Enter");
		await expect(triggerBtn).toHaveAttribute("aria-expanded", "false");
	});

	/**
	 * AC 7.2 (finish-setup focus): on entering the post-create finish-setup step
	 * (`WizardFinishStep.tsx`, TG4), focus lands on its heading.
	 *
	 * The finish step only renders after a real `projects.create` round-trip,
	 * which needs the live oRPC/DB stack and a unique project name. Rather than
	 * assert nothing, this leg is annotated `fixme` with the exact local recipe
	 * so an operator running against the stack can drop the annotation and
	 * exercise it. Its assertion is the real focus contract (`h2` focused,
	 * "Go to project" reachable), not a placeholder.
	 */
	test.fixme(
		"finish-setup step lands focus on its heading and exposes 'Go to project'",
		async ({ page }) => {
			// Local recipe: create a brief-only project to land on finish-setup.
			const name = `A11y Finish ${Date.now()}`;
			await page.getByLabel(/project name/i).fill(name);
			await page.getByLabel(/project name/i).blur();
			await expect(page.getByText(/Draft saved/i).first()).toBeVisible({
				timeout: 15_000,
			});

			// Advance through the wizard to create (step labels/route depend on
			// the live wizard; an operator wires the exact "Next"/"Create"
			// sequence here). On success the finish step mounts.
			// …drive create here…

			// Contract: the finish-step heading receives focus on mount, and the
			// primary action is reachable by role/name.
			const heading = page.getByRole("heading", { name: /is ready/i });
			await expect(heading).toBeFocused();
			await expect(
				page.getByRole("button", { name: /go to project/i }),
			).toBeVisible();
		},
	);
});

/**
 * Press Tab up to `maxStops` times, resolving as soon as `target` is focused.
 * Bounded (no infinite loop, no fixed sleep) so a regression that removes the
 * element from the tab order fails the subsequent `toBeFocused()` assertion
 * quickly rather than hanging. Waits on the focus condition, not the clock.
 */
async function tabUntilFocused(
	page: Page,
	target: Locator,
	maxStops: number,
): Promise<void> {
	for (let i = 0; i < maxStops; i++) {
		if (
			await target
				.evaluate((el) => el === document.activeElement)
				.catch(() => false)
		) {
			return;
		}
		await page.keyboard.press("Tab");
	}
}
