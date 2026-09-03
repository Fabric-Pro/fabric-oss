import { GenerationTabs } from "@saas/projects/components/publishing-suite/GenerationTabs";
import type { PlanningAnalysisDocument } from "@saas/projects/components/publishing-suite/planning-analysis-content";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

/**
 * A QueryClientProvider is required from Phase 2B-2 onward: the Short Post tab's
 * panel owns its own generate and select mutations, so the strip is no longer a
 * purely presentational component. Retries off and a fresh client per render, so
 * one test's cache cannot answer another's question.
 */
function renderTabs(over: Partial<Parameters<typeof GenerationTabs>[0]> = {}) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>
			<GenerationTabs
				projectId="p1"
				organizationId="org1"
				topicId="t1"
				canEdit={true}
				analysis={null}
				drafts={[]}
				workingDrafts={[]}
				decisionThreads={[]}
				isLoading={false}
				hasError={false}
				{...over}
			/>
		</QueryClientProvider>,
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

	it("activates BOTH 2C types, leaving no tab Coming Soon", () => {
		// Inverted twice, and the history is the assertion. 2A asserted all four
		// tabs were disabled and read "Coming soon"; 2B activated two; 2C-1
		// (#1854) activated Case Study and this case became "Case Study is live,
		// Stakeholder Email is not"; 2C-2 activates the last one. What would be
		// a regression now is either 2C tab being disabled — and a "Coming soon"
		// badge where a real state badge belongs, which is the half a mere
		// `toBeEnabled()` would not catch.
		renderTabs();

		for (const name of [/case study/i, /stakeholder email/i]) {
			const tab = within(tablist()).getByRole("tab", { name });
			expect(tab).toBeEnabled();
			expect(tab).toHaveAccessibleName(/available/i);
			expect(tab).not.toHaveAccessibleName(/coming soon/i);
		}
	});

	it("leaves NO tab reading Coming Soon at all", () => {
		// The whole-strip form of the case above. Asserting the two 2C tabs
		// individually would still pass on a build that regressed one of the 2B
		// ones back to a placeholder, and "every content type is live" is the
		// claim 2C-2 actually makes.
		renderTabs();

		expect(
			within(tablist()).queryByRole("tab", { name: /coming soon/i }),
		).not.toBeInTheDocument();
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

	it("lists a CASE-STUDY-only restriction on that tab and NOWHERE else", async () => {
		// THE control for 2C-1's other half. `restrictingSubjects` used to be
		// computed ONCE for the whole strip with the post-type-agnostic
		// `isRestrictingThread` and handed as the same array to every panel; it
		// is now computed per panel with `restrictsPostType(thread, postType)`.
		//
		// `CLAIM_STRENGTH` is one of the three kinds that restrict ONLY a case
		// study, so it is the one thread that can tell the two implementations
		// apart. Both halves are asserted: without the negative one, "no 2B
		// behaviour changed" is unverified — a build that listed the question on
		// every tab would pass the positive half alone.
		const user = userEvent.setup();
		renderTabs({
			decisionThreads: [
				thread({
					id: "t-claim",
					decisionKind: "CLAIM_STRENGTH",
					subject: "how strongly the result may be stated",
					content: "Is this number strong enough to claim?",
				}),
			],
		});

		// Tweet is the default tab. A claim-strength question does not constrain
		// a tweet — a tweet that cannot yet claim a number simply omits it — so
		// neither restriction section appears at all.
		expect(
			screen.queryByText(/unresolved approvals/i),
		).not.toBeInTheDocument();
		expect(
			screen.queryByText(/open questions that constrain this type/i),
		).not.toBeInTheDocument();
		expect(
			screen.queryByText("how strongly the result may be stated"),
		).not.toBeInTheDocument();

		await user.click(
			within(tablist()).getByRole("tab", { name: /case study/i }),
		);

		expect(
			screen.getByText(/open questions that constrain this type/i),
		).toBeInTheDocument();
		expect(
			screen.getAllByRole("listitem").map((li) => li.textContent),
		).toContain("how strongly the result may be stated");
	});

	it("splits the two restriction kinds the way the prompt does", async () => {
		// `buildCaseStudyLockedClauses` emits TWO blocks and its own comment
		// calls merging them "actively harmful". The approvals block says "NOT
		// approved for use … write around each one … or leave it out"; the
		// open-questions block says "these are unsettled — do not resolve them
		// by assumption, do not assert either side". For an open CLAIM_STRENGTH
		// or AUDIENCE_SCOPE question nothing is awaiting approval and the
		// generator does not generalize it away, so one merged list headed "a
		// draft will generalize rather than assert them" stated on the page
		// exactly the reading the prompt builder rejects — the
		// page-promises-one-thing / generator-does-another divergence
		// `publishing-restrictions.ts` exists to prevent.
		const user = userEvent.setup();
		renderTabs({
			decisionThreads: [
				thread({
					id: "t-customer",
					decisionKind: "CUSTOMER_NAME",
					subject: "the customer name",
				}),
				thread({
					id: "t-audience",
					decisionKind: "AUDIENCE_SCOPE",
					subject: "who the piece is for",
				}),
			],
		});

		await user.click(
			within(tablist()).getByRole("tab", { name: /case study/i }),
		);

		// Scoped to each section, so a build that rendered both subjects under
		// one heading cannot pass.
		const approvals = screen
			.getByText(/unresolved approvals/i)
			.closest("section") as HTMLElement;
		const questions = screen
			.getByText(/open questions that constrain this type/i)
			.closest("section") as HTMLElement;

		expect(
			within(approvals)
				.getAllByRole("listitem")
				.map((li) => li.textContent),
		).toEqual(["the customer name"]);
		expect(
			within(questions)
				.getAllByRole("listitem")
				.map((li) => li.textContent),
		).toEqual(["who the piece is for"]);

		// And each section says what its own locked clause says. "Write around
		// each one" is right for an unapproved customer name and wrong for an
		// audience question, which is the whole reason for the split.
		expect(approvals).toHaveTextContent(/write around each one/i);
		expect(questions).toHaveTextContent(/not resolve them by assumption/i);
		expect(questions).not.toHaveTextContent(/write around each one/i);
	});

	it("still shows a shared restriction on every tab, 2C included", async () => {
		// The other direction: `restrictsPostType` starts with the shared
		// predicate, so moving the computation must not have narrowed a
		// safety-critical question to one tab.
		const user = userEvent.setup();
		renderTabs({ decisionThreads: [thread()] });

		expect(screen.getByText("the customer name")).toBeInTheDocument();

		await user.click(
			within(tablist()).getByRole("tab", { name: /case study/i }),
		);
		expect(screen.getByText("the customer name")).toBeInTheDocument();
	});

	it("gives the two 2C types DIFFERENT restriction sets on the same thread", async () => {
		// The one case that can tell the two 2C extra sets apart.
		// `CODEBASE_DETAIL` restricts a Case Study — it describes the
		// implementation — and deliberately does NOT restrict a Stakeholder
		// Email, which is not where a codebase detail leaks and where a third
		// entry under "open questions" on every technical topic would train the
		// reader past the two that do apply.
		//
		// Without this, a build that computed the list ONCE per phase rather
		// than once per panel — the tempting shortcut when a second 2C type
		// arrives — would pass every other case in this file.
		const user = userEvent.setup();
		renderTabs({
			decisionThreads: [
				thread({
					id: "t-codebase",
					decisionKind: "CODEBASE_DETAIL",
					subject: "how much of the resolver to show",
					content: "How much implementation may we describe?",
				}),
				thread({
					id: "t-audience",
					decisionKind: "AUDIENCE_SCOPE",
					subject: "who this update is addressed to",
					content: "Internal or external?",
				}),
			],
		});

		await user.click(
			within(tablist()).getByRole("tab", { name: /case study/i }),
		);
		const onCaseStudy = screen
			.getAllByRole("listitem")
			.map((li) => li.textContent);
		expect(onCaseStudy).toContain("how much of the resolver to show");
		expect(onCaseStudy).toContain("who this update is addressed to");

		await user.click(
			within(tablist()).getByRole("tab", { name: /stakeholder email/i }),
		);
		const onEmail = screen
			.getAllByRole("listitem")
			.map((li) => li.textContent);
		expect(onEmail).toContain("who this update is addressed to");
		expect(onEmail).not.toContain("how much of the resolver to show");
	});

	it("still shows a shared restriction on the stakeholder email tab", async () => {
		// The other direction: `restrictsPostType` starts with the shared
		// predicate, so giving this type an extra set must not have narrowed a
		// safety-critical question away from it.
		const user = userEvent.setup();
		renderTabs({ decisionThreads: [thread()] });

		await user.click(
			within(tablist()).getByRole("tab", { name: /stakeholder email/i }),
		);
		expect(screen.getByText("the customer name")).toBeInTheDocument();
	});

	it("DOES offer a generate control on the case study tab", async () => {
		const user = userEvent.setup();
		renderTabs();

		await user.click(
			within(tablist()).getByRole("tab", { name: /case study/i }),
		);
		expect(
			screen.getByRole("button", { name: /generate case study/i }),
		).toBeInTheDocument();
	});

	it("DOES offer a generate control on the stakeholder email tab", async () => {
		// The positive half of activating the tab. `toBeEnabled()` above passes
		// just as well on a build where the panel failed to mount at all and the
		// tab opened onto nothing.
		const user = userEvent.setup();
		renderTabs();

		await user.click(
			within(tablist()).getByRole("tab", { name: /stakeholder email/i }),
		);
		expect(
			screen.getByRole("button", { name: /generate stakeholder email/i }),
		).toBeInTheDocument();
	});

	it("DOES offer a generate control on the blog post tab", async () => {
		// This case has now been inverted twice, and the history is the point.
		// 2B-1 asserted the absence of a generate control on BOTH live tabs,
		// which was right for a slice that shipped no generation. 2B-2 kept the
		// half that still held — blog. 2B-3 ships the blog generation FR11 asks
		// for, so the assertion flips: what would be a regression now is the
		// control being missing, not present.
		const user = userEvent.setup();
		renderTabs();

		await user.click(
			within(tablist()).getByRole("tab", { name: /blog post/i }),
		);
		expect(
			screen.getByRole("button", { name: /generate blog post/i }),
		).toBeInTheDocument();
		// And the 2B-1 placeholder it replaced is gone rather than merely
		// hidden behind it.
		expect(
			screen.queryByText(/arrives in the next release/i),
		).not.toBeInTheDocument();
	});

	it("DOES offer a generate control on the short post tab", async () => {
		// The positive half. Without it the case above passes just as well on a
		// build where the short post panel failed to mount at all.
		renderTabs();

		expect(
			screen.getByRole("button", { name: /generate short post/i }),
		).toBeInTheDocument();
	});

	it("hands a saved blog draft to the blog panel, which shows the body itself", async () => {
		// This case used to assert the GENERIC draft-state line ("you have a
		// saved draft for this content type"), retargeted from TWEET to
		// BLOG_POST in 2B-2 as each tab got a panel of its own. 2B-3 panelled
		// the last one, so that line has no remaining caller and the component
		// behind it was removed with this change.
		//
		// What is worth asserting HERE is the wiring rather than the panel's
		// own rendering: that this component routes the right working draft to
		// the right tab. The panel's behaviour is
		// `publishing-blog-post-panel.test.tsx`.
		const user = userEvent.setup();
		renderTabs({
			workingDrafts: [
				{
					postType: "BLOG_POST",
					hasBody: true,
					body: "A saved blog draft.",
					sourceDraftId: null,
					sourceOptionLabel: null,
					updatedAt: new Date(),
				},
			],
		});

		await user.click(
			within(tablist()).getByRole("tab", { name: /blog post/i }),
		);
		expect(
			screen.getByRole("textbox", { name: /working blog post/i }),
		).toHaveValue("A saved blog draft.");
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
