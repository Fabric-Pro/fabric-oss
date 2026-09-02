import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

/** Only the keys these assertions read; anything else falls through as its key. */
const KEYS: Record<string, string> = {
	answerLabel: "Answer this",
	answerSubmit: "Answer",
	askMention: "Ask {names}",
	countAnswered: "{count} answered",
	countAssigned: "{count} assigned",
	countUnanswered: "{count} unanswered",
	assignLabel: "Assign someone",
};

/**
 * The global next-intl mock echoes the KEY and drops interpolation values, which
 * would render this feature's "Ask {names}" button as a bare `askMention` and
 * hide the naming rule these tests exist to check. vitest.setup.ts names a local
 * override as the supported escape hatch for exactly this.
 */
vi.mock("next-intl", () => {
	const t = (key: string, values?: Record<string, unknown>) => {
		const template = KEYS[key] ?? key;
		return values
			? Object.entries(values).reduce<string>(
					(out, [k, v]) => out.replaceAll(`{${k}}`, String(v)),
					template,
				)
			: template;
	};
	t.raw = (key: string) => key;
	return {
		useTranslations: () => t,
		useLocale: () => "en",
		useFormatter: () => ({ number: (n: number) => String(n) }),
	};
});

import { mentionedMemberIds } from "../QuestionMentionTextarea";
import { SummaryQuestionsPanel } from "../SummaryQuestionsPanel";
import type { DecisionLogThread } from "../types";

/**
 * Question assignment UI (Fizzy #1751).
 *
 * The behaviour worth pinning is the mention intent split. A mention is
 * ambiguous in exactly the way ordinary language is — "as per @Sam, ninety days"
 * CITES Sam (an answer), "ninety days, right @Sam?" ASKS him (not an answer) —
 * and only the author knows which. So the panel offers both actions rather than
 * guessing, and offers the second one ONLY once somebody is named.
 *
 * The no-mention path must stay byte-for-byte what shipped before, which is the
 * regression this file guards hardest.
 */

const MEMBERS = [
	{ id: "u_sam", name: "Sam R.", email: "sam@example.com", avatarUrl: null },
	{
		id: "u_dana",
		name: "Dana P.",
		email: "dana@example.com",
		avatarUrl: null,
	},
];

function thread(id: string): DecisionLogThread {
	return {
		root: {
			id,
			questionId: `q-${id}`,
			status: "OPEN",
			summary: "What retention period applies?",
			content: null,
			topic: "Scope & Requirements",
			createdAt: new Date().toISOString(),
			authorType: "AGENT",
			suggestedOptions: null,
		},
		replies: [],
	} as unknown as DecisionLogThread;
}

function renderPanel(overrides: Record<string, unknown> = {}) {
	const onAnswer = vi.fn();
	const onSetAssignees = vi.fn();
	render(
		<>
			<SummaryQuestionsPanel
				summaryDigest="A digest"
				openQuestions={[thread("root_1")]}
				workingNotesContent={null}
				onAnswer={onAnswer}
				onSaveNotes={vi.fn()}
				answeringId={null}
				questionAssignees={{}}
				assignableMembers={MEMBERS}
				onAssigneeQueryChange={vi.fn()}
				onSetAssignees={onSetAssignees}
				{...overrides}
			/>
		</>,
	);
	return { onAnswer, onSetAssignees };
}

describe("mentionedMemberIds", () => {
	it("finds a named member and ignores an unnamed one", () => {
		expect(
			mentionedMemberIds("as per @Sam R., ninety days", MEMBERS),
		).toEqual(["u_sam"]);
		expect(mentionedMemberIds("ninety days", MEMBERS)).toEqual([]);
	});

	it("finds several, de-duplicated", () => {
		const found = mentionedMemberIds(
			"@Sam R. and @Dana P. and @Sam R. again",
			MEMBERS,
		);
		expect(found.sort()).toEqual(["u_dana", "u_sam"]);
	});

	it("does not treat an address as a mention — the @ must start a word", () => {
		expect(mentionedMemberIds("mail me at x@Sam R.com", MEMBERS)).toEqual(
			[],
		);
	});

	it("does not match a longer name that merely starts with one", () => {
		expect(
			mentionedMemberIds("@Sammy is someone else", [
				{
					id: "u_sam_short",
					name: "Sam",
					email: null,
					avatarUrl: null,
				},
			]),
		).toEqual([]);
	});
});

