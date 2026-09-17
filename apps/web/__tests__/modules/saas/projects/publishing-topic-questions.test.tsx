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

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The panel owns TWO mutations now — answering an open question, and amending
// a settled one. They route to SEPARATE spies by `mutationKey` rather than
// sharing one: the point of the amend path is that it is NOT the answer path
// (`answerTopicQuestion` refuses a settled root on purpose), and a shared spy
// would let a regression that sent an amendment down the answer procedure pass
// every assertion below.
const {
	answerMutation,
	amendMutation,
	assignMutation,
	restoreMutate,
	invalidateQueries,
	mutationState,
} = vi.hoisted(() => ({
	answerMutation: vi.fn(),
	amendMutation: vi.fn(),
	/**
	 * Restoring, and its OWN spy for the same reason assignment has one:
	 * putting a question back on the open list must never reach a write
	 * that answers it.
	 */
	restoreMutate: vi.fn(),
	/**
	 * Routing, and its OWN spy. Assignment must never reach either write above:
	 * asking somebody is not settling the question, and a shared spy would let
	 * a regression that answered on the caller's behalf pass every assertion.
	 */
	assignMutation: vi.fn(),
	/** ONE spy for every `useQueryClient()` call, so a refetch is observable. */
	invalidateQueries: vi.fn(),
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
	const key = opts.mutationKey?.[0];
	const spy =
		key === "amendTopicQuestion"
			? amendMutation
			: key === "setQuestionAssignees"
				? assignMutation
				: key === "restoreQuestion"
					? restoreMutate
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
	useQueryClient: () => ({ invalidateQueries }),
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
				restoreQuestion: {
					mutationOptions: (opts: Record<string, unknown>) => ({
						mutationKey: ["restoreQuestion"],
						...opts,
					}),
				},
				setQuestionAssignees: {
					mutationOptions: (opts: Record<string, unknown>) => ({
						mutationKey: ["setQuestionAssignees"],
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

/**
 * The Answered group is collapsed by default, so a case that reaches for a
 * settled question — or its Amend control — opens it first.
 */
const openAnswered = () =>
	userEvent.click(screen.getByRole("button", { name: /^answered/i }));

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
		// Always an array, never absent: the procedure's output schema defaults
		// it, so a fixture that omitted it would be testing a payload the
		// server cannot send.
		assignees: [] as { assigneeUserId: string; assignedByUserId: string }[],
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

afterEach(() => {
	window.location.hash = "";
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

	it("says a run is under way rather than that there is nothing to ask", () => {
		// An empty list DURING a run means "not yet" — the questions land with
		// the analysis. The flat empty line told the reader the opposite while
		// their own regeneration was still writing.
		render(
			<TopicQuestionsPanel {...BASE} threads={[]} isGeneratingAnalysis />,
		);

		expect(
			screen.getByText(/generating the planning analysis/i),
		).toBeVisible();
		expect(
			screen.getByTestId("topic-questions-generating"),
		).toHaveAttribute("aria-busy", "true");
		expect(screen.queryByText(/no open questions yet/i)).toBeNull();
	});

	it("keeps the failure explanation even if a stale GENERATING row is passed", () => {
		// One `latestAttempt` row cannot be both, but the failure is the fact
		// worth telling and must not be swallowed by a waiting state.
		render(
			<TopicQuestionsPanel
				{...BASE}
				threads={[]}
				isGeneratingAnalysis
				analysisFailed
			/>,
		);

		expect(screen.getByText(/could not be generated/i)).toBeVisible();
	});

	it("shows an all-clear instead of dead space once every question is answered", () => {
		// `open` is empty but `questions` is not, so the open-questions section
		// rendered `null` — a blank strip under the readiness bar, which reads
		// as a section that failed to load rather than one with nothing left.
		render(<TopicQuestionsPanel {...BASE} threads={[RESOLVED_THREAD]} />);

		expect(screen.getByText(/no open questions right now/i)).toBeVisible();
	});

	it("shows no all-clear while a question is still open", () => {
		render(<TopicQuestionsPanel {...BASE} threads={[OPEN_THREAD]} />);
		expect(screen.queryByText(/no open questions right now/i)).toBeNull();
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
	it("asks a named colleague instead of answering for them", async () => {
		// Typing an answer and typing a question to a colleague are the same
		// box; which one it was is decided by whether a name is in it. "Ask"
		// routes the question and leaves it OPEN, so "@ana can you check this?"
		// is never recorded as the decision -- and the sentence rides along, so
		// the recipient arrives at something other than a bare assignment.
		const user = userEvent.setup();
		render(
			<TopicQuestionsPanel
				{...BASE}
				members={[
					{
						userId: "u-ana",
						user: {
							id: "u-ana",
							name: "Ana",
							email: "ana@example.com",
							image: null,
						},
					},
				]}
				threads={[
					{ root: root({ recommendedResponse: null }), replies: [] },
				]}
			/>,
		);

		await userEvent.type(
			screen.getByRole("textbox", { name: /your answer/i }),
			"@Ana can you confirm this?",
		);
		await user.click(screen.getByRole("button", { name: /^ask$/i }));

		expect(assignMutation).toHaveBeenCalledWith(
			expect.objectContaining({
				assigneeUserIds: expect.arrayContaining(["u-ana"]),
				note: "@Ana can you confirm this?",
			}),
		);
		// Routed, never answered.
		expect(answerMutation).not.toHaveBeenCalled();
	});

	it("groups open questions by what they are about", () => {
		// `decisionKind` has been stored on every root since the column was
		// added, and its doc-comment says grouping was the point -- it is kept
		// on the row rather than re-read from the analysis so a question
		// answered against version 1 still renders its own grouping after
		// version 2 supersedes that analysis. Eleven readers, none of them
		// grouping, until now.
		render(
			<TopicQuestionsPanel
				{...BASE}
				threads={[
					{
						root: root({ id: "a", decisionKind: "ASSET_APPROVAL" }),
						replies: [],
					},
					{
						root: root({ id: "b", decisionKind: "ASSET_APPROVAL" }),
						replies: [],
					},
					{
						root: root({ id: "c", decisionKind: "AUTHORSHIP" }),
						replies: [],
					},
				]}
			/>,
		);

		expect(screen.getByText("Asset approval")).toBeInTheDocument();
		expect(screen.getByText("Authorship")).toBeInTheDocument();
	});

	it("does not group when grouping would only add headings", () => {
		// One group is not a grouping, and one question per group is five
		// headings and no grouping either. A group earns its heading by
		// holding more than one.
		render(
			<TopicQuestionsPanel
				{...BASE}
				threads={[
					{
						root: root({ id: "a", decisionKind: "ASSET_APPROVAL" }),
						replies: [],
					},
					{
						root: root({ id: "c", decisionKind: "AUTHORSHIP" }),
						replies: [],
					},
				]}
			/>,
		);

		expect(screen.queryByText("Asset approval")).not.toBeInTheDocument();
		expect(screen.queryByText("Authorship")).not.toBeInTheDocument();
	});

	it("puts a soft-closed question back on the open list", async () => {
		// The panel already said these "can still be answered" and offered no
		// way to put one back where the work happens: once a regeneration set a
		// root aside, only another regeneration raising it again could undo
		// that. `SummaryQuestionsPanel` has had this lever since #5.
		const user = userEvent.setup();
		render(
			<TopicQuestionsPanel
				{...BASE}
				threads={[POSSIBLY_RESOLVED_THREAD]}
			/>,
		);

		await user.click(
			screen.getByRole("button", { name: /possibly resolved/i }),
		);
		await user.click(
			screen.getByRole("button", { name: /restore to open questions/i }),
		);

		expect(restoreMutate).toHaveBeenCalledWith(
			expect.objectContaining({
				questionRootId: POSSIBLY_RESOLVED_THREAD.root.id,
			}),
		);
	});

	it("offers no restore on an OPEN question, which has nothing to restore", () => {
		render(<TopicQuestionsPanel {...BASE} threads={[OPEN_THREAD]} />);

		expect(
			screen.queryByRole("button", {
				name: /restore to open questions/i,
			}),
		).not.toBeInTheDocument();
	});

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

	it("shows a resolved question with its answer instead of a form (FR13)", async () => {
		render(<TopicQuestionsPanel {...BASE} threads={[RESOLVED_THREAD]} />);
		await openAnswered();

		expect(screen.getByText(/yes, marketing cleared it/i)).toBeVisible();
		expect(
			screen.queryByRole("button", { name: /use this answer/i }),
		).not.toBeInTheDocument();
	});
});

/**
 * Whether the editor shows is DERIVED, not decided once at mount.
 *
 * The card is keyed by `thread.root.id`, which a refetch of the SAME root
 * does not change — so a one-time `useState(() => !hasRecommendation)`
 * locked in "starts open" or "starts collapsed" for the whole mount. That
 * broke two ways on the exact same state: options arriving on a later
 * refresh of an OPEN root (the upgrade path this feature's own changeset
 * describes) stayed hidden behind an editor nobody opened, and "Ask" on a
 * question with nothing to accept fell through to a branch that rendered an
 * empty "Suggested: " line beside a "Use this answer" button that would have
 * submitted nothing.
 */
describe("TopicQuestionsPanel — the editor after a refetch of the same root", () => {
	const REFRESHED_OPTIONS = [
		{
			text: "Approved — the draft may use the customer logo.",
			justification:
				"The draft can state it plainly instead of writing around it.",
		},
		{
			text: "Not approved — leave the customer logo out.",
			justification:
				"The draft will generalize it, use a neutral placeholder, or omit it rather than assert it.",
		},
	];

	/**
	 * The SAME root id as `OPEN_THREAD_NO_RECOMMENDATION`, now carrying
	 * options — exactly what a regenerated analysis refreshing an OPEN root
	 * produces, and exactly what the card's key does NOT change for.
	 */
	const withOptionsAddedLater = () => ({
		root: root({
			id: OPEN_THREAD_NO_RECOMMENDATION.root.id,
			questionId: OPEN_THREAD_NO_RECOMMENDATION.root.questionId,
			recommendedResponse: null,
			answerOptions: REFRESHED_OPTIONS,
		}),
		replies: [],
	});

	it("collapses an editor nobody opened once options arrive on the same root", () => {
		const { rerender } = render(
			<TopicQuestionsPanel
				{...BASE}
				threads={[OPEN_THREAD_NO_RECOMMENDATION]}
			/>,
		);

		expect(
			screen.getByRole("textbox", { name: /your answer/i }),
		).toBeInTheDocument();

		rerender(
			<TopicQuestionsPanel
				{...BASE}
				threads={[withOptionsAddedLater()]}
			/>,
		);

		expect(
			screen.getByText("Approved — the draft may use the customer logo."),
		).toBeInTheDocument();
		expect(
			screen.getByText("Not approved — leave the customer logo out."),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", {
				name: /edit "approved — the draft may use the customer logo\."/i,
			}),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("textbox", { name: /your answer/i }),
		).not.toBeInTheDocument();
	});

	it("keeps a draft in progress even after options arrive on the same root", async () => {
		// Pins that a person's draft text is still there once options arrive
		// on the same root, whatever else keeps the editor open.
		const user = userEvent.setup();
		const { rerender } = render(
			<TopicQuestionsPanel
				{...BASE}
				threads={[OPEN_THREAD_NO_RECOMMENDATION]}
			/>,
		);

		await user.type(
			screen.getByRole("textbox", { name: /your answer/i }),
			"Still checking with legal.",
		);

		rerender(
			<TopicQuestionsPanel
				{...BASE}
				threads={[withOptionsAddedLater()]}
			/>,
		);

		expect(
			screen.getByRole("textbox", { name: /your answer/i }),
		).toHaveValue("Still checking with legal.");
	});

	it("keeps the editor open once a typed draft is cleared, after options have arrived", async () => {
		// Clearing a draft back to empty is not the same as never having
		// opened the editor: typing already opened it, so the field, the
		// mention picker and Submit/Cancel/Ask must not vanish out from under
		// an empty textarea the person is still looking at, replaced by the
		// options view with no action from them.
		const user = userEvent.setup();
		const { rerender } = render(
			<TopicQuestionsPanel
				{...BASE}
				threads={[OPEN_THREAD_NO_RECOMMENDATION]}
			/>,
		);

		await user.type(
			screen.getByRole("textbox", { name: /your answer/i }),
			"Still checking.",
		);

		rerender(
			<TopicQuestionsPanel
				{...BASE}
				threads={[withOptionsAddedLater()]}
			/>,
		);

		await user.clear(screen.getByRole("textbox", { name: /your answer/i }));

		expect(
			screen.getByRole("textbox", { name: /your answer/i }),
		).toHaveValue("");
		expect(
			screen.queryByRole("button", {
				name: /approved — the draft may use the customer logo/i,
			}),
		).not.toBeInTheDocument();
	});

	it("keeps the editor open after Ask, on a question with nothing to accept", async () => {
		// The pre-existing half of the same bug: `cancelEdit` used to set the
		// stored flag `false`, and false with no recommendation and no options
		// fell through to the recommendation branch instead of staying on the
		// only affordance the question has.
		const user = userEvent.setup();
		render(
			<TopicQuestionsPanel
				{...BASE}
				members={[
					{
						userId: "u-ana",
						user: {
							id: "u-ana",
							name: "Ana",
							email: "ana@example.com",
							image: null,
						},
					},
				]}
				threads={[OPEN_THREAD_NO_RECOMMENDATION]}
			/>,
		);

		await userEvent.type(
			screen.getByRole("textbox", { name: /your answer/i }),
			"@Ana can you confirm this?",
		);
		await user.click(screen.getByRole("button", { name: /^ask$/i }));

		expect(
			screen.getByRole("textbox", { name: /your answer/i }),
		).toBeInTheDocument();
		expect(screen.queryByText(/^suggested:\s*$/i)).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /use this answer/i }),
		).not.toBeInTheDocument();
	});
});

/**
 * Content types are a SETTING, not a question.
 *
 * This replaces a block asserting they answer with Yes/No buttons. That was the
 * right shape while they were still questions — but the card owner's point was
 * that they should not be questions at all ("its simple setting, not question,
 * it could be checkbox"), and they are now the content-types checklist above
 * this panel, where the analysis's rationale sits on the choice.
 *
 * The generator no longer mints them. Topics created before that still carry
 * them, so the panel filters them out too — otherwise the checklist and a
 * question directly beneath it would ask for the same decision, in the exact
 * wording that was objected to.
 */
describe("TopicQuestionsPanel — content types are not questions", () => {
	it("hides a content-type question a topic still carries", () => {
		render(
			<TopicQuestionsPanel
				{...BASE}
				threads={[
					{
						root: root({
							decisionKind: "CONTENT_TYPE",
							summary:
								"Should we produce a LinkedIn Post for this topic?",
						}),
						replies: [],
					},
				]}
			/>,
		);

		expect(
			screen.queryByText(/should we produce a linkedin post/i),
		).not.toBeInTheDocument();
	});

	it("leaves every other kind of question alone", () => {
		// The filter is keyed on the KIND, not on the wording — an asset
		// approval reads similarly and must survive.
		render(
			<TopicQuestionsPanel
				{...BASE}
				threads={[
					{
						root: root({
							decisionKind: "ASSET_APPROVAL",
							summary: "Is the screenshot approved for use?",
						}),
						replies: [],
					},
				]}
			/>,
		);

		expect(
			screen.getByText(/is the screenshot approved for use/i),
		).toBeInTheDocument();
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
describe("TopicQuestionsPanel — the Answered group", () => {
	it("keeps answered questions collapsed behind a count", () => {
		// The worklist is what anyone comes to this tab to work, and a topic
		// only ever accumulates answers. Collapsed, the open list stays at the
		// top of the tab however many questions have been settled.
		render(
			<TopicQuestionsPanel
				{...BASE}
				threads={[OPEN_THREAD, RESOLVED_THREAD]}
			/>,
		);

		const toggle = screen.getByRole("button", { name: /^answered/i });
		expect(toggle).toHaveAttribute("aria-expanded", "false");
		expect(
			screen.queryByText(/yes, marketing cleared it/i),
		).not.toBeInTheDocument();
	});

	it("opens on request and closes again", async () => {
		render(<TopicQuestionsPanel {...BASE} threads={[RESOLVED_THREAD]} />);

		await openAnswered();
		expect(screen.getByText(/yes, marketing cleared it/i)).toBeVisible();

		await openAnswered();
		expect(
			screen.queryByText(/yes, marketing cleared it/i),
		).not.toBeInTheDocument();
	});
});

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
		await openAnswered();

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
		await openAnswered();

		await user.click(screen.getByRole("button", { name: /amend/i }));

		expect(
			screen.getByRole("textbox", { name: /your answer/i }),
		).toHaveValue("Yes, marketing cleared it.");
	});

	it("sends the amendment to amendTopicQuestion, never to answerTopicQuestion", async () => {
		const user = userEvent.setup();
		render(<TopicQuestionsPanel {...BASE} threads={[RESOLVED_THREAD]} />);
		await openAnswered();

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
		await openAnswered();

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
		await openAnswered();

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
		await openAnswered();

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
		await openAnswered();

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
		await openAnswered();

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
		await openAnswered();

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
		await openAnswered();

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
		await openAnswered();

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
		await openAnswered();

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
		await openAnswered();

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
		await openAnswered();

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
		await openAnswered();

		expect(
			screen.queryByRole("button", { name: /amend/i }),
		).not.toBeInTheDocument();
	});
});

/**
 * Several suggested answers, as Feature Maturation offers (#24).
 *
 * The card owner asked for parity: "for AI suggested answers lets follow the
 * same logic as in fmv2, card (or couple cards if couple possible answers)".
 * Each option is a real choice with the reasoning that supports it — with
 * several on screen the reasoning is the only thing separating them.
 *
 * `recommendedResponse` is untouched and still the fallback, so every question
 * minted before this reads exactly as it did.
 */
describe("TopicQuestionsPanel — several suggested answers", () => {
	const OPTIONS = [
		{
			text: "Out of scope for this release",
			justification: "The evidence names no customer commitment.",
		},
		{
			text: "In scope, if it fits the estimate",
			justification: "Groundwork already exists in the linked PR.",
		},
	];

	const withOptions = () => ({
		root: root({ answerOptions: OPTIONS, recommendedResponse: null }),
		replies: [],
	});

	it("shows every option with its reasoning", () => {
		render(<TopicQuestionsPanel {...BASE} threads={[withOptions()]} />);

		expect(
			screen.getByText("Out of scope for this release"),
		).toBeInTheDocument();
		expect(
			screen.getByText("The evidence names no customer commitment."),
		).toBeInTheDocument();
		expect(
			screen.getByText("In scope, if it fits the estimate"),
		).toBeInTheDocument();
	});

	it("records picking one as accepting the AI's wording", async () => {
		const user = userEvent.setup();
		render(<TopicQuestionsPanel {...BASE} threads={[withOptions()]} />);

		await user.click(screen.getByText("Out of scope for this release"));

		expect(answerMutation).toHaveBeenCalledWith(
			expect.objectContaining({
				answer: "Out of scope for this release",
				answerSource: "AI_SUGGESTED",
			}),
		);
	});

	it("opening an option in the editor and submitting it UNCHANGED is AI_SUGGESTED, not AI_EDITED", async () => {
		// The old rule compared the typed text against `root.recommendedResponse`
		// — `null` on a derived approval question, which is exactly what every
		// one of these fixtures is — so an untouched option edit always failed
		// that comparison: an option opened in the editor and submitted
		// unchanged was recorded as AI_EDITED instead of AI_SUGGESTED.
		const user = userEvent.setup();
		render(<TopicQuestionsPanel {...BASE} threads={[withOptions()]} />);

		await user.click(
			screen.getByRole("button", {
				name: /edit "out of scope for this release"/i,
			}),
		);
		await user.click(screen.getByRole("button", { name: /^submit$/i }));

		expect(answerMutation).toHaveBeenCalledWith(
			expect.objectContaining({
				answer: "Out of scope for this release",
				answerSource: "AI_SUGGESTED",
			}),
		);
	});

	it("records editing one as AI_EDITED, not MANUAL", async () => {
		// Starting from the AI's wording is a different fact about acceptance
		// from having typed your own, and the metric measures that difference.
		const user = userEvent.setup();
		render(<TopicQuestionsPanel {...BASE} threads={[withOptions()]} />);

		await user.click(
			screen.getByRole("button", {
				name: /edit "out of scope for this release"/i,
			}),
		);
		await user.type(screen.getByRole("textbox"), " — revisit in Q4");
		await user.click(screen.getByRole("button", { name: /^submit$/i }));

		expect(answerMutation).toHaveBeenCalledWith(
			expect.objectContaining({ answerSource: "AI_EDITED" }),
		);
	});

	it("still offers a free-form answer beside them", () => {
		render(<TopicQuestionsPanel {...BASE} threads={[withOptions()]} />);

		expect(
			screen.getByRole("button", { name: /type your own/i }),
		).toBeInTheDocument();
	});

	it("falls back to the single recommendation for an older question", () => {
		// Nothing was backfilled. A row minted before this carries no options
		// and must read exactly as it always did.
		render(<TopicQuestionsPanel {...BASE} threads={[OPEN_THREAD]} />);

		expect(screen.getByText(/suggested:/i)).toBeInTheDocument();
	});

	it("shows a read-only viewer the options, instead of an empty 'Suggested:' line", () => {
		// The read-only branch used to render `Suggested: {recommendedResponse}`
		// whenever `hasRecommendation` was true — which options alone also
		// satisfy. A derived approval question has `recommendedResponse: null`,
		// so a read-only viewer saw a bare "Suggested:" line and no option text
		// at all.
		render(
			<TopicQuestionsPanel
				{...BASE}
				canEdit={false}
				threads={[withOptions()]}
			/>,
		);

		expect(
			screen.getByText("Out of scope for this release"),
		).toBeInTheDocument();
		expect(
			screen.getByText("In scope, if it fits the estimate"),
		).toBeInTheDocument();
		// No bare "Suggested:" / "Suggested: " text — the empty-recommendation
		// artifact the bug produced. "Suggested answers" (the options heading)
		// does not match: it has no colon.
		expect(screen.queryByText(/^suggested:\s*$/i)).not.toBeInTheDocument();
		// No button named after an option — a read-only viewer gets plain text,
		// never the clickable choice or its pencil.
		expect(
			screen.queryByRole("button", {
				name: /out of scope for this release/i,
			}),
		).not.toBeInTheDocument();
	});

	it("still shows 'Suggested: <text>' to a read-only viewer when there are no options", () => {
		// The single-recommendation fallback must keep working for a read-only
		// viewer once the options branch is checked first.
		render(
			<TopicQuestionsPanel
				{...BASE}
				canEdit={false}
				threads={[OPEN_THREAD]}
			/>,
		);

		expect(
			screen.getByText(/suggested: ask their marketing contact first/i),
		).toBeInTheDocument();
	});

	it("renders the read-only options as a list", () => {
		// `SummaryQuestionsPanel.tsx` renders its suggested options as
		// `<ul><li>`; the read-only branch here rendered each as a bare `<div>`
		// with no list semantics at all.
		const thread = withOptions();
		render(
			<TopicQuestionsPanel
				{...BASE}
				canEdit={false}
				threads={[thread]}
			/>,
		);

		// Scoped to the card: the panel's own OPEN-questions group is itself a
		// `<ul>`, so an unscoped `getByRole("list")` would match more than one.
		const card = screen.getByTestId(`question-${thread.root.id}`);
		const items = within(card).getAllByRole("listitem");

		expect(items).toHaveLength(2);
		expect(items[0]).toHaveTextContent("Out of scope for this release");
		expect(items[1]).toHaveTextContent("In scope, if it fits the estimate");
	});
});

/**
 * Per-question assignment (Fizzy #1851) — who a question is waiting on.
 *
 * Mirrors Feature Maturation's routing, and reuses its picker, so what is
 * pinned here is the WIRING rather than the picker's own behaviour (that has
 * its own suite): that the panel sends the COMPLETE set on every change, that
 * it never answers anything on the way, and that a reader can see who is on a
 * question without being able to change it.
 *
 * The global next-intl mock echoes keys, so the picker's control is addressed
 * by its key (`assignLabel` / `assigneesLabel`) rather than by English copy.
 */
describe("TopicQuestionsPanel — per-question assignment", () => {
	const MEMBERS = [
		{
			userId: "u1",
			user: {
				id: "u1",
				name: "Sam R.",
				email: "sam@example.com",
				image: null,
			},
		},
		{
			userId: "u2",
			user: {
				id: "u2",
				name: "Wren P.",
				email: "wren@example.com",
				image: null,
			},
		},
	] as never;

	it("sends the COMPLETE desired set, not just the person clicked", async () => {
		const user = userEvent.setup();
		render(
			<TopicQuestionsPanel
				{...BASE}
				members={MEMBERS}
				threads={[
					{
						root: root({
							assignees: [
								{
									assigneeUserId: "u1",
									assignedByUserId: "asker",
								},
							],
						}),
						replies: [],
					},
				]}
			/>,
		);

		await user.click(
			screen.getByRole("button", { name: "assigneesLabel" }),
		);
		await user.click(await screen.findByText("Wren P."));

		// Set semantics: the server replaces the list with exactly what arrives,
		// so sending only the toggled id would silently unassign everyone else.
		expect(assignMutation).toHaveBeenCalledWith(
			expect.objectContaining({
				questionRootId: "decision-1",
				assigneeUserIds: ["u1", "u2"],
			}),
		);
	});

	it("removes somebody by sending the list without them", async () => {
		const user = userEvent.setup();
		render(
			<TopicQuestionsPanel
				{...BASE}
				members={MEMBERS}
				threads={[
					{
						root: root({
							assignees: [
								{
									assigneeUserId: "u1",
									assignedByUserId: "asker",
								},
								{
									assigneeUserId: "u2",
									assignedByUserId: "asker",
								},
							],
						}),
						replies: [],
					},
				]}
			/>,
		);

		await user.click(
			screen.getByRole("button", { name: "assigneesLabel" }),
		);
		await user.click(await screen.findByText("Sam R."));

		expect(assignMutation).toHaveBeenCalledWith(
			expect.objectContaining({ assigneeUserIds: ["u2"] }),
		);
	});

	it("never answers the question it is routing", async () => {
		const user = userEvent.setup();
		render(
			<TopicQuestionsPanel
				{...BASE}
				members={MEMBERS}
				threads={[{ root: root(), replies: [] }]}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "assignLabel" }));
		await user.click(await screen.findByText("Sam R."));

		// The root stays OPEN. Routing an ask through the answer path would
		// close the very question being asked.
		expect(answerMutation).not.toHaveBeenCalled();
		expect(amendMutation).not.toHaveBeenCalled();
	});

	it("shows a reader who a question is waiting on, without letting them change it", () => {
		render(
			<TopicQuestionsPanel
				{...BASE}
				canEdit={false}
				members={MEMBERS}
				threads={[
					{
						root: root({
							assignees: [
								{
									assigneeUserId: "u1",
									assignedByUserId: "asker",
								},
							],
						}),
						replies: [],
					},
				]}
			/>,
		);

		// Rendered, not hidden: who is on a question is worth seeing even when
		// you cannot change it, and hiding it would make an assigned question
		// look unassigned to exactly the people most likely to answer it.
		expect(
			screen.getByRole("button", { name: "assigneesLabel" }),
		).toBeDisabled();
	});

	it("keeps an assignee whose project membership has lapsed visible", () => {
		render(
			<TopicQuestionsPanel
				{...BASE}
				members={MEMBERS}
				threads={[
					{
						root: root({
							assignees: [
								{
									assigneeUserId: "gone",
									assignedByUserId: "asker",
								},
							],
						}),
						replies: [],
					},
				]}
			/>,
		);

		// A question that silently shows fewer people than it is assigned to is
		// worse than one showing a nameless avatar — the reader would think
		// nobody had been asked.
		expect(
			screen.getByRole("button", { name: "assigneesLabel" }),
		).toBeInTheDocument();
	});
});

describe("TopicQuestionsPanel — notes asked on a question", () => {
	const ALEX = { id: "user-1", name: "Alex Example", image: null };
	const SAM = { id: "user-2", name: "Sam Example", image: null };
	/** A reply by a person unless overridden, built on the resolved fixture's row. */
	const turn = (overrides: Record<string, unknown>) => ({
		...RESOLVED_THREAD.replies[0],
		author: ALEX,
		...overrides,
	});
	const notesIn = (container: HTMLElement) =>
		within(container).getByRole("list", { name: "Notes on this question" });

	it("lists only the notes under an open question, oldest first, each with who asked and when", () => {
		const thread = {
			root: root(),
			replies: [
				turn({
					id: "note-b",
					parentId: "decision-1",
					status: "OPEN",
					content: "Second: can finance check the figure?",
					author: SAM,
					createdAt: new Date("2026-08-30T11:00:00Z"),
				}),
				turn({
					id: "note-a",
					parentId: "decision-1",
					status: "OPEN",
					content: "First: can legal confirm?",
					createdAt: new Date("2026-08-30T10:30:00Z"),
				}),
				turn({
					id: "resolved-turn",
					parentId: "decision-1",
					status: "RESOLVED",
					content: "A resolved reply is not a note.",
					createdAt: new Date("2026-08-30T10:40:00Z"),
				}),
				turn({
					id: "agent-turn",
					parentId: "decision-1",
					status: "OPEN",
					authorType: "AGENT",
					authorUserId: null,
					author: null,
					content: "An AI turn is not a note.",
					createdAt: new Date("2026-08-30T10:50:00Z"),
				}),
			],
		};
		render(<TopicQuestionsPanel {...BASE} threads={[thread]} />);

		const card = screen.getByTestId("question-decision-1");
		const items = within(notesIn(card)).getAllByRole("listitem");
		expect(items).toHaveLength(2);
		expect(items[0]).toHaveTextContent("First: can legal confirm?");
		expect(items[0]).toHaveTextContent(/Asked by Alex Example ·/);
		expect(items[0].querySelector("time")).toHaveAttribute(
			"datetime",
			"2026-08-30T10:30:00.000Z",
		);
		expect(items[1]).toHaveTextContent(
			"Second: can finance check the figure?",
		);
		expect(items[1]).toHaveTextContent(/Asked by Sam Example ·/);
		expect(items[1].querySelector("time")).toHaveAttribute(
			"datetime",
			"2026-08-30T11:00:00.000Z",
		);
		expect(
			screen.queryByText("A resolved reply is not a note."),
		).not.toBeInTheDocument();
		expect(
			screen.queryByText("An AI turn is not a note."),
		).not.toBeInTheDocument();
		// A note answers nothing: the answer controls are still there.
		expect(
			within(card).getByRole("button", { name: /use this answer/i }),
		).toBeInTheDocument();
	});

	it("shows a long, multi-line note whole, wrapped and unclamped", () => {
		const LONG_NOTE = `${"Please check this quote against the signed release form before we use it. ".repeat(4)}\nThen confirm the job title: ${"x".repeat(60)}`;
		expect(LONG_NOTE.length).toBeGreaterThan(280);
		const thread = {
			root: root(),
			replies: [
				turn({
					id: "note-long",
					parentId: "decision-1",
					status: "OPEN",
					content: LONG_NOTE,
				}),
			],
		};
		render(<TopicQuestionsPanel {...BASE} threads={[thread]} />);

		const body = within(
			notesIn(screen.getByTestId("question-decision-1")),
		).getByText(
			(_content, element) =>
				element?.tagName === "P" && element.textContent === LONG_NOTE,
		);
		expect(body).toHaveClass("whitespace-pre-wrap", "break-words");
		expect(body.className).not.toMatch(/line-clamp-|truncate/);
	});

	it("shows a note under a set-aside question", async () => {
		const thread = {
			root: root({
				id: "decision-4",
				questionId: "q-possibly-resolved",
				status: "POSSIBLY_RESOLVED",
			}),
			replies: [
				turn({
					id: "note-1",
					parentId: "decision-4",
					status: "OPEN",
					content: "Is this still wanted?",
				}),
			],
		};
		render(<TopicQuestionsPanel {...BASE} threads={[thread]} />);
		await userEvent.click(
			screen.getByRole("button", { name: /^possibly resolved/i }),
		);

		expect(
			within(
				notesIn(screen.getByTestId("question-decision-4")),
			).getByText("Is this still wanted?"),
		).toBeVisible();
	});

	it("keeps a note written after the answer out of the answer, and Amend starts from the answer", async () => {
		const NOTE = "Can legal confirm this still holds?";
		const thread = {
			...RESOLVED_THREAD,
			replies: [
				RESOLVED_THREAD.replies[0],
				turn({
					id: "note-1",
					parentId: "decision-3",
					status: "OPEN",
					content: NOTE,
					createdAt: new Date("2026-08-31T09:00:00Z"),
				}),
			],
		};
		const user = userEvent.setup();
		render(<TopicQuestionsPanel {...BASE} threads={[thread]} />);
		await openAnswered();

		const answer = screen.getByTestId("decision-answer");
		expect(answer).toHaveTextContent("Yes, marketing cleared it.");
		const notes = screen.getByRole("list", {
			name: "Notes on this question",
		});
		expect(within(notes).getByText(NOTE)).toBeVisible();
		expect(answer).not.toContainElement(notes);
		expect(screen.getAllByText(NOTE)).toHaveLength(1);

		await user.click(screen.getByRole("button", { name: /amend/i }));
		expect(
			screen.getByRole("textbox", { name: /your answer/i }),
		).toHaveValue("Yes, marketing cleared it.");
	});
});

describe("TopicQuestionsPanel — a current answer saved empty", () => {
	const BLANK_THREAD = {
		...RESOLVED_THREAD,
		replies: [
			RESOLVED_THREAD.replies[0],
			{
				...RESOLVED_THREAD.replies[0],
				id: "reply-blank",
				content: "   ",
				createdAt: new Date("2026-08-31T09:00:00Z"),
			},
		],
	};

	it("says so, opens an empty editor, and amends that reply", async () => {
		const user = userEvent.setup();
		render(<TopicQuestionsPanel {...BASE} threads={[BLANK_THREAD]} />);
		await openAnswered();

		expect(screen.getByTestId("decision-answer")).toHaveTextContent(
			"The latest answer is empty — amend it to record one.",
		);
		expect(
			screen.queryByText("Yes, marketing cleared it."),
		).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: /amend/i }));
		const box = screen.getByRole("textbox", { name: /your answer/i });
		expect(box).toHaveValue("");
		expect(
			screen.getByRole("button", { name: /save answer/i }),
		).toBeDisabled();
		await user.type(box, "No, legal has not signed off.");
		await user.click(screen.getByRole("button", { name: /save answer/i }));

		expect(amendMutation).toHaveBeenCalledWith(
			expect.objectContaining({
				supersedesId: "reply-blank",
				answer: "No, legal has not signed off.",
			}),
		);
	});

	it("says only that it is empty to a reader who cannot amend", async () => {
		render(
			<TopicQuestionsPanel
				{...BASE}
				canEdit={false}
				threads={[BLANK_THREAD]}
			/>,
		);
		await openAnswered();

		expect(screen.getByTestId("decision-answer")).toHaveTextContent(
			/^The latest answer is empty\.$/,
		);
		expect(screen.queryByText(/amend it/i)).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /amend/i }),
		).not.toBeInTheDocument();
	});
});

