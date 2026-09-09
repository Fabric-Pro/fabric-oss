/**
 * ContentTypesChecklist — which formats to produce, as a list rather than a
 * dialog (Fizzy #1851).
 *
 * Two complaints from the card owner, one control:
 *
 *  - *"its simple setting, not question, it could be checkbox"* — the
 *    CONTENT_TYPE questions are gone and this replaces them.
 *  - *"i dont think modal is a good fit here, maybe it could be just list with
 *    checkboxes"* — a choice you revisit while reading the questions beside it
 *    should not hide behind a button.
 */

import { ContentTypesChecklist } from "@saas/projects/components/publishing-suite/ContentTypesChecklist";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const ANALYSIS = {
	prose: [],
	keyDetails: [],
	buckets: [
		{
			key: "contentTypes",
			label: "Content types",
			buckets: [
				{
					key: "recommended",
					label: "Recommended",
					items: [
						{
							type: "Tweet",
							rationale: "Fits a hard cap without setup.",
						},
					],
				},
				{
					key: "needsConfirmation",
					label: "Needs confirmation",
					items: [
						{
							type: "LinkedIn Post",
							rationale: "A second social format.",
						},
					],
				},
				{
					key: "deferred",
					label: "Deferred",
					items: [
						{
							type: "Case Study",
							rationale: "No customer outcomes available.",
						},
					],
				},
			],
		},
	],
	sourceSignals: [],
	risks: [],
} as never;

function renderChecklist(over: Record<string, unknown> = {}) {
	const onChange = vi.fn();
	render(
		<ContentTypesChecklist
			analysis={ANALYSIS}
			selected={[]}
			canEdit
			onChange={onChange}
			{...(over as never)}
		/>,
	);
	return { onChange };
}

describe("ContentTypesChecklist", () => {
	it("puts the analysis's reasoning ON the choice", () => {
		// The whole point of it being a setting rather than a question: the
		// rationale that used to be re-asked underneath now annotates the box.
		renderChecklist();

		expect(
			screen.getByText("Fits a hard cap without setup."),
		).toBeInTheDocument();
	});

	it("groups by the verdict the analysis reached", () => {
		renderChecklist();

		expect(screen.getByText(/^Recommended$/i)).toBeInTheDocument();
		expect(screen.getByText(/needs your call/i)).toBeInTheDocument();
		expect(screen.getByText(/deferred/i)).toBeInTheDocument();
	});

	it("still lets a deferred format be chosen", async () => {
		// The classification is advice. A setting whose options the AI can veto
		// is not a setting.
		const user = userEvent.setup();
		const { onChange } = renderChecklist();

		await user.click(screen.getByRole("checkbox", { name: /case study/i }));

		expect(onChange).toHaveBeenCalledWith(
			expect.arrayContaining(["CASE_STUDY"]),
		);
	});

	it("opens on a topic with nothing chosen", () => {
		renderChecklist({ selected: [] });

		expect(
			screen.getByRole("checkbox", { name: /tweet/i }),
		).toBeInTheDocument();
	});

	it("collapses once a choice exists, and says what it is", () => {
		// A decision already taken should not occupy a screen of vertical space
		// above the questions that still need one — and the header carries the
		// answer, so collapsing costs no information.
		renderChecklist({ selected: ["TWEET", "BLOG_POST"] });

		expect(
			screen.queryByRole("checkbox", { name: /tweet/i }),
		).not.toBeInTheDocument();
		expect(screen.getByText(/Tweet · Blog Post/)).toBeInTheDocument();
	});

	it("reopens on demand", async () => {
		const user = userEvent.setup();
		renderChecklist({ selected: ["TWEET"] });

		await user.click(
			screen.getByRole("button", { name: /content types/i }),
		);

		expect(
			screen.getByRole("checkbox", { name: /blog post/i }),
		).toBeInTheDocument();
	});

	it("offers every format when no analysis has run", () => {
		// Manual topics and everything from before the buckets existed. The
		// list must never be empty just because nothing has been classified.
		renderChecklist({ analysis: null });

		expect(
			screen.getByRole("checkbox", { name: /tweet/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("checkbox", { name: /case study/i }),
		).toBeInTheDocument();
	});

	it("can hand the topic back to the AI's suggestion", async () => {
		// Without this an override is one-way: once anyone has ticked a box,
		// nothing restores the recommendation.
		const user = userEvent.setup();
		const { onChange } = renderChecklist({ selected: ["TWEET"] });

		await user.click(
			screen.getByRole("button", { name: /content types/i }),
		);
		await user.click(screen.getByRole("button", { name: /reset/i }));

		expect(onChange).toHaveBeenCalledWith(null);
	});

	it("shows a reader the choice but no controls", () => {
		renderChecklist({ canEdit: false, selected: [] });

		expect(screen.getByRole("checkbox", { name: /tweet/i })).toBeDisabled();
		expect(
			screen.queryByRole("button", { name: /reset/i }),
		).not.toBeInTheDocument();
	});
});

/**
 * Defect §4 / finding #21. Sixteen topics sat near the top of the queue with an
 * empty picker, and the owner reported them as broken. They were not: they were
 * created before the suite recommended formats at all.
 *
 * "The analysis considered the formats and recommended none" and "this topic is
 * older than the feature that recommends them" look identical and mean opposite
 * things. A date is the only signal that separates them.
 */
describe("ContentTypesChecklist — topics older than the recommendations", () => {
	it("says why an old topic has nothing recommended", () => {
		renderChecklist({
			analysis: null,
			createdAt: new Date("2026-07-17T00:00:00.000Z"),
		});

		expect(
			screen.getByText(/created before the suite started recommending/i),
		).toBeInTheDocument();
	});

	it("stays quiet for a recent topic the analysis simply has not classified", () => {
		// Same empty list, opposite meaning. Saying "this predates the feature"
		// here would be false.
		renderChecklist({
			analysis: null,
			createdAt: new Date("2026-09-01T00:00:00.000Z"),
		});

		expect(
			screen.queryByText(
				/created before the suite started recommending/i,
			),
		).not.toBeInTheDocument();
	});

	it("stays quiet when the analysis DID classify, however old the topic", () => {
		// A topic explaining itself needs no explanation of the absence.
		renderChecklist({ createdAt: new Date("2026-07-01T00:00:00.000Z") });

		expect(
			screen.queryByText(
				/created before the suite started recommending/i,
			),
		).not.toBeInTheDocument();
	});
});