describe("the answer box without a mention", () => {
	it("offers exactly one action, and answering is unchanged", async () => {
		const user = userEvent.setup();
		const { onAnswer, onSetAssignees } = renderPanel();

		await user.click(screen.getByRole("button", { name: "Answer this" }));
		await user.type(
			screen.getByRole("textbox", { name: "Answer this" }),
			"Ninety days.",
		);

		expect(
			screen.queryByRole("button", { name: /^Ask / }),
		).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Answer" }));
		expect(onAnswer).toHaveBeenCalledTimes(1);
		expect(onSetAssignees).not.toHaveBeenCalled();
	});
});

describe("the answer box with a mention", () => {
	it("offers Ask as well, naming the person", async () => {
		const user = userEvent.setup();
		renderPanel();

		await user.click(screen.getByRole("button", { name: "Answer this" }));
		await user.type(
			screen.getByRole("textbox", { name: "Answer this" }),
			"Ninety days, right @Sam R.?",
		);

		expect(
			await screen.findByRole("button", { name: "Ask Sam R." }),
		).toBeInTheDocument();
	});

	it("Ask assigns the mentioned person and keeps the typed text as context", async () => {
		const user = userEvent.setup();
		const { onSetAssignees, onAnswer } = renderPanel();

		await user.click(screen.getByRole("button", { name: "Answer this" }));
		await user.type(
			screen.getByRole("textbox", { name: "Answer this" }),
			"Ninety days, right @Sam R.?",
		);
		await user.click(screen.getByRole("button", { name: "Ask Sam R." }));

		expect(onSetAssignees).toHaveBeenCalledWith(
			"root_1",
			["u_sam"],
			"Ninety days, right @Sam R.?",
		);
		// The load-bearing assertion: asking must NOT answer, or the question
		// being asked about would close.
		expect(onAnswer).not.toHaveBeenCalled();
	});

	it("Answer with a mention still answers — citing is not asking", async () => {
		const user = userEvent.setup();
		const { onSetAssignees, onAnswer } = renderPanel();

		await user.click(screen.getByRole("button", { name: "Answer this" }));
		await user.type(
			screen.getByRole("textbox", { name: "Answer this" }),
			"As per @Sam R., ninety days.",
		);
		await user.click(screen.getByRole("button", { name: "Answer" }));

		expect(onAnswer).toHaveBeenCalledTimes(1);
		expect(onSetAssignees).not.toHaveBeenCalled();
	});

	it("names up to two people, then counts", async () => {
		const user = userEvent.setup();
		renderPanel();

		await user.click(screen.getByRole("button", { name: "Answer this" }));
		await user.type(
			screen.getByRole("textbox", { name: "Answer this" }),
			"@Sam R. and @Dana P. — thoughts?",
		);

		expect(
			await screen.findByRole("button", { name: "Ask Sam R. & Dana P." }),
		).toBeInTheDocument();
	});
});