describe("TopicQuestionsPanel — a refused restore", () => {
	it("refreshes the list, so the card moves to the group it is really in", async () => {
		mutationState.shouldFail = true;
		render(
			<TopicQuestionsPanel
				{...BASE}
				threads={[POSSIBLY_RESOLVED_THREAD]}
			/>,
		);
		await userEvent.click(
			screen.getByRole("button", { name: /^possibly resolved/i }),
		);
		await userEvent.click(
			screen.getByRole("button", { name: /restore to open questions/i }),
		);

		await vi.waitFor(() =>
			expect(invalidateQueries).toHaveBeenCalledWith({
				queryKey: [
					"listTopicDecisions",
					{
						projectId: "proj-1",
						topicId: "topic-1",
						organizationId: null,
					},
				],
			}),
		);
	});
});

/**
 * The other half of the notification contract (Fizzy #1851): the fan-out writes
 * `#q-<rootId>`, and something on this page has to be able to receive it.
 *
 * The two ends live in different packages — `publishingQuestionAssigned` builds
 * the fragment in `@repo/api`, `useScrollToQuestion` reads it here — so nothing
 * but a test holds them to the same shape. Drift by a prefix is silent: the
 * link opens the right page and simply never scrolls, which reads as "the bell
 * link is a bit useless" rather than as a bug anyone files.
 */
