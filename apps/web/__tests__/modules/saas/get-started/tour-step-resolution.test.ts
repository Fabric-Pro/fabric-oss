/**
 * Which tour steps a given viewer actually sees (Fizzy #2360, #2361).
 *
 * Five of the eleven registry steps target a project. When the viewer has none,
 * each of them independently fell back to the spotlight's "Create your first
 * project" card, so the same slide rendered five times in a row at positions
 * 4-8. `resolveTourSteps` collapses that run to a single step; these tests pin
 * both that collapse AND the far more important case it must not disturb —
 * a viewer who does have a project still sees every step.
 *
 * Fizzy #2361 added two centered key steps around that run. They are NOT
 * project-scoped, so the collapse must leave them alone — the enumerations
 * below are what proves it, and what would fail if a later change made the
 * collapse coarser than "drop project steps".
 */

import { describe, expect, it } from "vitest";
import {
	ONBOARDING_REQUIRED_AREAS,
	ONBOARDING_STEPS,
	type OnboardingStep,
	resolveTourPosition,
	resolveTourSteps,
} from "../../../../modules/saas/get-started/lib/tour-steps";

/** Tab-visibility predicate that hides the named tabs and shows the rest. */
const hiding =
	(...hidden: string[]) =>
	(tab: string) =>
		!hidden.includes(tab);
const allVisible = () => true;

const ids = (steps: readonly OnboardingStep[]) => steps.map((s) => s.id);

const isProjectScoped = (step: OnboardingStep) =>
	step.target.kind === "projectTab" ||
	step.target.kind === "projectComponent";

const BASE = "/app/example-org";

/** Where a step's "Take me there" points for this viewer, or null if nowhere. */
const hrefOf = (id: string, isOrganizationAdmin: boolean) => {
	const { target } = ONBOARDING_STEPS.find((s) => s.id === id) ?? {};
	if (
		!target ||
		(target.kind !== "center" && target.kind !== "anchor") ||
		!target.navigate
	) {
		return null;
	}
	return target.navigate(BASE, { isOrganizationAdmin });
};

describe("the two key steps (Fizzy #2361)", () => {
	it("opens the tour with the AI provider key, right after the greeting", () => {
		// FR1/AC1. `welcome` is a greeting, not a content slide — `aiKey` is
		// the first thing the tour actually says.
		expect(ids(ONBOARDING_STEPS).slice(0, 2)).toEqual(["welcome", "aiKey"]);
	});

	it("puts the API key step last, just before the wrap-up", () => {
		// FR5. Deliberately NOT next to `aiKey`: a provider key is required
		// for Fabric to work, a Fabric API key is an optional way to drive it
		// from outside. See the comment on the step itself.
		expect(ids(ONBOARDING_STEPS).slice(-2)).toEqual(["apiKey", "wrapup"]);
	});

	it("sends an admin to the organization AI provider page", () => {
		// FR2/AC2.
		expect(hrefOf("aiKey", true)).toBe(`${BASE}/settings/ai-providers`);
	});

	it("sends a member to the page they can actually submit", () => {
		// The org page renders read-only for everyone but an admin, so a
		// member sent there is told to add a key and then handed a form they
		// cannot use — the exact trap Fizzy #1875 split these two pages to
		// avoid. The account page works for any member.
		expect(hrefOf("aiKey", false)).toBe(
			`${BASE}/settings/account/ai-providers`,
		);
	});

	it("sends everyone to the same API key page", () => {
		// FR5. Unlike AI providers, this page is not admin-gated — a member
		// creates and revokes their own keys there.
		expect(hrefOf("apiKey", true)).toBe(`${BASE}/settings/api-keys`);
		expect(hrefOf("apiKey", false)).toBe(`${BASE}/settings/api-keys`);
	});

	it("leaves the greeting with nowhere to go", () => {
		expect(hrefOf("welcome", true)).toBeNull();
	});

	it("guards both areas so neither can be silently dropped", () => {
		// The drift test asserts every required area has a step; listing these
		// is what makes removing either slide fail CI rather than pass quietly.
		expect(ONBOARDING_REQUIRED_AREAS).toContain("aiKey");
		expect(ONBOARDING_REQUIRED_AREAS).toContain("apiKey");
	});
});

