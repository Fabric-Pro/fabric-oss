/**
 * DecisionLogPanel — group resolved decisions by topic.
 *
 * Decisions are grouped by `root.impactedSection`; a null section falls into a
 * "General" bucket that renders last. The default filter is RESOLVED. next-intl
 * is globally key-mocked in vitest.setup.ts (labels === keys, so the General
 * bucket header reads "generalGroup").
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DecisionLogPanel } from "../DecisionLogPanel";
import type { DecisionLogThread } from "../types";

function resolvedThread(
	id: string,
	impactedSection: string | null,
	createdAt: Date,
): DecisionLogThread {
	return {
		root: {
			id,
			status: "RESOLVED",
			summary: `Decision ${id}`,
			content: null,
			authorType: "USER",
			authorName: null,
			sourceProvenance: null,
			source: "HUMAN",
			createdAt,
			impactedSection,
			topic: null,
			questionId: null,
			decidedBy: null,
			cleanSpecPropagation: null,
			suggestedOptions: [],
			supersedesId: null,
		},
		replies: [],
	};
}

/** An answer turn on a thread. `supersedesId` set = it replaced an earlier one. */
function answerTurn(
	id: string,
	content: string,
	supersedesId: string | null,
	createdAt = new Date("2026-01-03"),
) {
	return {
		id,
		status: "RESOLVED" as const,
		summary: null,
		content,
		authorType: "USER" as const,
		source: "HUMAN" as const,
		authorName: null,
		sourceProvenance: null,
		createdAt,
		supersedesId,
	};
}

/**
 * Amendment rendering (#1910). An amendment is an APPENDED turn that supersedes
 * the previous answer — the log is never edited in place — so the panel must show
 * the newest turn as the answer and keep the superseded one as collapsed history.
 */
describe("DecisionLogPanel — amended answers", () => {
	function amendedThread(): DecisionLogThread {
		const thread = resolvedThread(
			"a",
			"Authentication",
			new Date("2026-01-01"),
		);
		return {
			root: { ...thread.root, questionId: "q_a" },
			replies: [
				answerTurn("r1", "Yes", null),
				answerTurn("r2", "Yes, for admins only", "r1"),
			],
		};
	}

	it("shows the amendment as the answer and the superseded turn as history", () => {
		render(<DecisionLogPanel threads={[amendedThread()]} />);

		expect(screen.getByText("Yes, for admins only")).toBeInTheDocument();
		// Present, not deleted — the old answer stays readable behind a disclosure.
		expect(screen.getByText("amendedFrom")).toBeInTheDocument();
		expect(screen.getByText("Yes")).toBeInTheDocument();
	});

	it("amends against the LIVE turn, not the superseded one", async () => {
		const onAmend = vi.fn();
		render(
			<DecisionLogPanel threads={[amendedThread()]} onAmend={onAmend} />,
		);

		await userEvent.click(screen.getByRole("button", { name: "amend" }));
		const box = screen.getByRole("textbox", { name: "amendLabel" });
		await userEvent.clear(box);
		await userEvent.type(box, "Everyone");
		await userEvent.click(
			screen.getByRole("button", { name: "amendSubmit" }),
		);

		expect(onAmend).toHaveBeenCalledWith({
			questionId: "q_a",
			supersedesId: "r2",
			answer: "Everyone",
		});
	});

	it("is read-only when no amend handler is supplied", () => {
		render(<DecisionLogPanel threads={[amendedThread()]} />);
		expect(
			screen.queryByRole("button", { name: "amend" }),
		).not.toBeInTheDocument();
	});
});