describe("TopicQuestionsPanel — landing a notification on its question", () => {
	it("scrolls to and flashes the question the URL fragment names", async () => {
		window.location.hash = "#q-decision-1";
		render(
			<TopicQuestionsPanel
				{...BASE}
				threads={[
					{ root: root({ id: "other" }), replies: [] },
					{ root: root(), replies: [] },
				]}
			/>,
		);

		const target = await screen.findByTestId("question-decision-1");
		// The RAW root id, with no prefix of its own: the hook strips the
		// fragment's `q-` and matches what is left, so a second prefix here
		// would match nothing.
		expect(target).toHaveAttribute("data-question-anchor", "decision-1");
		await vi.waitFor(() =>
			expect(target.classList.contains("mention-flash")).toBe(true),
		);
		// And only that one.
		expect(
			screen
				.getByTestId("question-other")
				.classList.contains("mention-flash"),
		).toBe(false);

		window.location.hash = "";
	});

	it("does nothing at all when the page was opened without a fragment", () => {
		window.location.hash = "";
		render(
			<TopicQuestionsPanel
				{...BASE}
				threads={[{ root: root(), replies: [] }]}
			/>,
		);

		expect(
			screen
				.getByTestId("question-decision-1")
				.classList.contains("mention-flash"),
		).toBe(false);
	});
});

