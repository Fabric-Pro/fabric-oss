/**
 * TopicDecisionLog — the Decision Log tab (Publishing Suite Phase 2A-3,
 * FR43–FR47, Fizzy #1851).
 *
 * Reads the SAME `TopicDecisionThread[]` shape Task 6's `TopicQuestionsPanel`
 * consumes — see that file's own doc comment for why the type is declared
 * locally rather than imported from `@repo/database`. This file pins the
 * log's own behavior: newest-first ordering, the All/Open/Resolved filter
 * (defaulting to RESOLVED), a resolved question showing its answer beneath
 * it, and AI Updates grouped separately and collapsed by default — mirroring
 * `DecisionLogPanel.test.tsx` (Feature Maturation) for the shape of these
 * assertions.
 *
 * Fixture note: `filters to open, resolved and all` deliberately does NOT
 * reuse the module-level `RESOLVED_THREAD` for its "resolved" half. That
 * thread's summary is intentionally the same question text as `OPEN_THREAD`
 * (mirroring `publishing-topic-questions.test.tsx`'s convention of both
 * fixtures sharing `root()`'s default summary) so it can double as the
 * FR46 fixture below — reusing it here as well would make the Resolved-tab
 * assertion pass or fail depending on which of two identically-worded roots
 * the query happened to match, rather than on the filter. The filter test
 * builds its own second thread instead, with a distinct summary.
 */

import { TopicDecisionLog } from "@saas/projects/components/publishing-suite/TopicDecisionLog";
import type { TopicDecisionThread } from "@saas/projects/components/publishing-suite/TopicQuestionsPanel";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

/** A QUESTION root plus its (empty by default) replies, as `listTopicDecisions` returns it. */
function root(
	overrides: Record<string, unknown> = {},
): TopicDecisionThread["root"] {
	return {
		id: "decision-1",
		parentId: null,
		kind: "QUESTION",
		status: "OPEN",
		authorType: "AGENT",
		authorUserId: null,
		questionId: "q-1",
		decisionKind: "CUSTOMER_NAME",
		subject: "the named customer",
		summary: "May we name the customer?",
		content: null,
		recommendedResponse: null,
		whyItMatters: null,
		answerSource: null,
		analysisVersion: 1,
		createdAt: new Date("2026-08-20T10:00:00Z"),
		...overrides,
	};
}

/** A reply row — an answer to a QUESTION root. */
function reply(
	overrides: Record<string, unknown> = {},
): TopicDecisionThread["replies"][number] {
	return {
		id: "reply-1",
		parentId: "decision-1",
		kind: "QUESTION",
		status: "RESOLVED",
		authorType: "USER",
		authorUserId: "user-1",
		questionId: null,
		decisionKind: null,
		subject: null,
		summary: null,
		content: "An answer.",
		recommendedResponse: null,
		whyItMatters: null,
		answerSource: "MANUAL",
		analysisVersion: null,
		createdAt: new Date("2026-08-20T10:05:00Z"),
		...overrides,
	};
}

const OLD_THREAD: TopicDecisionThread = {
	root: root({
		id: "decision-old",
		questionId: "q-old",
		status: "RESOLVED",
		summary: "An older question about the launch window.",
		createdAt: new Date("2026-08-18T09:00:00Z"),
	}),
	replies: [],
};

const NEW_THREAD: TopicDecisionThread = {
	root: root({
		id: "decision-new",
		questionId: "q-new",
		status: "RESOLVED",
		summary: "Is this the newer question about pricing?",
		createdAt: new Date("2026-08-29T09:00:00Z"),
	}),
	replies: [],
};

const OPEN_THREAD: TopicDecisionThread = {
	root: root({
		id: "decision-open",
		questionId: "q-customer-name",
		status: "OPEN",
		createdAt: new Date("2026-08-27T09:00:00Z"),
	}),
	replies: [],
};

const RESOLVED_THREAD: TopicDecisionThread = {
	root: root({
		id: "decision-resolved",
		questionId: "q-customer-name",
		status: "RESOLVED",
		answerSource: "MANUAL",
		createdAt: new Date("2026-08-26T09:00:00Z"),
	}),
	replies: [
		reply({
			id: "reply-customer-name",
			parentId: "decision-resolved",
			content: "Yes, marketing cleared it.",
			createdAt: new Date("2026-08-26T09:05:00Z"),
		}),
	],
};

const AI_UPDATE_THREAD: TopicDecisionThread = {
	root: root({
		id: "decision-ai-update",
		kind: "AI_UPDATE",
		status: "RESOLVED",
		authorType: "AGENT",
		questionId: null,
		decisionKind: null,
		subject: null,
		summary: "Planning analysis v2",
		content: "Questions after regeneration: 1 new, 2 updated.",
		recommendedResponse: null,
		analysisVersion: 2,
		createdAt: new Date("2026-08-28T09:00:00Z"),
	}),
	replies: [],
};

