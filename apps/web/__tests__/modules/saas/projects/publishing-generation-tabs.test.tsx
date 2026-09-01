import { GenerationTabs } from "@saas/projects/components/publishing-suite/GenerationTabs";
import type { PlanningAnalysisDocument } from "@saas/projects/components/publishing-suite/planning-analysis-content";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

/**
 * The generation tab strip (Fizzy #1853, Phase 2B-1).
 *
 * Assertions are on the ACCESSIBLE NAME of each trigger, never on a class. FR5
 * requires state not to rely on colour alone, and a test that asserted
 * `class="text-primary"` would pass on a build where the badge TEXT had been
 * dropped — which is precisely the regression FR5 exists to prevent.
 */

function analysisWith(
	buckets: Partial<
		Record<
			"recommended" | "needsConfirmation" | "deferred",
			{ type: string; rationale: string }[]
		>
	>,
): PlanningAnalysisDocument {
	const filled = (
		["recommended", "needsConfirmation", "deferred"] as const
	).flatMap((key) => {
		const items = buckets[key] ?? [];
		return items.length > 0 ? [{ key, label: key, items }] : [];
	});
	return {
		prose: [],
		keyDetails: [],
		buckets:
			filled.length > 0
				? [
						{
							key: "contentTypes",
							label: "Content types",
							buckets: filled,
						},
					]
				: [],
		sourceSignals: [],
		risks: [],
		questions: [],
		preDraftGuidance: null,
	};
}

function thread(over: Record<string, unknown> = {}) {
	return {
		root: {
			id: "thread-1",
			parentId: null,
			kind: "QUESTION",
			status: "OPEN",
			authorType: "AGENT",
			authorUserId: null,
			questionId: "q1",
			decisionKind: "CUSTOMER_NAME",
			subject: "the customer name",
			summary: null,
			content: "May we name the customer?",
			recommendedResponse: null,
			whyItMatters: null,
			answerSource: null,
			analysisVersion: 1,
			createdAt: new Date(),
			...over,
		},
		replies: [],
	} as never;
}

function renderTabs(over: Partial<Parameters<typeof GenerationTabs>[0]> = {}) {
	return render(
		<GenerationTabs
			analysis={null}
			drafts={[]}
			workingDrafts={[]}
			decisionThreads={[]}
			isLoading={false}
			hasError={false}
			{...over}
		/>,
	);
}

const tablist = () =>
	screen.getByRole("tablist", { name: /content generation/i });

describe("GenerationTabs — which tabs are live", () => {
	it("enables the two Phase 2B content types", () => {
		renderTabs();

		expect(
			within(tablist()).getByRole("tab", {
				name: /short post \/ tweet/i,
			}),
		).toBeEnabled();
		expect(
			within(tablist()).getByRole("tab", { name: /blog post/i }),
		).toBeEnabled();
	});

	it("leaves the Phase 2C content types disabled and Coming Soon", () => {
		renderTabs();

		for (const label of ["Case Study", "Stakeholder Email"]) {
			expect(
				within(tablist()).getByRole("tab", {
					name: new RegExp(`${label}.*coming soon`, "i"),
				}),
			).toBeDisabled();
		}
	});

	it("uses the card's name for the short-post tab without renaming the Inbox chip", () => {
		// One list with two label fields, not two lists. The Inbox chip keeps
		// the short "Tweet"; only the generation tab reads the longer name.
		renderTabs();

		expect(
			within(tablist()).getByRole("tab", {
				name: /short post \/ tweet/i,
			}),
		).toBeInTheDocument();
	});
});

describe("GenerationTabs — state is in the accessible name (FR5)", () => {
	it("announces Recommended for a type the analysis recommends", () => {
		renderTabs({
			analysis: analysisWith({
				recommended: [{ type: "Blog Post", rationale: "worth it" }],
			}),
		});

		expect(
			within(tablist()).getByRole("tab", {
				name: /blog post.*recommended/i,
			}),
		).toBeInTheDocument();
	});

	it("announces Generated for a type with a READY draft", () => {
		renderTabs({
			drafts: [
				{
					postType: "TWEET",
					latestAttempt: null,
					latestReady: {
						id: "d1",
						postType: "TWEET",
						version: 1,
						status: "READY",
						error: null,
						createdAt: new Date(),
						updatedAt: new Date(),
					},
				},
			],
		});

		expect(
			within(tablist()).getByRole("tab", {
				name: /short post \/ tweet.*generated/i,
			}),
		).toBeInTheDocument();
	});

	it("announces Needs confirmation for a deferred type", () => {
		renderTabs({
			analysis: analysisWith({
				deferred: [{ type: "Blog Post", rationale: "not yet" }],
			}),
		});

		expect(
			within(tablist()).getByRole("tab", {
				name: /blog post.*needs confirmation/i,
			}),
		).toBeInTheDocument();
	});

	it("still announces the caution on a GENERATED tab the analysis deferred", () => {
		// THE case. `GENERATED` outranks `NEEDS_CONFIRMATION`, and 2A mints no
		// question for `deferred` — so a marker keyed on open questions alone
		// would leave this tab silent about a real caution.
		renderTabs({
			analysis: analysisWith({
				deferred: [{ type: "Blog Post", rationale: "not yet" }],
			}),
			workingDrafts: [
				{
					postType: "BLOG_POST",
					hasBody: true,
					sourceOptionLabel: null,
					updatedAt: new Date(),
				},
			],
		});

		const tab = within(tablist()).getByRole("tab", {
			name: /blog post.*generated.*needs confirmation/i,
		});
		expect(tab).toBeInTheDocument();
	});

	it("keeps an AVAILABLE type plain but still names its state", () => {
		// The card says a not-recommended type "should not be visually
		// promoted", so it gets no badge — but the state must not be invisible
		// to a screen-reader user while being visible to a sighted one.
		renderTabs();

		expect(
			within(tablist()).getByRole("tab", {
				name: /short post \/ tweet.*available/i,
			}),
		).toBeInTheDocument();
	});
});

