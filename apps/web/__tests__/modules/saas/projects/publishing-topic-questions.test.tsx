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

const { answerMutation, mutationState } = vi.hoisted(() => ({
	answerMutation: vi.fn(),
	mutationState: { shouldFail: false },
}));

vi.mock("@tanstack/react-query", () => ({
	useMutation: (opts: {
		onSuccess?: (...a: unknown[]) => unknown;
		onError?: (...a: unknown[]) => unknown;
	}) => ({
		mutate: (vars: unknown) => {
			answerMutation(vars);
			if (mutationState.shouldFail) {
				opts.onError?.(new Error("failed"), vars, undefined);
			} else {
				opts.onSuccess?.(undefined, vars, undefined);
			}
		},
		isPending: false,
	}),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

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
