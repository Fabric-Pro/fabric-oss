/**
 * Tests for `DiffOutcomeChip` — spec 2026-05-19-ai-assistant-document-chat-history
 * §3.8 FR-23, AC-2 (Group G.2).
 *
 * The chip is purely informational. It renders the persisted accept /
 * reject outcome of a `write_document_local` tool-call as one of three
 * states keyed off `acceptedAt` / `rejectedAt`:
 *
 *   - Pending  — neither stamp present, while the chat waits on the call
 *                (its id is among CopilotKit's executing tool calls: the
 *                confirm card is live)
 *   - No decision recorded — neither stamp present, and the chat waits on
 *                nothing for it: an old proposal never answered (Fizzy #2946)
 *   - Accepted — `acceptedAt` set (winner — beats `rejectedAt` if both)
 *   - Rejected — `rejectedAt` set
 *
 * We assert on:
 *   - Visible label per state — this IS the announce-able content for
 *     screen readers since the chip is a plain `<span>` with text. The
 *     surrounding viewer line ("toolName | chip") is what a screen
 *     reader actually announces; the chip's role is to add the outcome
 *     word to that reading order.
 *   - Underlying shadcn `Badge` variant via `data-slot="badge"` + the
 *     variant-specific class signature from `badge.tsx`.
 *   - Non-interactivity — the chip MUST NOT be focusable (no tabIndex,
 *     no button role). A focusable chip would mislead keyboard users
 *     into thinking they can act on it.
 *
 * We deliberately do NOT call `toHaveAccessibleName` on the chip. The
 * ARIA accessible-name algorithm yields an empty string for a roleless
 * `<span>` — the text is computed at the surrounding line level via the
 * "Name From Content" rule, not the span itself. Asserting the visible
 * text via `toHaveTextContent` is the correct contract here.
 *
 * Why we exercise the EXTRACTED chip and not the drawer
 * -----------------------------------------------------
 * `CopilotHistoryDrawer` mounts the chip inside its read-only viewer
 * pane (Group F.5). Driving the chip's three states through the drawer
 * would require seeding three full conversations and three round-trips
 * through `useDocumentAssistantHistoryList` / `useActiveDocumentAssistantConversation`,
 * which adds noise without strengthening the assertion. Extracting
 * `<DiffOutcomeChip>` into its own module (`./DiffOutcomeChip.tsx`) is
 * allowed under Group G.2's brief and gives us a tight, isolated
 * surface to snapshot.
 */

import { CopilotKitContext } from "@copilotkit/react-core/v2/context";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import {
	DiffOutcomeChip,
	hasDiffOutcome,
} from "../../modules/saas/projects/components/copilot/DiffOutcomeChip";

/** The chat waiting on `ids`, as CopilotKit says while a card is live. */
function awaiting(ids: string[]) {
	return ({ children }: { children: ReactNode }) => (
		<CopilotKitContext.Provider
			value={{ executingToolCallIds: new Set(ids) } as never}
		>
			{children}
		</CopilotKitContext.Provider>
	);
}

function assertChipShape(
	chip: HTMLElement,
	label: "Pending" | "No decision recorded" | "Accepted" | "Rejected",
	expectedClasses: string[],
) {
	// The visible label IS the announce-able content for the surrounding
	// line's screen-reader reading order ("Name From Content"). Asserting
	// the text via `toHaveTextContent` is the correct contract for a
	// roleless `<span>` chip.
	expect(chip).toHaveTextContent(label);
	const badge = chip.closest('[data-slot="badge"]') as HTMLElement | null;
	expect(badge).not.toBeNull();
	for (const cls of expectedClasses) {
		expect(badge?.className).toContain(cls);
	}
	// Informational — NOT a button, NOT focusable.
	expect(badge?.tagName).toBe("SPAN");
	expect(badge?.getAttribute("role")).toBeNull();
	expect(badge?.hasAttribute("tabindex")).toBe(false);
}