describe("resolveTourSteps — viewer has a project", () => {
	it("returns the full registry, untouched, in order", () => {
		const steps = resolveTourSteps({
			hasProject: true,
			isTabVisible: allVisible,
		});

		expect(ids(steps)).toEqual(ids(ONBOARDING_STEPS));
	});

	it("still drops a project step whose tab is hidden from the viewer", () => {
		// Card #1837: roadmap and proposals both live on the stories tab.
		const steps = resolveTourSteps({
			hasProject: true,
			isTabVisible: hiding("stories"),
		});

		expect(ids(steps)).not.toContain("roadmap");
		expect(ids(steps)).not.toContain("proposals");
		expect(ids(steps)).toContain("overview");
		expect(ids(steps)).toContain("atlas");
	});
});

describe("resolveTourSteps — viewer has no project", () => {
	it("collapses the project-scoped run to a single step", () => {
		const steps = resolveTourSteps({
			hasProject: false,
			isTabVisible: allVisible,
		});

		expect(ids(steps)).toEqual([
			"welcome",
			"aiKey",
			"assistant",
			"projects",
			"overview",
			"apiKey",
			"wrapup",
		]);
	});

	it("keeps both key steps — the collapse only touches project steps", () => {
		// Fizzy #2361. `aiKey` and `apiKey` are centered steps with no project
		// tab, so `projectTabOf` returns null for them and the no-project
		// collapse must pass them straight through.
		const steps = resolveTourSteps({
			hasProject: false,
			isTabVisible: allVisible,
		});

		for (const id of ["aiKey", "apiKey"]) {
			expect(ids(steps).filter((s) => s === id)).toEqual([id]);
		}
	});

	it("never shows two project-scoped steps back to back", () => {
		// The #2360 repeat restated as an invariant rather than a sequence:
		// consecutive project steps are what let the same fallback card render
		// twice, whatever else the registry gains around them.
		const steps = resolveTourSteps({
			hasProject: false,
			isTabVisible: allVisible,
		});

		for (let i = 1; i < steps.length; i++) {
			expect(
				isProjectScoped(steps[i]) && isProjectScoped(steps[i - 1]),
			).toBe(false);
		}
	});

	it("keeps exactly one project-scoped step", () => {
		const steps = resolveTourSteps({
			hasProject: false,
			isTabVisible: allVisible,
		});

		expect(steps.filter(isProjectScoped)).toHaveLength(1);
	});

	it("shows no slide twice in a row", () => {
		const steps = resolveTourSteps({
			hasProject: false,
			isTabVisible: allVisible,
		});

		for (let i = 1; i < steps.length; i++) {
			expect(steps[i].id).not.toBe(steps[i - 1].id);
			expect(steps[i].area).not.toBe(steps[i - 1].area);
		}
	});

	it("keeps the first step the viewer can actually reach, not a fixed one", () => {
		// Overview hidden — the kept step must be the next visible project
		// step, or the tour spotlights a tab this viewer cannot open.
		const steps = resolveTourSteps({
			hasProject: false,
			isTabVisible: hiding("overview"),
		});

		expect(steps.filter(isProjectScoped).map((s) => s.id)).toEqual([
			"documents",
		]);
	});

	it("survives every project tab being hidden", () => {
		const steps = resolveTourSteps({
			hasProject: false,
			isTabVisible: () => false,
		});

		expect(ids(steps)).toEqual([
			"welcome",
			"aiKey",
			"assistant",
			"projects",
			"apiKey",
			"wrapup",
		]);
	});
});

describe("resolveTourSteps — project existence not yet known", () => {
	it("does not collapse while the query is unsettled", () => {
		// Collapsing on `undefined` would strip real steps from viewers who do
		// have projects — a worse bug than the repeated slide.
		const steps = resolveTourSteps({
			hasProject: undefined,
			isTabVisible: allVisible,
		});

		expect(ids(steps)).toEqual(ids(ONBOARDING_STEPS));
	});
});

