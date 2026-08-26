import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import {
	newStepKey,
	reorderSteps,
	type StepDraft,
	StepEditor,
} from "../StepEditor";

/** Controlled harness — StepEditor lifts its step list to the parent. */
function Harness({ initial = [] as StepDraft[] }: { initial?: StepDraft[] }) {
	const [steps, setSteps] = useState<StepDraft[]>(initial);
	return <StepEditor steps={steps} onChange={setSteps} />;
}

// The global next-intl mock (vitest.setup.ts) returns the bare i18n key for
// every `t(key)` call and ignores interpolation params, so the localized
// labels/aria render as their key paths (e.g. "steps.actionAria").
describe("StepEditor", () => {
	it("adds a step row when 'Add step' is clicked", async () => {
		const user = userEvent.setup();
		render(<Harness />);
		expect(screen.queryByLabelText("steps.actionAria")).toBeNull();

		await user.click(screen.getByRole("button", { name: "steps.add" }));

		expect(screen.getByLabelText("steps.actionAria")).toBeInTheDocument();
		expect(screen.getByLabelText("steps.expectedAria")).toBeInTheDocument();
	});

	it("removes a step when its delete control is clicked", async () => {
		const user = userEvent.setup();
		render(
			<Harness
				initial={[{ key: "a", action: "do it", expected: "works" }]}
			/>,
		);
		expect(screen.getByLabelText("steps.actionAria")).toBeInTheDocument();

		await user.click(
			screen.getByRole("button", { name: "steps.deleteAria" }),
		);

		expect(screen.queryByLabelText("steps.actionAria")).toBeNull();
	});

	it("reorderSteps moves a step and is a no-op for same/unknown keys", () => {
		const steps: StepDraft[] = [
			{ key: "a", action: "1", expected: "" },
			{ key: "b", action: "2", expected: "" },
			{ key: "c", action: "3", expected: "" },
		];
		expect(reorderSteps(steps, "a", "c").map((s) => s.key)).toEqual([
			"b",
			"c",
			"a",
		]);
		expect(reorderSteps(steps, "c", "a").map((s) => s.key)).toEqual([
			"c",
			"a",
			"b",
		]);
		// Same position and unknown keys return the original array unchanged.
		expect(reorderSteps(steps, "a", "a")).toBe(steps);
		expect(reorderSteps(steps, "zzz", "a")).toBe(steps);
	});

	it("newStepKey produces unique keys", () => {
		expect(newStepKey()).not.toEqual(newStepKey());
	});
});
