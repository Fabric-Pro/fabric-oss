/**
 * TopicBlockers — what a topic is missing, answered from Summary & Questions
 * (Fizzy #1988).
 *
 * Rendered directly: the item page's mutation mock can neither expose a
 * mutation's variables nor run its `onSuccess`, and both are what this file is
 * about. An answer carries the analysis version of the blocker as the member
 * saw it — captured when "Answer" opens the editor, or on screen at the click
 * for "Not needed" — and an answer refused because a newer analysis rewrote
 * the blocker keeps the editor and its draft, so the retry is written against
 * the new wording.
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { settleMutation, invalidateQueries, mutationState } = vi.hoisted(() => ({
	/** The variables each `mutate` call sent. */
	settleMutation: vi.fn(),
	/** ONE spy for every `useQueryClient()` call, so a refetch is observable. */
	invalidateQueries: vi.fn(),
	mutationState: {
		/** What the answer mutation resolves with; `onSuccess` reads `status`. */
		result: { status: "resolved", root: null } as {
			status: string;
			root: unknown;
		},
	},
}));

vi.mock("@tanstack/react-query", () => ({
	// Runs the component's REAL `onSuccess` with the controlled result, inside
	// `mutate`. TanStack runs it a tick later; the component's `onSuccess`
	// sets a ref and state, calls `invalidateQueries`, and toasts — none of
	// that depends on running on a later tick, so running it synchronously
	// here does not change what this file observes.
	useMutation: (opts: { onSuccess?: (...a: unknown[]) => unknown }) => ({
		mutate: (vars: unknown) => {
			settleMutation(vars);
			opts.onSuccess?.(mutationState.result, vars, undefined);
		},
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

import { TopicBlockers } from "@saas/projects/components/publishing-suite/TopicBlockers";
import { toast } from "sonner";

const BASE = {
	projectId: "proj-1",
	topicId: "topic-1",
	organizationId: null as string | null,
	canEdit: true,
};
const CHANGED_COPY =
	"A newer analysis changed this item. Read it again, then save your answer.";
const INVALIDATE_CALL = {
	queryKey: [
		"listTopicDecisions",
		{ projectId: "proj-1", topicId: "topic-1", organizationId: null },
	],
};

/**
 * One OPEN blocker at `analysisVersion` (`null` when the analysis has not
 * recorded one), worded as that version words it. "A" is a missing quote;
 * "B" is missing logo files — a second blocker whose actions render beside
 * A's open editor.
 */
function blocker(analysisVersion: number | null, which: "A" | "B" = "A") {
	const isB = which === "B";
	const versionLabel =
		analysisVersion === null ? "unknown" : `v${analysisVersion}`;
	return {
		root: {
			id: isB ? "blocker-b" : "blocker-a",
			parentId: null,
			kind: "BLOCKER" as const,
			status: "OPEN",
			authorType: "AGENT" as const,
			authorUserId: null,
			questionId: isB ? "b-logo-files" : "b-customer-quote",
			decisionKind: isB ? "MISSING_ASSET" : "MISSING_QUOTE",
			subject: isB
				? "the example-org logo files"
				: "a quote from example-org",
			summary: isB
				? `Someone needs the example-org logo files (analysis ${versionLabel}).`
				: `Someone needs an approved quote from example-org (analysis ${versionLabel}).`,
			content: null,
			recommendedResponse: null,
			answerOptions: null,
			whyItMatters: null,
			answerSource: null,
			analysisVersion,
			createdAt: new Date("2026-09-01T10:00:00Z"),
			assignees: [],
		},
		replies: [],
	};
}
/** Blocker A alone. */
const blockers = (analysisVersion: number | null) => (
	<TopicBlockers {...BASE} threads={[blocker(analysisVersion)]} />
);
/**
 * Blockers A and B, EACH at its own `analysisVersion` — deliberately
 * different by default in the tests below, so a request that sent the wrong
 * blocker's version cannot hide behind two rows that happen to read alike.
 */
const twoBlockersAt = (aVersion: number, bVersion: number) => (
	<TopicBlockers
		{...BASE}
		threads={[blocker(aVersion, "A"), blocker(bVersion, "B")]}
	/>
);
/**
 * The SAME blocker `id` across a rerender with a DIFFERENT `questionId`.
 * Reconciliation does not produce this today — a new `questionId` gets a new
 * root — so the case is a guard: "Save answer" sends a capture only for the
 * question it was taken on, never merely because one exists.
 */
const reclassified = (questionId: string, analysisVersion: number) => (
	<TopicBlockers
		{...BASE}
		threads={[
			{
				root: { ...blocker(analysisVersion).root, questionId },
				replies: [],
			},
		]}
	/>
);
/** The list item of the blocker whose summary matches `summary`. */
const rowOf = (summary: RegExp) =>
	within(screen.getByText(summary).closest("li") as HTMLElement);
const field = () => screen.getByRole("textbox", { name: "Your answer" });
const lastSent = () =>
	settleMutation.mock.calls.at(-1)?.[0] as
		| Record<string, unknown>
		| undefined;

beforeEach(() => {
	vi.clearAllMocks();
	mutationState.result = { status: "resolved", root: null };
});

describe("TopicBlockers — an answer carries the version it was written against (Fizzy #1988)", () => {
	it("sends the version on screen when the editor opened, not the one a refetch put there since", async () => {
		const user = userEvent.setup();
		const { rerender } = render(blockers(1));

		await user.click(screen.getByRole("button", { name: "Answer" }));
		await user.type(field(), "Legal sent one on Friday.");
		rerender(blockers(2));
		expect(
			screen.getByText(
				"Someone needs an approved quote from example-org (analysis v2).",
			),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Save answer" }));

		expect(settleMutation).toHaveBeenCalledTimes(1);
		expect(lastSent()).toMatchObject({
			kind: "BLOCKER",
			questionId: "b-customer-quote",
			answer: "Legal sent one on Friday.",
			answerSource: "MANUAL",
			expectedAnalysisVersion: 1,
		});
	});

	it("sends the version on screen at the click for Not needed", async () => {
		const user = userEvent.setup();
		render(blockers(2));

		await user.click(screen.getByRole("button", { name: "Not needed" }));

		expect(lastSent()).toMatchObject({
			answer: "Not needed for this topic.",
			expectedAnalysisVersion: 2,
		});
	});

	it("says the item changed, keeps the editor and the draft, and sends the new version on the retry", async () => {
		const user = userEvent.setup();
		const { rerender } = render(blockers(1));

		await user.click(screen.getByRole("button", { name: "Answer" }));
		await user.type(field(), "Legal sent one on Friday.");
		mutationState.result = { status: "question_changed", root: null };
		// Refused while version 1 is still on screen.
		await user.click(screen.getByRole("button", { name: "Save answer" }));

		expect(lastSent()).toMatchObject({ expectedAnalysisVersion: 1 });
		expect(toast.error).toHaveBeenCalledWith(CHANGED_COPY);
		expect(invalidateQueries).toHaveBeenCalledWith(INVALIDATE_CALL);
		expect(field()).toHaveValue("Legal sent one on Friday.");

		rerender(blockers(2));
		await user.click(screen.getByRole("button", { name: "Save answer" }));

		expect(settleMutation).toHaveBeenCalledTimes(2);
		expect(lastSent()).toMatchObject({
			answer: "Legal sent one on Friday.",
			expectedAnalysisVersion: 2,
		});
	});

	it("captures the version again when the editor is reopened after Cancel", async () => {
		const user = userEvent.setup();
		const { rerender } = render(blockers(1));

		await user.click(screen.getByRole("button", { name: "Answer" }));
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		rerender(blockers(2));
		await user.click(screen.getByRole("button", { name: "Answer" }));
		await user.type(field(), "Legal sent one on Friday.");
		await user.click(screen.getByRole("button", { name: "Save answer" }));

		expect(lastSent()).toMatchObject({ expectedAnalysisVersion: 2 });
	});

	it("closes the editor once the answer is recorded, and says nothing more", async () => {
		const user = userEvent.setup();
		render(blockers(1));

		await user.click(screen.getByRole("button", { name: "Answer" }));
		await user.type(field(), "Legal sent one on Friday.");
		await user.click(screen.getByRole("button", { name: "Save answer" }));

		expect(
			screen.queryByRole("textbox", { name: "Your answer" }),
		).not.toBeInTheDocument();
		expect(invalidateQueries).toHaveBeenCalledWith(INVALIDATE_CALL);
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("keeps an open editor's capture when ANOTHER blocker's answer is refused", async () => {
		// One mutation serves every blocker, and B's actions render beside A's
		// open editor: B's refusal must not touch A's editor or A's capture. A
		// and B sit at DIFFERENT versions (1 and 3): if B's own request ever
		// leaked A's captured version instead of the one on B's own screen, a
		// same-valued fixture could not have caught it.
		const user = userEvent.setup();
		const { rerender } = render(twoBlockersAt(1, 3));

		await user.click(
			rowOf(/approved quote/).getByRole("button", { name: "Answer" }),
		);
		await user.type(field(), "Legal sent one on Friday.");
		mutationState.result = { status: "question_changed", root: null };
		await user.click(
			rowOf(/logo files/).getByRole("button", { name: "Not needed" }),
		);

		expect(lastSent()).toMatchObject({
			questionId: "b-logo-files",
			expectedAnalysisVersion: 3,
		});
		expect(toast.error).toHaveBeenCalledWith(CHANGED_COPY);
		expect(invalidateQueries).toHaveBeenCalledWith(INVALIDATE_CALL);
		expect(field()).toHaveValue("Legal sent one on Friday.");

		rerender(twoBlockersAt(2, 3));
		await user.click(screen.getByRole("button", { name: "Save answer" }));

		// A's draft was composed against version 1, and B's refusal did not
		// change that.
		expect(lastSent()).toMatchObject({
			questionId: "b-customer-quote",
			answer: "Legal sent one on Friday.",
			expectedAnalysisVersion: 1,
		});
	});

	it("keeps an open editor and its draft when ANOTHER blocker's answer is recorded", async () => {
		// Same disambiguation as above, on the SUCCESS path: B's own version
		// (3) must reach its request, and A's capture (1) must survive B's
		// success exactly as it survives B's refusal.
		const user = userEvent.setup();
		const { rerender } = render(twoBlockersAt(1, 3));

		await user.click(
			rowOf(/approved quote/).getByRole("button", { name: "Answer" }),
		);
		await user.type(field(), "Legal sent one on Friday.");
		// `resolved` is the default result.
		await user.click(
			rowOf(/logo files/).getByRole("button", { name: "Not needed" }),
		);

		expect(lastSent()).toMatchObject({
			questionId: "b-logo-files",
			answer: "Not needed for this topic.",
			expectedAnalysisVersion: 3,
		});
		expect(invalidateQueries).toHaveBeenCalledTimes(1);
		expect(field()).toHaveValue("Legal sent one on Friday.");
		expect(toast.error).not.toHaveBeenCalled();

		// B's SUCCESS must not clear A's capture either: A's later save still
		// sends the version it was composed at (1), not the one now on
		// screen (2).
		rerender(twoBlockersAt(2, 3));
		await user.click(screen.getByRole("button", { name: "Save answer" }));

		expect(lastSent()).toMatchObject({
			questionId: "b-customer-quote",
			answer: "Legal sent one on Friday.",
			expectedAnalysisVersion: 1,
		});
	});

	it("checks the capture against the question on screen, not just that one exists", async () => {
		// Same `id`, different `questionId` and version: the capture taken for
		// the first question must not be sent for the second.
		const user = userEvent.setup();
		const { rerender } = render(reclassified("b-customer-quote", 1));

		await user.click(screen.getByRole("button", { name: "Answer" }));
		await user.type(field(), "Legal sent one on Friday.");
		rerender(reclassified("b-customer-quote-v2", 5));
		await user.click(screen.getByRole("button", { name: "Save answer" }));

		expect(lastSent()).toMatchObject({
			questionId: "b-customer-quote-v2",
			expectedAnalysisVersion: 5,
		});
	});

	it("sends null when the blocker's analysis carries no version yet", async () => {
		const user = userEvent.setup();
		render(blockers(null));

		await user.click(screen.getByRole("button", { name: "Answer" }));
		await user.type(field(), "Legal sent one on Friday.");
		await user.click(screen.getByRole("button", { name: "Save answer" }));

		const sent = lastSent();
		expect(sent && Object.hasOwn(sent, "expectedAnalysisVersion")).toBe(
			true,
		);
		expect(sent?.expectedAnalysisVersion).toBeNull();
	});

	it("sends null for Not needed when the blocker's analysis carries no version yet", async () => {
		const user = userEvent.setup();
		render(blockers(null));

		await user.click(screen.getByRole("button", { name: "Not needed" }));

		const sent = lastSent();
		expect(sent && Object.hasOwn(sent, "expectedAnalysisVersion")).toBe(
			true,
		);
		expect(sent?.expectedAnalysisVersion).toBeNull();
	});
});