describe("resolveTourSteps — output integrity", () => {
	const cases = [
		{ name: "has project", hasProject: true, isTabVisible: allVisible },
		{ name: "no project", hasProject: false, isTabVisible: allVisible },
		{ name: "unsettled", hasProject: undefined, isTabVisible: allVisible },
		{
			name: "no project, overview hidden",
			hasProject: false,
			isTabVisible: hiding("overview"),
		},
		{
			name: "has project, stories hidden",
			hasProject: true,
			isTabVisible: hiding("stories"),
		},
	] as const;

	for (const c of cases) {
		it(`yields no holes or duplicates (${c.name})`, () => {
			const steps = resolveTourSteps({
				hasProject: c.hasProject,
				isTabVisible: c.isTabVisible,
			});

			expect(steps.every(Boolean)).toBe(true);
			expect(new Set(ids(steps)).size).toBe(steps.length);
			// Registry order is preserved.
			const registryOrder = ids(ONBOARDING_STEPS);
			const positions = ids(steps).map((id) => registryOrder.indexOf(id));
			expect(positions).toEqual([...positions].sort((a, b) => a - b));
		});
	}
});

describe("resolveTourPosition — the viewer keeps their place", () => {
	const all = ONBOARDING_STEPS;
	const without = (...dropped: string[]) =>
		all.filter((s) => !dropped.includes(s.id));

	it("follows a step that merely moved", () => {
		// roadmap and proposals sit before atlas; dropping them shifts atlas
		// from 7 to 5. A bare index would have left the viewer on wrapup.
		const steps = without("roadmap", "proposals");
		expect(steps[resolveTourPosition(steps, "atlas")].id).toBe("atlas");
	});

	it("moves to the next survivor when the step is removed", () => {
		const steps = without("roadmap", "proposals");
		expect(steps[resolveTourPosition(steps, "roadmap")].id).toBe("atlas");
	});

	it("skips nothing when the same update also removes an earlier step", () => {
		// The case a stale index gets wrong: on `documents`, with `overview`
		// AND `documents` both gone, index 4 would select proposals and skip
		// roadmap entirely. Registry order gives the real successor.
		const steps = without("overview", "documents");
		expect(steps[resolveTourPosition(steps, "documents")].id).toBe(
			"roadmap",
		);
	});

	it("skips nothing when several consecutive steps go at once", () => {
		const steps = without("overview", "documents", "roadmap");
		expect(steps[resolveTourPosition(steps, "overview")].id).toBe(
			"proposals",
		);
	});

	it("lands on the last step when nothing after it survived", () => {
		const steps = without("wrapup");
		expect(steps[resolveTourPosition(steps, "wrapup")].id).toBe("apiKey");
	});

	it("moves a viewer off a hidden atlas onto the next survivor", () => {
		// Fizzy #2361: apiKey sits between atlas and wrapup, so a viewer whose
		// atlas tab is hidden mid-run lands there rather than skipping to the
		// end. Pins that the new step is reachable from a resumed position.
		const steps = without("atlas");
		expect(steps[resolveTourPosition(steps, "atlas")].id).toBe("apiKey");
	});

	it("starts at the beginning with no remembered step", () => {
		expect(resolveTourPosition(all, null)).toBe(0);
	});

	it("never returns an out-of-range index", () => {
		// The render gate is `steps[index]`, so an out-of-range answer would
		// unmount the tour outright.
		const cases: readonly (readonly OnboardingStep[])[] = [
			all,
			without("roadmap", "proposals"),
			without("overview", "documents", "roadmap", "proposals", "atlas"),
			[],
		];
		for (const steps of cases) {
			for (const id of [...all.map((s) => s.id), null, "gone"]) {
				const at = resolveTourPosition(steps, id);
				expect(at).toBeGreaterThanOrEqual(0);
				if (steps.length > 0) {
					expect(steps[at]).toBeDefined();
				}
			}
		}
	});
});