describe("<DiffOutcomeChip>", () => {
	it("renders the Pending chip when neither stamp is set and the chat waits on the call", () => {
		render(<DiffOutcomeChip toolCall={{ id: "call-1" }} />, {
			wrapper: awaiting(["call-1"]),
		});
		const chip = screen.getByText("Pending");
		// shadcn Badge `variant="secondary"` → bg-secondary classlist
		// (see badge.tsx).
		assertChipShape(chip, "Pending", ["bg-secondary"]);
	});

	it("renders No decision recorded for an unanswered call the chat no longer waits on (Fizzy #2946)", () => {
		// An old confirm_changes card from an earlier day: no stamp, and no
		// review in the editor to answer it with.
		render(<DiffOutcomeChip toolCall={{ id: "call-old" }} />, {
			wrapper: awaiting(["call-live"]),
		});
		expect(screen.queryByText("Pending")).not.toBeInTheDocument();
		const chip = screen.getByText("No decision recorded");
		assertChipShape(chip, "No decision recorded", [
			"text-muted-foreground",
		]);
	});

	it("renders No decision recorded without a CopilotKit provider or a call id", () => {
		const { unmount } = render(
			<DiffOutcomeChip toolCall={{ id: "call-1" }} />,
		);
		expect(screen.getByText("No decision recorded")).toBeInTheDocument();
		unmount();

		render(<DiffOutcomeChip toolCall={{}} />, {
			wrapper: awaiting(["call-1"]),
		});
		expect(screen.getByText("No decision recorded")).toBeInTheDocument();
	});

	it("keeps a stamp over a live call", () => {
		render(
			<DiffOutcomeChip
				toolCall={{ id: "call-1", rejectedAt: "2026-05-20T10:05:00Z" }}
			/>,
			{ wrapper: awaiting(["call-1"]) },
		);
		expect(screen.getByText(/^Rejected/)).toBeInTheDocument();
		expect(screen.queryByText("Pending")).not.toBeInTheDocument();
	});

	it("renders the Accepted chip when acceptedAt is set", () => {
		render(
			<DiffOutcomeChip
				toolCall={{ acceptedAt: "2026-05-20T10:00:00Z" }}
			/>,
		);
		// `findChipByLeadingWord` is a substring match — the chip now
		// includes a relative timestamp suffix (e.g. "Accepted · 5m ago")
		// for UX context.
		const chip = screen.getByText(/^Accepted/);
		// `variant="default"` → primary-tinted classlist.
		assertChipShape(chip, "Accepted", ["bg-primary"]);
	});

	it("renders the Rejected chip when rejectedAt is set", () => {
		render(
			<DiffOutcomeChip
				toolCall={{ rejectedAt: "2026-05-20T10:05:00Z" }}
			/>,
		);
		const chip = screen.getByText(/^Rejected/);
		// `variant="outline"` plus the destructive overrides applied at
		// the call site.
		assertChipShape(chip, "Rejected", [
			"border-destructive",
			"text-destructive",
		]);
	});

	it("prefers Accepted when both acceptedAt and rejectedAt are set", () => {
		// The chip's contract (`if (acceptedAt) return ...; if (rejectedAt) …`)
		// makes Accepted win. Pinning this in a test prevents a future
		// refactor from silently flipping the precedence.
		render(
			<DiffOutcomeChip
				toolCall={{
					acceptedAt: "2026-05-20T10:00:00Z",
					rejectedAt: "2026-05-20T10:05:00Z",
				}}
			/>,
		);
		expect(screen.getByText(/^Accepted/)).toBeInTheDocument();
		expect(screen.queryByText(/^Rejected/)).not.toBeInTheDocument();
	});

	it("treats explicit nulls as 'not set' (Pending)", () => {
		// Persisted JSON sometimes carries explicit `null` (e.g. set then
		// cleared in a future API tweak) — those must NOT count as a
		// positive outcome.
		render(
			<DiffOutcomeChip
				toolCall={{ id: "call-1", acceptedAt: null, rejectedAt: null }}
			/>,
			{ wrapper: awaiting(["call-1"]) },
		);
		expect(screen.getByText("Pending")).toBeInTheDocument();
	});
});

describe("hasDiffOutcome", () => {
	it("gives a chip to the proposals the editors stamp, and to a call with no name", () => {
		expect(hasDiffOutcome("confirm_changes")).toBe(true);
		expect(hasDiffOutcome("write_document_local")).toBe(true);
		expect(hasDiffOutcome(undefined)).toBe(true);
	});

	it("gives none to another tool the assistant called", () => {
		expect(hasDiffOutcome("search_project_knowledge")).toBe(false);
	});
});