describe("TopicDecisionLog (FR43–FR47)", () => {
	it("lists the topic's questions newest first", () => {
		render(<TopicDecisionLog threads={[OLD_THREAD, NEW_THREAD]} />);

		const items = screen.getAllByTestId("decision-root");
		expect(items[0]).toHaveTextContent(/newer question/i);
	});

	it("filters to open, resolved and all (FR45)", async () => {
		const user = userEvent.setup();
		// A second RESOLVED thread, distinct from the module-level
		// `RESOLVED_THREAD` — see the file-level fixture note.
		const otherResolvedThread: TopicDecisionThread = {
			root: root({
				id: "decision-resolved-other",
				questionId: "q-partner-credit",
				status: "RESOLVED",
				summary: "Should we credit the design partner?",
				createdAt: new Date("2026-08-27T10:00:00Z"),
			}),
			replies: [
				reply({
					id: "reply-partner-credit",
					parentId: "decision-resolved-other",
					content: "Yes, marketing cleared it.",
				}),
			],
		};
		render(
			<TopicDecisionLog threads={[OPEN_THREAD, otherResolvedThread]} />,
		);

		// Default filter is RESOLVED — the open item does not show yet.
		expect(
			screen.queryByText(/may we name the customer/i),
		).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: /^open$/i }));
		expect(
			screen.queryByText(/yes, marketing cleared it/i),
		).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: /^resolved$/i }));
		expect(
			screen.queryByText(/may we name the customer/i),
		).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: /^all$/i }));
		expect(screen.getAllByTestId("decision-root")).toHaveLength(2);
	});

	it("shows a resolved question's answer beneath it (FR46)", () => {
		render(<TopicDecisionLog threads={[RESOLVED_THREAD]} />);

		expect(screen.getByText(/may we name the customer/i)).toBeVisible();
		expect(screen.getByText(/yes, marketing cleared it/i)).toBeVisible();
	});

	it("groups AI Updates separately and collapses them by default (FR47)", async () => {
		// A run note is history, not a decision. Interleaving them buries the
		// decisions the log exists to show.
		const user = userEvent.setup();
		render(
			<TopicDecisionLog threads={[RESOLVED_THREAD, AI_UPDATE_THREAD]} />,
		);

		expect(
			screen.queryByText(/questions after regeneration/i),
		).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: /ai updates/i }));
		expect(screen.getByText(/questions after regeneration/i)).toBeVisible();
	});

	it("shows the version-change summary on the AI Update card (FR47)", async () => {
		// `analysisVersion`/`summary` are written by `reconcileTopicQuestions`
		// but were never read by any surface until now — FR47 names "version-
		// change summaries", and the card rendered only `content` beneath it.
		const user = userEvent.setup();
		render(<TopicDecisionLog threads={[AI_UPDATE_THREAD]} />);

		await user.click(screen.getByRole("button", { name: /ai updates/i }));
		expect(screen.getByText(/planning analysis v2/i)).toBeVisible();
	});

	it("marks status with an icon and text, never colour alone", () => {
		// WCAG 2.1 AA: colour is not an information channel on its own. Scoped
		// to the decision card itself — the filter bar also has a "Resolved"
		// button, so an unscoped query would match both.
		render(<TopicDecisionLog threads={[RESOLVED_THREAD]} />);
		const card = screen.getByTestId("decision-root");
		expect(within(card).getByText(/^resolved$/i)).toBeVisible();
	});

	it("shows a loading skeleton while the threads are in flight", () => {
		render(<TopicDecisionLog threads={[]} isLoading />);
		expect(screen.getByTestId("topic-decision-log-loading")).toBeVisible();
	});

	it("shows an empty state when there are no decisions at all", () => {
		render(<TopicDecisionLog threads={[]} />);

		expect(
			screen.getByText(/no decisions recorded for this topic yet/i),
		).toBeVisible();
		// Not a bare filter bar with nothing under it — the filter itself
		// must not render when there is nothing to filter.
		expect(
			screen.queryByRole("button", { name: /^resolved$/i }),
		).not.toBeInTheDocument();
	});

	it("says so when the active filter has nothing to show (FR45)", async () => {
		// The branch most likely to regress silently: reachable only by
		// switching filters, not by any default render.
		const user = userEvent.setup();
		render(<TopicDecisionLog threads={[RESOLVED_THREAD]} />);

		await user.click(screen.getByRole("button", { name: /^open$/i }));

		expect(screen.getByText(/no open decisions/i)).toBeVisible();
		expect(screen.queryByTestId("decision-root")).not.toBeInTheDocument();
	});
});
