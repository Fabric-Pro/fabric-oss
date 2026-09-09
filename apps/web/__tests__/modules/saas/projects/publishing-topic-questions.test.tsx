/**
 * TopicQuestionsPanel — the Summary & Questions tab's questions and answer
 * controls (Publishing Suite Phase 2A-3, Fizzy #1851).
 *
 * The panel is driven entirely by `threads`, the topic's decision-thread rows
 * — not the planning analysis' own JSON blob, which is what 2A-2 read for
 * display (see `publishing-topic-item-page.test.tsx`'s FR39 block for the
 * page-level half of that move, and `publishing-planning-analysis-tab.test.tsx`
 * for the worksheet, which never rendered these). Mocks
 * `@tanstack/react-query` and `@shared/lib/orpc-query-utils`, mirroring
 * `publishing-planning-analysis-tab.test.tsx`: the mutation this panel owns
 * runs its real `onSuccess` so the invalidation path is exercised, and the
 * assertions read the args a caller of `answerTopicQuestion` receives, not an
 * opaque spy call count.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The panel owns TWO mutations now — answering an open question, and amending
// a settled one. They route to SEPARATE spies by `mutationKey` rather than
// sharing one: the point of the amend path is that it is NOT the answer path
// (`answerTopicQuestion` refuses a settled root on purpose), and a shared spy
// would let a regression that sent an amendment down the answer procedure pass
// every assertion below.
const { answerMutation, amendMutation, mutationState } = vi.hoisted(() => ({
	answerMutation: vi.fn(),
	amendMutation: vi.fn(),
	mutationState: {
		shouldFail: false,
		/** What the amend mutation resolves with — its `onSuccess` reads `status`. */
		result: { status: "amended" } as { status: string },
	},
}));

async function run(
	opts: {
		mutationKey?: unknown[];
		onSuccess?: (...a: unknown[]) => unknown;
		onError?: (...a: unknown[]) => unknown;
	},
	vars: unknown,
) {
	const spy =
		opts.mutationKey?.[0] === "amendTopicQuestion"
			? amendMutation
			: answerMutation;
	spy(vars);
	if (mutationState.shouldFail) {
		const err = new Error("failed");
		await opts.onError?.(err, vars, undefined);
		throw err;
	}
	await opts.onSuccess?.(mutationState.result, vars, undefined);
	return mutationState.result;
}

vi.mock("@tanstack/react-query", () => ({
	useMutation: (opts: {
		mutationKey?: unknown[];
		onSuccess?: (...a: unknown[]) => unknown;
		onError?: (...a: unknown[]) => unknown;
	}) => ({
		mutate: (vars: unknown) => {
			void run(opts, vars).catch(() => {});
		},
		// The amend path awaits its own outcome: a REFUSED amendment must leave
		// the editor open, because the draft in it is the only copy of what the
		// person typed. A mock that only offered `mutate` would let that
		// regression through by never resolving anything to decide on.
		mutateAsync: (vars: unknown) => run(opts, vars),
		isPending: false,
	}),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			publishingSuite: {
				answerTopicQuestion: {
					mutationOptions: (opts: Record<string, unknown>) => ({
						mutationKey: ["answerTopicQuestion"],
						...opts,
					}),
				},
				amendTopicQuestion: {
					mutationOptions: (opts: Record<string, unknown>) => ({
						mutationKey: ["amendTopicQuestion"],
						...opts,
					}),
				},
				listTopicDecisions: {
					queryKey: ({ input }: { input?: unknown }) => [
						"listTopicDecisions",
						input,
					],
				},
			},
		},
	},
}));

import { TopicQuestionsPanel } from "@saas/projects/components/publishing-suite/TopicQuestionsPanel";
import { toast } from "sonner";

const BASE = {
	projectId: "proj-1",
	topicId: "topic-1",
	organizationId: null as string | null,
	canEdit: true,
};

/** An OPEN root plus its (empty) replies, as `listTopicDecisions` returns it. */
function root(overrides: Record<string, unknown> = {}) {
	return {
		id: "decision-1",
		parentId: null,
		kind: "QUESTION",
		status: "OPEN",
		authorType: "AGENT",
		authorUserId: null,
		questionId: "q-customer-name",
		decisionKind: "CUSTOMER_NAME",
		subject: "the named customer",
		summary: "May we name the customer?",
		content: null,
		recommendedResponse: "Ask their marketing contact first.",
		whyItMatters: null,
		answerSource: null,
		analysisVersion: 1,
		createdAt: new Date("2026-08-30T10:00:00Z"),
		...overrides,
	};
}