describe("the member search narrowing while a mention is typed", () => {
	/**
	 * `assignableMembers` is a SERVER SEARCH RESULT, not a roster: every
	 * keystroke after an `@` replaces it with just that token's matches. The
	 * panel used to resolve mentions against it, so naming a second person
	 * silently un-named the first — "Ask Sam R. & Dana P." collapsed to "Ask
	 * Dana P." — while a bare `@` (an unfiltered search) named everybody.
	 *
	 * The sequence below is the real one: the roster is NEVER the full set
	 * during typing, it is whatever the last token matched.
	 */
	it("keeps everyone already named when the roster narrows to the last token", async () => {
		const user = userEvent.setup();
		const props = {
			summaryDigest: "A digest",
			openQuestions: [thread("root_1")],
			workingNotesContent: null,
			onAnswer: vi.fn(),
			onSaveNotes: vi.fn(),
			answeringId: null,
			questionAssignees: {},
			onAssigneeQueryChange: vi.fn(),
			onSetAssignees: vi.fn(),
		};
		// What the search returns while the caret sits in "@Sam".
		const view = render(
			<SummaryQuestionsPanel
				{...props}
				assignableMembers={[MEMBERS[0]]}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Answer this" }));
		await user.type(
			screen.getByRole("textbox", { name: "Answer this" }),
			"@Sam R. and @Dana P. — thoughts?",
		);

		// …and what it returns once the caret has moved on to "@Dana".
		view.rerender(
			<SummaryQuestionsPanel
				{...props}
				assignableMembers={[MEMBERS[1]]}
			/>,
		);

		expect(
			await screen.findByRole("button", { name: "Ask Sam R. & Dana P." }),
		).toBeInTheDocument();
	});
});

describe("what the asker typed", () => {
	/**
	 * A QUESTION_ASSIGNED notification deep-links straight to the question. If
	 * the sentence the asker typed is not rendered there, the recipient arrives
	 * at a bare assignment and has to go hunting through the Decision Log for
	 * what they were actually asked.
	 */
	it("renders the ask note on the question, with who wrote it", () => {
		const asked = thread("root_1");
		render(
			<SummaryQuestionsPanel
				summaryDigest="A digest"
				openQuestions={[
					{
						...asked,
						replies: [
							{
								id: "reply_1",
								status: "OPEN",
								summary: null,
								content: "Could you take the second part?",
								authorType: "USER",
								source: "HUMAN",
								authorName: "Sam R.",
								sourceProvenance: null,
								createdAt: new Date("2026-09-02T10:00:00Z"),
								supersedesId: null,
							},
						],
					} as unknown as DecisionLogThread,
				]}
				workingNotesContent={null}
				onAnswer={vi.fn()}
				onSaveNotes={vi.fn()}
				answeringId={null}
				questionAssignees={{}}
				assignableMembers={MEMBERS}
				onAssigneeQueryChange={vi.fn()}
				onSetAssignees={vi.fn()}
			/>,
		);

		expect(
			screen.getByText("Could you take the second part?"),
		).toBeInTheDocument();
		expect(screen.getByText("Sam R.")).toBeInTheDocument();
	});
});

describe("status tally", () => {
	it("counts an assigned question as assigned, not unanswered", () => {
		renderPanel({
			questionAssignees: {
				root_1: [
					{
						id: "u_sam",
						name: "Sam R.",
						avatarUrl: null,
						assignedByUserId: "u_dana",
					},
				],
			},
			resolvedQuestionsCount: 3,
		});

		expect(screen.getByText("3 answered")).toBeInTheDocument();
		expect(screen.getByText("1 assigned")).toBeInTheDocument();
		expect(screen.getByText("0 unanswered")).toBeInTheDocument();
	});

	it("shows an unassigned question as unanswered", () => {
		renderPanel({ resolvedQuestionsCount: 0 });

		expect(screen.getByText("0 assigned")).toBeInTheDocument();
		expect(screen.getByText("1 unanswered")).toBeInTheDocument();
	});
});

describe("when the feature is off", () => {
	it("renders no assignment controls and no tally", () => {
		renderPanel({
			questionAssignees: undefined,
			onSetAssignees: undefined,
		});

		expect(screen.queryByText(/assigned$/)).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Assign someone" }),
		).not.toBeInTheDocument();
	});
});

describe("deep-link anchor", () => {
	it("renders the raw root id the notification fragment carries", () => {
		const { container } = render(
			<>
				<SummaryQuestionsPanel
					summaryDigest="A digest"
					openQuestions={[thread("root_1")]}
					workingNotesContent={null}
					onAnswer={vi.fn()}
					onSaveNotes={vi.fn()}
					answeringId={null}
					questionAssignees={{}}
					assignableMembers={MEMBERS}
					onAssigneeQueryChange={vi.fn()}
					onSetAssignees={vi.fn()}
				/>
			</>,
		);

		const row = container.querySelector('[data-question-anchor="root_1"]');
		expect(row).not.toBeNull();
		expect(
			within(row as HTMLElement).getByText(
				"What retention period applies?",
			),
		).toBeInTheDocument();
	});
});
