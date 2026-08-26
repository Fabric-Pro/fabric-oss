/**
 * `LensAccuracy` — the false-positive figure, and when it is allowed to appear.
 *
 * The feature carries a target of under 20% false positives. Printing a
 * percentage is how that target becomes checkable, and it is also how a lens
 * gets condemned on two data points: one dismissal out of two reads as 50%.
 *
 * So the threshold is the behaviour under test, not decoration.
 *
 * What changed: this component printed the DISMISSAL rate while its own header
 * called it the false-positive figure. They are different measurements — three
 * of the four dismissal reasons record that a CORRECT finding went unactioned —
 * so the rate is now computed from dismissals reasoned INCORRECT only, and shown
 * against the target rather than beside it.
 */

import { LensAccuracy } from "@saas/projects/components/test-cases/pr-review/PullRequestReviewsPanel";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

type Lens = {
	lens: string;
	judged: number;
	dismissed: number;
	falsePositives: number;
	falsePositiveRate: number | null;
	meetsTarget: boolean | null;
	unclassifiedDismissals: number;
};

/** The threshold the SERVER reports. The panel keeps no copy of its own. */
const TARGET = 0.2;

/** A lens row with the derived rate filled in, so a test states only counts. */
function lens(over: Partial<Lens> & { lens: string; judged: number }): Lens {
	const falsePositives = over.falsePositives ?? 0;
	const rate = over.judged > 0 ? falsePositives / over.judged : null;
	return {
		dismissed: falsePositives,
		unclassifiedDismissals: 0,
		falsePositiveRate: rate,
		meetsTarget: rate === null ? null : rate < TARGET,
		...over,
		falsePositives,
	};
}

function renderAccuracy(lenses: Lens[]) {
	return render(
		<LensAccuracy
			lenses={lenses}
			target={TARGET}
			label={(name, falsePositives, judged, percent) =>
				`${name}: ${falsePositives} of ${judged} judged findings were wrong (${percent}% false positives)`
			}
			targetLabel={(percent) => `target under ${percent}%`}
			unclassifiedLabel={(count) =>
				`· ${count} dismissed without a reason`
			}
			lensName={(name) =>
				name === "QA" ? "QA lens" : "Architecture lens"
			}
		/>,
	);
}

describe("LensAccuracy", () => {
	it("states the rate with both numbers behind it", () => {
		renderAccuracy([lens({ lens: "QA", judged: 10, falsePositives: 2 })]);

		expect(
			screen.getByText(
				"QA lens: 2 of 10 judged findings were wrong (20% false positives)",
				{ exact: false },
			),
		).toBeVisible();
	});

	it("says nothing until a lens has been judged enough times", () => {
		// Four judgements is not a rate. A reader who sees 25% acts on it, and the
		// next two acceptances would move it to 17%.
		const { container } = renderAccuracy([
			lens({ lens: "QA", judged: 4, falsePositives: 1 }),
		]);

		expect(container).toBeEmptyDOMElement();
	});

	it("shows only the lenses that have enough judgements", () => {
		renderAccuracy([
			lens({ lens: "QA", judged: 12, falsePositives: 3 }),
			lens({ lens: "ARCHITECTURE", judged: 2, falsePositives: 0 }),
		]);

		expect(screen.getByText(/QA lens/)).toBeVisible();
		expect(screen.queryByText(/Architecture lens/)).toBeNull();
	});

	it("says nothing for a lens nobody has judged", () => {
		// Null is "no evidence either way", which must never render as 0%.
		const { container } = renderAccuracy([
			lens({ lens: "QA", judged: 0, falsePositives: 0 }),
		]);

		expect(container).toBeEmptyDOMElement();
	});

	it("rounds to whole percent rather than printing a float", () => {
		renderAccuracy([lens({ lens: "QA", judged: 7, falsePositives: 2 })]);

		expect(screen.getByText(/29% false positives/)).toBeVisible();
	});

	it("counts only findings dismissed as INCORRECT, not every dismissal", () => {
		// The defect this component shipped with: eight dismissals of which one
		// was the lens being wrong read as an 80% false-positive rate. The other
		// seven were correct findings nobody acted on.
		renderAccuracy([
			lens({
				lens: "QA",
				judged: 10,
				falsePositives: 1,
				dismissed: 8,
			}),
		]);

		expect(screen.getByText(/10% false positives/)).toBeVisible();
		expect(screen.queryByText(/80%/)).toBeNull();
	});

	it("states the target the rate is measured against", () => {
		renderAccuracy([lens({ lens: "QA", judged: 10, falsePositives: 1 })]);

		expect(screen.getByText("target under 20%")).toBeVisible();
	});

	it("says how much of the denominator is unclassified", () => {
		// A judgement with no reason recorded cannot count towards the rate, so a
		// reader is told rather than shown a figure that quietly understates it.
		renderAccuracy([
			lens({
				lens: "QA",
				judged: 10,
				falsePositives: 1,
				dismissed: 5,
				unclassifiedDismissals: 4,
			}),
		]);

		expect(
			screen.getByText("· 4 dismissed without a reason"),
		).toBeVisible();
	});
});