const OPEN_THREAD = { root: root(), replies: [] };

const OPEN_THREAD_NO_RECOMMENDATION = {
	root: root({
		id: "decision-2",
		questionId: "q-no-rec",
		recommendedResponse: null,
	}),
	replies: [],
};

const RESOLVED_THREAD = {
	root: root({
		id: "decision-3",
		status: "RESOLVED",
		answerSource: "MANUAL",
	}),
	replies: [
		{
			id: "reply-1",
			parentId: "decision-3",
			kind: "QUESTION",
			status: "RESOLVED",
			authorType: "USER",
			authorUserId: "user-1",
			questionId: null,
			decisionKind: null,
			subject: null,
			summary: null,
			content: "Yes, marketing cleared it.",
			recommendedResponse: null,
			whyItMatters: null,
			answerSource: "MANUAL",
			analysisVersion: null,
			createdAt: new Date("2026-08-30T10:05:00Z"),
		},
	],
};

const POSSIBLY_RESOLVED_THREAD = {
	root: root({
		id: "decision-4",
		questionId: "q-possibly-resolved",
		status: "POSSIBLY_RESOLVED",
	}),
	replies: [],
};

beforeEach(() => {
	vi.clearAllMocks();
	mutationState.shouldFail = false;
	mutationState.result = { status: "amended" };
});

describe("TopicQuestionsPanel — the four states (DV14)", () => {
	it("shows a loading state while the thread is in flight", () => {
		render(<TopicQuestionsPanel {...BASE} isLoading threads={[]} />);
		expect(screen.getByTestId("topic-questions-loading")).toBeVisible();
	});

	it("shows an empty state when there are no questions", () => {
		render(<TopicQuestionsPanel {...BASE} threads={[]} />);
		expect(screen.getByText(/no open questions/i)).toBeVisible();
	});

	it("explains the failure rather than looking empty", () => {
		// An analysis that failed and one that raised nothing are different facts,
		// and an empty list that means "we could not ask" is the worse of the two
		// to render silently.
		render(<TopicQuestionsPanel {...BASE} threads={[]} analysisFailed />);
		expect(screen.getByText(/could not be generated/i)).toBeVisible();
	});

	it("renders an open question with its recommendation", () => {
		render(<TopicQuestionsPanel {...BASE} threads={[OPEN_THREAD]} />);
		expect(screen.getByText(/may we name the customer/i)).toBeVisible();
		expect(screen.getByText(/ask their marketing contact/i)).toBeVisible();
	});

	it("renders the question's rationale (whyItMatters)", () => {
		// Visible on master via the deleted `TopicOpenQuestions`; this pins it
		// against the same regression on this row-driven panel.
		render(
			<TopicQuestionsPanel
				{...BASE}
				threads={[
					{
						...OPEN_THREAD,
						root: {
							...OPEN_THREAD.root,
							whyItMatters:
								"A case study without the name is a different piece.",
						},
					},
				]}
			/>,
		);
		expect(
			screen.getByText(/a case study without the name/i),
		).toBeVisible();
	});

	it("never renders a blank section when only possibly-resolved questions exist", () => {
		// The blank-region bug: `open`/`resolved` are both empty, so without the
		// possibly-resolved group this `<section>` had nothing in it at all.
		render(
			<TopicQuestionsPanel
				{...BASE}
				threads={[POSSIBLY_RESOLVED_THREAD]}
			/>,
		);
		expect(screen.getByText(/possibly resolved/i)).toBeVisible();
	});
});

describe("TopicQuestionsPanel — a failing answer (DV14)", () => {
	it("toasts when the answer fails to save, rather than failing silently", async () => {
		mutationState.shouldFail = true;
		const user = userEvent.setup();
		render(<TopicQuestionsPanel {...BASE} threads={[OPEN_THREAD]} />);

		await user.click(
			screen.getByRole("button", { name: /use this answer/i }),
		);

		expect(toast.error).toHaveBeenCalled();
	});
});

describe("TopicQuestionsPanel — possibly-resolved questions (FR/IN4)", () => {
	it("answers a possibly-resolved question through the same controls as OPEN", async () => {
		const user = userEvent.setup();
		render(
			<TopicQuestionsPanel
				{...BASE}
				threads={[POSSIBLY_RESOLVED_THREAD]}
			/>,
		);

		// Collapsed by default — the toggle reveals the answer controls.
		expect(
			screen.queryByRole("button", { name: /use this answer/i }),
		).not.toBeInTheDocument();

		await user.click(
			screen.getByRole("button", { name: /possibly resolved/i }),
		);
		await user.click(
			screen.getByRole("button", { name: /use this answer/i }),
		);

		expect(answerMutation).toHaveBeenCalledWith(
			expect.objectContaining({
				questionId: "q-possibly-resolved",
				answerSource: "AI_SUGGESTED",
			}),
		);
	});
});

