/**
 * Which tour steps a given viewer actually sees (Fizzy #2360).
 *
 * Five of the nine registry steps target a project. When the viewer has none,
 * each of them independently fell back to the spotlight's "Create your first
 * project" card, so the same slide rendered five times in a row at positions
 * 4-8. `resolveTourSteps` collapses that run to a single step; these tests pin
 * both that collapse AND the far more important case it must not disturb —
 * a viewer who does have a project still sees every step.
 */

import { describe, expect, it } from "vitest";
import {
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
			"assistant",
			"projects",
			"overview",
			"wrapup",
		]);
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
			"assistant",
			"projects",
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
		expect(steps[resolveTourPosition(steps, "wrapup")].id).toBe("atlas");
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