/**
 * A `#q-<rootId>` link names a question that may sit in a COLLAPSED group, whose
 * cards are not in the page for the scroll to find. The panel opens that group
 * for the list that ARRIVES, once.
 */
describe("TopicQuestionsPanel — a link opens the group its question is in", () => {
	/** An OPEN, a RESOLVED and a POSSIBLY_RESOLVED root: decision-1, decision-3, decision-4. */
	const ARRIVED = [OPEN_THREAD, RESOLVED_THREAD, POSSIBLY_RESOLVED_THREAD];
	/** The same topic as a cached list saw it, before decision-3 was answered. */
	const CACHED = [
		OPEN_THREAD,
		{ root: { ...RESOLVED_THREAD.root, status: "OPEN" }, replies: [] },
		POSSIBLY_RESOLVED_THREAD,
	];
	const answeredToggle = () =>
		screen.getByRole("button", { name: /^answered/i });
	const setAsideToggle = () =>
		screen.getByRole("button", { name: /^possibly resolved/i });
	const anchored = (id: string) =>
		document.querySelector(`[data-question-anchor="${id}"]`);

	it("(i) opens Answered when the list arrives with the linked question answered", () => {
		window.location.hash = "#q-decision-3";
		const { rerender } = render(
			<TopicQuestionsPanel {...BASE} isLoading threads={[]} />,
		);
		rerender(
			<TopicQuestionsPanel
				{...BASE}
				isLoading={false}
				threads={ARRIVED}
			/>,
		);

		expect(answeredToggle()).toHaveAttribute("aria-expanded", "true");
		expect(anchored("decision-3")).toBeInTheDocument();
		expect(setAsideToggle()).toHaveAttribute("aria-expanded", "false");
	});

	it("(ii) opens Possibly resolved for a linked set-aside question", () => {
		window.location.hash = "#q-decision-4";
		const { rerender } = render(
			<TopicQuestionsPanel {...BASE} isLoading threads={[]} />,
		);
		rerender(
			<TopicQuestionsPanel
				{...BASE}
				isLoading={false}
				threads={ARRIVED}
			/>,
		);

		expect(setAsideToggle()).toHaveAttribute("aria-expanded", "true");
		expect(anchored("decision-4")).toBeInTheDocument();
		expect(answeredToggle()).toHaveAttribute("aria-expanded", "false");
	});

	it("(iii) leaves Answered closed once the person closes it, whatever the list does next", async () => {
		window.location.hash = "#q-decision-3";
		const { rerender } = render(
			<TopicQuestionsPanel {...BASE} isLoading threads={[]} />,
		);
		rerender(
			<TopicQuestionsPanel
				{...BASE}
				isLoading={false}
				threads={ARRIVED}
			/>,
		);
		await userEvent.click(answeredToggle());
		expect(answeredToggle()).toHaveAttribute("aria-expanded", "false");

		rerender(
			<TopicQuestionsPanel
				{...BASE}
				isLoading={false}
				threads={[...ARRIVED]}
			/>,
		);
		expect(answeredToggle()).toHaveAttribute("aria-expanded", "false");
	});

	it("(iv) opens nothing for a linked open question", () => {
		window.location.hash = "#q-decision-1";
		const { rerender } = render(
			<TopicQuestionsPanel {...BASE} isLoading threads={[]} />,
		);
		rerender(
			<TopicQuestionsPanel
				{...BASE}
				isLoading={false}
				threads={ARRIVED}
			/>,
		);

		expect(answeredToggle()).toHaveAttribute("aria-expanded", "false");
		expect(setAsideToggle()).toHaveAttribute("aria-expanded", "false");
	});

	it("(v) opens the group of the list that arrives, not of the cached one shown first", () => {
		window.location.hash = "#q-decision-3";
		const { rerender } = render(
			<TopicQuestionsPanel
				{...BASE}
				isLoading={false}
				isFetching
				threads={CACHED}
			/>,
		);
		rerender(
			<TopicQuestionsPanel
				{...BASE}
				isLoading={false}
				isFetching={false}
				threads={ARRIVED}
			/>,
		);

		expect(answeredToggle()).toHaveAttribute("aria-expanded", "true");
		expect(anchored("decision-3")).toBeInTheDocument();
	});

	it("(vi) opens it when the cached list did not have the question at all", () => {
		window.location.hash = "#q-decision-3";
		const { rerender } = render(
			<TopicQuestionsPanel
				{...BASE}
				isLoading={false}
				isFetching
				threads={[OPEN_THREAD, POSSIBLY_RESOLVED_THREAD]}
			/>,
		);
		rerender(
			<TopicQuestionsPanel
				{...BASE}
				isLoading={false}
				isFetching={false}
				threads={ARRIVED}
			/>,
		);

		expect(answeredToggle()).toHaveAttribute("aria-expanded", "true");
		expect(anchored("decision-3")).toBeInTheDocument();
	});

	it("(vii) opens nothing after arrival, even when the linked question is answered later", () => {
		window.location.hash = "#q-decision-3";
		const { rerender } = render(
			<TopicQuestionsPanel
				{...BASE}
				isLoading={false}
				isFetching={false}
				threads={CACHED}
			/>,
		);
		rerender(
			<TopicQuestionsPanel
				{...BASE}
				isLoading={false}
				isFetching={false}
				threads={ARRIVED}
			/>,
		);

		expect(answeredToggle()).toHaveAttribute("aria-expanded", "false");
	});

	it("(viii) a load that failed its retries must not end the arrival", () => {
		window.location.hash = "#q-decision-3";
		const { rerender } = render(
			<TopicQuestionsPanel {...BASE} isLoading threads={[]} />,
		);
		// The initial request exhausted its retries: isLoading and isFetching
		// are both false, and the list is empty because nothing arrived.
		rerender(
			<TopicQuestionsPanel
				{...BASE}
				isLoading={false}
				isFetching={false}
				threads={[]}
			/>,
		);
		// A later refetch succeeds and brings the linked question in.
		rerender(
			<TopicQuestionsPanel
				{...BASE}
				isLoading={false}
				isFetching={false}
				threads={ARRIVED}
			/>,
		);

		expect(answeredToggle()).toHaveAttribute("aria-expanded", "true");
		expect(anchored("decision-3")).toBeInTheDocument();
		expect(setAsideToggle()).toHaveAttribute("aria-expanded", "false");
	});
});