describe("TopicQuestionsPanel — answering (FR10/FR11)", () => {
	it("accepting the recommendation submits it as AI_SUGGESTED", async () => {
		const user = userEvent.setup();
		render(<TopicQuestionsPanel {...BASE} threads={[OPEN_THREAD]} />);

		await user.click(
			screen.getByRole("button", { name: /use this answer/i }),
		);

		expect(answerMutation).toHaveBeenCalledWith(
			expect.objectContaining({
				questionId: "q-customer-name",
				answer: "Ask their marketing contact first.",
				answerSource: "AI_SUGGESTED",
			}),
		);
	});

	it("editing the recommendation submits it as AI_EDITED", async () => {
		// The distinction is the point of the enum: "the AI was right" and "the AI
		// was nearly right" are different signals about the recommendation, and
		// collapsing an edit into MANUAL loses the fact that it was offered at all.
		const user = userEvent.setup();
		render(<TopicQuestionsPanel {...BASE} threads={[OPEN_THREAD]} />);

		await user.click(screen.getByRole("button", { name: /edit/i }));
		const field = screen.getByRole("textbox", { name: /your answer/i });
		await user.clear(field);
		await user.type(field, "Only the logo, not the name.");
		await user.click(screen.getByRole("button", { name: /submit/i }));

		expect(answerMutation).toHaveBeenCalledWith(
			expect.objectContaining({ answerSource: "AI_EDITED" }),
		);
	});

	it("opening the editor and saving the recommendation untouched is AI_SUGGESTED, not AI_EDITED", async () => {
		// The same act as "Use this answer", reached through the editor. Calling
		// it AI_EDITED would rebuild the misclassification
		// `20260828120000_repoint_ai_edited_answer_source` swept out of
		// `decision_log_entry` — AI_EDITED means the person changed the
		// suggestion, and this person did not. Both surfaces that write this
		// column have to agree, or "recommendation acceptance" stops being a
		// number anyone can read.
		const user = userEvent.setup();
		render(<TopicQuestionsPanel {...BASE} threads={[OPEN_THREAD]} />);

		await user.click(screen.getByRole("button", { name: /edit/i }));
		await user.click(screen.getByRole("button", { name: /submit/i }));

		expect(answerMutation).toHaveBeenCalledWith(
			expect.objectContaining({
				answer: "Ask their marketing contact first.",
				answerSource: "AI_SUGGESTED",
			}),
		);
	});

	it("a free-form answer to a question with no recommendation is MANUAL", async () => {
		const user = userEvent.setup();
		render(
			<TopicQuestionsPanel
				{...BASE}
				threads={[OPEN_THREAD_NO_RECOMMENDATION]}
			/>,
		);

		const field = screen.getByRole("textbox", { name: /your answer/i });
		await user.type(field, "Internal only.");
		await user.click(screen.getByRole("button", { name: /submit/i }));

		expect(answerMutation).toHaveBeenCalledWith(
			expect.objectContaining({ answerSource: "MANUAL" }),
		);
	});

	it("offers no answer controls to a read-only viewer (PR2)", () => {
		render(
			<TopicQuestionsPanel
				{...BASE}
				threads={[OPEN_THREAD]}
				canEdit={false}
			/>,
		);

		expect(screen.getByText(/may we name the customer/i)).toBeVisible();
		expect(
			screen.queryByRole("button", { name: /use this answer/i }),
		).not.toBeInTheDocument();
	});

	it("shows a resolved question with its answer instead of a form (FR13)", () => {
		render(<TopicQuestionsPanel {...BASE} threads={[RESOLVED_THREAD]} />);

		expect(screen.getByText(/yes, marketing cleared it/i)).toBeVisible();
		expect(
			screen.queryByRole("button", { name: /use this answer/i }),
		).not.toBeInTheDocument();
	});
});