describe("GenerationTabs — panel content", () => {
	it("shows the analysis's own rationale (FR6/FR7)", () => {
		renderTabs({
			analysis: analysisWith({
				recommended: [
					{ type: "Short Post / Tweet", rationale: "a crisp result" },
				],
			}),
		});

		expect(screen.getByText(/a crisp result/i)).toBeInTheDocument();
	});

	it("says planning has not run rather than inventing a recommendation", () => {
		renderTabs({ analysis: null });

		expect(
			screen.getByText(/no planning analysis yet/i),
		).toBeInTheDocument();
	});

	it("names an unresolved approval by SUBJECT, not by restating the question", () => {
		// The full question text and the control that answers it live on the
		// Summary & Questions tab. Both panels are mounted at once, so
		// restating it here would put the same sentence on the page twice with
		// only one of them actionable.
		renderTabs({ decisionThreads: [thread()] });

		expect(screen.getByText("the customer name")).toBeInTheDocument();
		expect(
			screen.queryByText(/may we name the customer\?/i),
		).not.toBeInTheDocument();
	});

	it("lists ONLY the restricting questions when the topic has a mix", async () => {
		// The case every earlier fixture missed by holding a single kind. An
		// earlier version filtered on the AGGREGATED `global` flag, so one
		// safety-critical question let EVERY open thread through — including
		// the authorship question this list exists to keep out. A homogeneous
		// fixture cannot tell the two implementations apart.
		renderTabs({
			decisionThreads: [
				thread({
					id: "t-critical",
					decisionKind: "CUSTOMER_NAME",
					subject: "the customer name",
				}),
				thread({
					id: "t-authorship",
					decisionKind: "AUTHORSHIP",
					subject: "who signs the post",
					content: "Who should be credited?",
				}),
				thread({
					id: "t-audience",
					decisionKind: "AUDIENCE_SCOPE",
					subject: "the audience",
					content: "Internal or external?",
				}),
			],
		});

		const listed = screen
			.getAllByRole("listitem")
			.map((li) => li.textContent);

		expect(listed).toEqual(["the customer name"]);
	});

	it("lists a CONTENT_TYPE question alongside a safety-critical one", async () => {
		// Both arms of the predicate at once, so a fix that kept only one arm
		// cannot pass.
		renderTabs({
			decisionThreads: [
				thread({
					id: "t-critical",
					decisionKind: "ASSET_APPROVAL",
					subject: "the architecture diagram",
				}),
				thread({
					id: "t-type",
					decisionKind: "CONTENT_TYPE",
					subject: "Blog Post",
				}),
				thread({
					id: "t-noise",
					decisionKind: "AUTHORSHIP",
					subject: "who signs the post",
				}),
			],
		});

		// Scoped to the LIST, not the page: "Blog Post" is also a tab label, and
		// a page-wide query cannot tell the restriction entry from the tab.
		const listed = screen
			.getAllByRole("listitem")
			.map((li) => li.textContent);

		expect(listed).toContain("the architecture diagram");
		expect(listed).toContain("Blog Post");
		expect(listed).not.toContain("who signs the post");
	});

	it("offers no generate control in this phase", async () => {
		const user = userEvent.setup();
		renderTabs();

		await user.click(
			within(tablist()).getByRole("tab", { name: /blog post/i }),
		);
		expect(
			screen.queryByRole("button", { name: /generate/i }),
		).not.toBeInTheDocument();
		expect(
			screen.getByText(/arrives in the next release/i),
		).toBeInTheDocument();
	});

	it("reports a saved working draft", () => {
		renderTabs({
			workingDrafts: [
				{
					postType: "TWEET",
					hasBody: true,
					sourceOptionLabel: "Option 1",
					updatedAt: new Date(),
				},
			],
		});

		expect(screen.getByText(/you have a saved draft/i)).toBeInTheDocument();
	});
});

describe("GenerationTabs — degraded read", () => {
	it("keeps the tabs usable and says the state could not be loaded", () => {
		renderTabs({ hasError: true });

		expect(
			screen.getByTestId("generation-tabs-degraded"),
		).toBeInTheDocument();
		// The tab strip itself still works — the recommendation context comes
		// from a DIFFERENT query, so one failing read must not blank the lot.
		expect(
			within(tablist()).getByRole("tab", { name: /blog post/i }),
		).toBeEnabled();
	});

	it("never claims a type is generated when the read failed", () => {
		renderTabs({
			hasError: true,
			workingDrafts: [
				{
					postType: "TWEET",
					hasBody: true,
					sourceOptionLabel: null,
					updatedAt: new Date(),
				},
			],
		});

		expect(
			within(tablist()).queryByRole("tab", {
				name: /short post \/ tweet.*generated/i,
			}),
		).not.toBeInTheDocument();
	});
});