describe("DecisionLogPanel — grouping by topic", () => {
	it("renders a section per impactedSection with the topic as the label", () => {
		render(
			<DecisionLogPanel
				threads={[
					resolvedThread(
						"a",
						"Authentication",
						new Date("2026-01-02"),
					),
					resolvedThread("b", "Billing", new Date("2026-01-01")),
				]}
			/>,
		);

		expect(
			screen.getByRole("region", { name: "Authentication" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("region", { name: "Billing" }),
		).toBeInTheDocument();
	});

	it("puts null-section decisions in a General bucket that sorts last", () => {
		render(
			<DecisionLogPanel
				threads={[
					resolvedThread("general", null, new Date("2026-01-03")),
					resolvedThread(
						"auth",
						"Authentication",
						new Date("2026-01-01"),
					),
				]}
			/>,
		);

		const regions = screen.getAllByRole("region");
		const names = regions.map((r) => r.getAttribute("aria-label"));
		// "General" renders last even though its decision is the newest.
		expect(names).toEqual(["Authentication", "generalGroup"]);
	});

	it("only shows resolved decisions under the default filter", () => {
		const open: DecisionLogThread = {
			...resolvedThread("open", "Authentication", new Date("2026-01-04")),
		};
		open.root = { ...open.root, status: "OPEN", summary: "Still open" };

		render(
			<DecisionLogPanel
				threads={[
					resolvedThread(
						"done",
						"Authentication",
						new Date("2026-01-01"),
					),
					open,
				]}
			/>,
		);

		const authRegion = screen.getByRole("region", {
			name: "Authentication",
		});
		expect(
			within(authRegion).getByText("Decision done"),
		).toBeInTheDocument();
		expect(screen.queryByText("Still open")).not.toBeInTheDocument();
	});
});

describe("DecisionLogPanel — AI update notes", () => {
	function aiUpdateNote(id: string, content: string): DecisionLogThread {
		return {
			root: {
				id,
				status: "RESOLVED",
				summary: null,
				content,
				authorType: "AGENT",
				authorName: null,
				sourceProvenance: null,
				source: "AI_CONFIRMED",
				createdAt: new Date("2026-02-01"),
				impactedSection: "AI Updates",
				topic: null,
				questionId: null,
				decidedBy: null,
				cleanSpecPropagation: null,
				suggestedOptions: [],
			},
			replies: [],
		};
	}

	it("groups AI updates separately and collapses them by default", async () => {
		const user = userEvent.setup();
		render(
			<DecisionLogPanel
				threads={[
					aiUpdateNote("n1", "Added rollout plan\nRaised confidence"),
				]}
			/>,
		);

		const toggle = screen.getByRole("button", { name: /AI Updates/ });
		// Collapsed by default — bullets hidden.
		expect(toggle).toHaveAttribute("aria-expanded", "false");
		expect(
			screen.queryByText("Added rollout plan"),
		).not.toBeInTheDocument();

		await user.click(toggle);

		// Expanding reveals each change bullet.
		expect(screen.getByText("Added rollout plan")).toBeInTheDocument();
		expect(screen.getByText("Raised confidence")).toBeInTheDocument();
	});
});

describe("DecisionLogPanel — collapsible groups", () => {
	it("hides a group's decisions when its header is collapsed", async () => {
		const user = userEvent.setup();
		render(
			<DecisionLogPanel
				threads={[
					resolvedThread(
						"a",
						"Authentication",
						new Date("2026-01-02"),
					),
				]}
			/>,
		);

		// Expanded by default.
		expect(screen.getByText("Decision a")).toBeInTheDocument();
		const toggle = screen.getByRole("button", { name: /Authentication/ });
		expect(toggle).toHaveAttribute("aria-expanded", "true");

		await user.click(toggle);

		expect(toggle).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByText("Decision a")).not.toBeInTheDocument();
	});
});

describe("DecisionLogPanel — attribution", () => {
	it("renders author name and source provenance when provided", () => {
		const namedThread: DecisionLogThread = {
			...resolvedThread("named", "Auth", new Date()),
		};
		namedThread.root = {
			...namedThread.root,
			authorName: "Alice",
			sourceProvenance: "Feature Response — Login",
		};
		render(<DecisionLogPanel threads={[namedThread]} />);
		expect(screen.getByText("Alice")).toBeInTheDocument();
		expect(
			screen.getByText("Feature Response — Login"),
		).toBeInTheDocument();
	});

	it("renders AI-generated for AGENT entries with null attribution", () => {
		const aiThread: DecisionLogThread = {
			...resolvedThread("ai", "Auth", new Date()),
		};
		aiThread.root = {
			...aiThread.root,
			authorType: "AGENT",
			authorName: null,
			sourceProvenance: null,
		};
		render(<DecisionLogPanel threads={[aiThread]} />);
		expect(screen.getByText("aiGenerated")).toBeInTheDocument();
		expect(screen.getByText("unattributed")).toBeInTheDocument();
	});

	it("renders Unknown and Unattributed for legacy entries", () => {
		const legacyThread: DecisionLogThread = {
			...resolvedThread("legacy", "Auth", new Date()),
		};
		legacyThread.root = {
			...legacyThread.root,
			authorType: "USER",
			authorName: null,
			sourceProvenance: null,
		};
		render(<DecisionLogPanel threads={[legacyThread]} />);
		expect(screen.getByText("unknownAuthor")).toBeInTheDocument();
		expect(screen.getByText("unattributed")).toBeInTheDocument();
	});

	it("renders attribution for replies (e.g. answers to AI questions)", () => {
		const replyThread: DecisionLogThread = {
			...resolvedThread("root", "Auth", new Date()),
			replies: [
				{
					id: "reply1",
					parentId: "root",
					status: "RESOLVED",
					summary: null,
					content: "Answer",
					authorType: "USER",
					authorName: "Bob",
					sourceProvenance: "Feature Response — Signup",
					source: "HUMAN",
					createdAt: new Date(),
					impactedSection: null,
					topic: null,
					questionId: null,
					decidedBy: null,
					cleanSpecPropagation: null,
					suggestedOptions: [],
				},
			],
		};
		// Root should be AI generated question
		replyThread.root.authorType = "AGENT";
		replyThread.root.authorName = null;
		replyThread.root.sourceProvenance = null;

		render(<DecisionLogPanel threads={[replyThread]} />);
		// Root attribution
		expect(screen.getByText("aiGenerated")).toBeInTheDocument();
		// Reply attribution
		expect(screen.getByText("Bob")).toBeInTheDocument();
		expect(
			screen.getByText("Feature Response — Signup"),
		).toBeInTheDocument();
	});

	it("renders reply content as markdown, not raw syntax", () => {
		const replyThread: DecisionLogThread = {
			...resolvedThread("root", "Auth", new Date()),
			replies: [
				{
					id: "reply1",
					parentId: "root",
					status: "RESOLVED",
					summary: null,
					content: "**Decided** to enforce 2FA",
					authorType: "USER",
					authorName: "Bob",
					sourceProvenance: null,
					source: "HUMAN",
					createdAt: new Date(),
					impactedSection: null,
					topic: null,
					questionId: null,
					decidedBy: null,
					cleanSpecPropagation: null,
					suggestedOptions: [],
				},
			],
		};

		const { container } = render(
			<DecisionLogPanel threads={[replyThread]} />,
		);
		const strong = container.querySelector("strong");
		expect(strong?.textContent).toBe("Decided");
		expect(container.textContent ?? "").not.toContain("**");
	});
});