/**
 * Content-type questions answer as a yes/no (A3, Fizzy #1851).
 *
 * "is it supposed to be like that? its simple setting, not question that we
 * want ai to ask us, it could be checkbox or setting" — typing prose to answer
 * "Should we produce a Blog Post for this topic?" is the complaint.
 *
 * These stay QUESTIONS rather than becoming a project setting, and the reason
 * is in the data: the wording is templated per type, but the rationale beneath
 * it is written about this topic. FR39 binds recommendations that need
 * confirmation and each of these is one, so what changes is the affordance, not
 * the decision model — the answer still reaches the Decision Log and still
 * survives the next regeneration.
 */
describe("TopicQuestionsPanel — content-type questions are a yes/no", () => {
	it("offers Yes and No instead of an open textarea", () => {
		render(
			<TopicQuestionsPanel
				{...BASE}
				threads={[
					{
						root: root({
							decisionKind: "CONTENT_TYPE",
							summary:
								"Should we produce a Blog Post for this topic?",
							recommendedResponse: null,
						}),
						replies: [],
					},
				]}
			/>,
		);

		expect(screen.getByRole("button", { name: "Yes" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "No" })).toBeInTheDocument();
		expect(
			screen.queryByRole("textbox", { name: /your answer/i }),
		).not.toBeInTheDocument();
	});

	it("records a Yes as MANUAL, not as accepting the AI's wording", async () => {
		// answerSource measures recommendation acceptance. A button that never
		// showed the recommendation must not count as accepting it — the same
		// reasoning behind the repoint_ai_edited_answer_source migration.
		const user = userEvent.setup();
		render(
			<TopicQuestionsPanel
				{...BASE}
				threads={[
					{
						root: root({
							decisionKind: "CONTENT_TYPE",
							summary:
								"Should we produce a Blog Post for this topic?",
							recommendedResponse:
								"Yes, the topic has enough substance.",
						}),
						replies: [],
					},
				]}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Yes" }));

		expect(answerMutation).toHaveBeenCalledWith(
			expect.objectContaining({ answerSource: "MANUAL" }),
		);
	});

	it("still allows a nuanced answer in your own words", async () => {
		// "yes, but only after the metric is approved" is a real answer a
		// boolean would throw away.
		const user = userEvent.setup();
		render(
			<TopicQuestionsPanel
				{...BASE}
				threads={[
					{
						root: root({
							decisionKind: "CONTENT_TYPE",
							summary:
								"Should we produce a Blog Post for this topic?",
							recommendedResponse: null,
						}),
						replies: [],
					},
				]}
			/>,
		);

		await user.click(
			screen.getByRole("button", { name: /answer in your own words/i }),
		);

		expect(
			screen.getByRole("textbox", { name: /your answer/i }),
		).toBeInTheDocument();
	});

	it("leaves an asset-approval question as free text", () => {
		// The distinction is in decisionKind: an ASSET_APPROVAL question names a
		// specific asset in this topic and rarely has a yes/no answer worth
		// recording on its own.
		render(
			<TopicQuestionsPanel
				{...BASE}
				threads={[
					{
						root: root({
							decisionKind: "ASSET_APPROVAL",
							summary:
								"Is the Metric callout approved for use in this content?",
							recommendedResponse: null,
						}),
						replies: [],
					},
				]}
			/>,
		);

		expect(
			screen.getByRole("textbox", { name: /your answer/i }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Yes" }),
		).not.toBeInTheDocument();
	});
});

/**
 * Amending a settled answer (Fizzy #1851, UI-review follow-up).
 *
 * A RESOLVED question used to render as read-only text with no way back, while
 * Feature Maturation's Decision Log has offered the same correction for a while
 * (`stories.maturation.amendAnswer`). The reviewer asked for parity.
 *
 * It is a SECOND procedure rather than a mode of `answerTopicQuestion`, and the
 * separate spies above are what pin that: the answer path's refusal to answer a
 * settled root is what stops a double-submit minting two replies for one act,
 * so making it answerable again would have fixed this at the cost of that.
 */
describe("TopicQuestionsPanel — amending a settled answer", () => {
	/** A thread whose answer has already been amended once. */
	const AMENDED_THREAD = {
		...RESOLVED_THREAD,
		replies: [
			RESOLVED_THREAD.replies[0],
			{
				...RESOLVED_THREAD.replies[0],
				id: "reply-2",
				content: "On reflection, no — legal has not signed off.",
				createdAt: new Date("2026-08-31T09:00:00Z"),
			},
		],
	};

	it("offers Amend on a resolved question", async () => {
		render(<TopicQuestionsPanel {...BASE} threads={[RESOLVED_THREAD]} />);

		expect(
			screen.getByRole("button", { name: /amend/i }),
		).toBeInTheDocument();
	});

	it("seeds the editor with the answer on record, not with the AI recommendation", async () => {
		// Load-bearing for `answerSource`. The seed decides what an amendment
		// IS: starting from the existing answer means nothing typed here is an
		// act of accepting the AI's wording, which is what lets the submission
		// below classify honestly as MANUAL.
		const user = userEvent.setup();
		render(<TopicQuestionsPanel {...BASE} threads={[RESOLVED_THREAD]} />);

		await user.click(screen.getByRole("button", { name: /amend/i }));

		expect(
			screen.getByRole("textbox", { name: /your answer/i }),
		).toHaveValue("Yes, marketing cleared it.");
	});

	it("sends the amendment to amendTopicQuestion, never to answerTopicQuestion", async () => {
		const user = userEvent.setup();
		render(<TopicQuestionsPanel {...BASE} threads={[RESOLVED_THREAD]} />);

		await user.click(screen.getByRole("button", { name: /amend/i }));
		const box = screen.getByRole("textbox", { name: /your answer/i });
		await user.clear(box);
		await user.type(box, "No, they withdrew it.");
		await user.click(screen.getByRole("button", { name: /save answer/i }));

		expect(amendMutation).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				topicId: "topic-1",
				questionId: "q-customer-name",
				supersedesId: "reply-1",
				answer: "No, they withdrew it.",
			}),
		);
		expect(answerMutation).not.toHaveBeenCalled();
	});

	it("classifies an amendment as MANUAL, because nothing here accepts a recommendation", async () => {
		// `answerSource` measures recommendation ACCEPTANCE — the reason
		// `20260828120000_repoint_ai_edited_answer_source` exists. The editor is
		// seeded from the answer, so AI_EDITED would overstate what happened
		// even when the previous answer came from the AI.
		const user = userEvent.setup();
		render(<TopicQuestionsPanel {...BASE} threads={[RESOLVED_THREAD]} />);

		await user.click(screen.getByRole("button", { name: /amend/i }));
		const box = screen.getByRole("textbox", { name: /your answer/i });
		await user.clear(box);
		await user.type(box, "Different wording.");
		await user.click(screen.getByRole("button", { name: /save answer/i }));

		expect(amendMutation).toHaveBeenCalledWith(
			expect.objectContaining({ answerSource: "MANUAL" }),
		);
	});

	it("supersedes the LATEST answer, not the first one", async () => {
		// A thread amended twice has several answering replies. Sending the
		// first reply's id would be refused as stale by the server — correctly,
		// since it names text the author is no longer looking at.
		const user = userEvent.setup();
		render(<TopicQuestionsPanel {...BASE} threads={[AMENDED_THREAD]} />);

		expect(
			screen.getByText(/on reflection, no — legal has not signed off/i),
		).toBeVisible();

		await user.click(screen.getByRole("button", { name: /amend/i }));
		const box = screen.getByRole("textbox", { name: /your answer/i });
		await user.clear(box);
		await user.type(box, "Third time.");
		await user.click(screen.getByRole("button", { name: /save answer/i }));

		expect(amendMutation).toHaveBeenCalledWith(
			expect.objectContaining({ supersedesId: "reply-2" }),
		);
	});

	it("warns when a colleague amended first, rather than reporting success", async () => {
		mutationState.result = { status: "stale" };
		const user = userEvent.setup();
		render(<TopicQuestionsPanel {...BASE} threads={[RESOLVED_THREAD]} />);

		await user.click(screen.getByRole("button", { name: /amend/i }));
		const box = screen.getByRole("textbox", { name: /your answer/i });
		await user.clear(box);
		await user.type(box, "Mine.");
		await user.click(screen.getByRole("button", { name: /save answer/i }));

		expect(toast.warning).toHaveBeenCalled();
	});

	it("KEEPS the refused draft on screen, because it is the only copy of it", async () => {
		// The editor closes on SUCCESS, never on submit. A `stale` amendment
		// was not recorded anywhere, so closing on click would destroy the
		// words the person typed while the toast told them nothing was saved.
		mutationState.result = { status: "stale" };
		const user = userEvent.setup();
		render(<TopicQuestionsPanel {...BASE} threads={[RESOLVED_THREAD]} />);

		await user.click(screen.getByRole("button", { name: /amend/i }));
		const box = screen.getByRole("textbox", { name: /your answer/i });
		await user.clear(box);
		await user.type(box, "The wording I want to keep.");
		await user.click(screen.getByRole("button", { name: /save answer/i }));

		expect(
			screen.getByRole("textbox", { name: /your answer/i }),
		).toHaveValue("The wording I want to keep.");
	});

	it("keeps the draft when the request itself fails", async () => {
		mutationState.shouldFail = true;
		const user = userEvent.setup();
		render(<TopicQuestionsPanel {...BASE} threads={[RESOLVED_THREAD]} />);

		await user.click(screen.getByRole("button", { name: /amend/i }));
		const box = screen.getByRole("textbox", { name: /your answer/i });
		await user.clear(box);
		await user.type(box, "Survives a dropped connection.");
		await user.click(screen.getByRole("button", { name: /save answer/i }));

		expect(
			screen.getByRole("textbox", { name: /your answer/i }),
		).toHaveValue("Survives a dropped connection.");
	});

	it("closes the editor once the amendment lands", async () => {
		const user = userEvent.setup();
		render(<TopicQuestionsPanel {...BASE} threads={[RESOLVED_THREAD]} />);

		await user.click(screen.getByRole("button", { name: /amend/i }));
		const box = screen.getByRole("textbox", { name: /your answer/i });
		await user.clear(box);
		await user.type(box, "Recorded.");
		await user.click(screen.getByRole("button", { name: /save answer/i }));

		expect(
			screen.queryByRole("textbox", { name: /your answer/i }),
		).not.toBeInTheDocument();
	});

	it("closes on a deduped no-op too — nothing was refused, there was nothing to change", async () => {
		mutationState.result = { status: "deduped" };
		const user = userEvent.setup();
		render(<TopicQuestionsPanel {...BASE} threads={[RESOLVED_THREAD]} />);

		await user.click(screen.getByRole("button", { name: /amend/i }));
		await user.click(screen.getByRole("button", { name: /save answer/i }));

		expect(
			screen.queryByRole("textbox", { name: /your answer/i }),
		).not.toBeInTheDocument();
		expect(toast.warning).not.toHaveBeenCalled();
	});

	it("says nothing extra on an ordinary amendment", async () => {
		const user = userEvent.setup();
		render(<TopicQuestionsPanel {...BASE} threads={[RESOLVED_THREAD]} />);

		await user.click(screen.getByRole("button", { name: /amend/i }));
		const box = screen.getByRole("textbox", { name: /your answer/i });
		await user.clear(box);
		await user.type(box, "Mine.");
		await user.click(screen.getByRole("button", { name: /save answer/i }));

		expect(toast.warning).not.toHaveBeenCalled();
	});

	it("reports a failed amendment instead of leaving the editor closed in silence", async () => {
		mutationState.shouldFail = true;
		const user = userEvent.setup();
		render(<TopicQuestionsPanel {...BASE} threads={[RESOLVED_THREAD]} />);

		await user.click(screen.getByRole("button", { name: /amend/i }));
		const box = screen.getByRole("textbox", { name: /your answer/i });
		await user.clear(box);
		await user.type(box, "Mine.");
		await user.click(screen.getByRole("button", { name: /save answer/i }));

		expect(toast.error).toHaveBeenCalled();
	});

	it("abandons the edit on Cancel without sending anything", async () => {
		const user = userEvent.setup();
		render(<TopicQuestionsPanel {...BASE} threads={[RESOLVED_THREAD]} />);

		await user.click(screen.getByRole("button", { name: /amend/i }));
		await user.click(screen.getByRole("button", { name: /cancel/i }));

		expect(amendMutation).not.toHaveBeenCalled();
		expect(screen.getByText(/yes, marketing cleared it/i)).toBeVisible();
	});

	it("gives a read-only member no way to amend", async () => {
		render(
			<TopicQuestionsPanel
				{...BASE}
				threads={[RESOLVED_THREAD]}
				canEdit={false}
			/>,
		);

		expect(screen.getByText(/yes, marketing cleared it/i)).toBeVisible();
		expect(
			screen.queryByRole("button", { name: /amend/i }),
		).not.toBeInTheDocument();
	});

	it("offers nothing to amend on a settled question with no answer recorded", async () => {
		// Nothing writes this today, but the server refuses it as `stale`
		// rather than inventing a first answer, so the button must not be there
		// to send it.
		render(
			<TopicQuestionsPanel
				{...BASE}
				threads={[{ ...RESOLVED_THREAD, replies: [] }]}
			/>,
		);

		expect(
			screen.queryByRole("button", { name: /amend/i }),
		).not.toBeInTheDocument();
	});
});
