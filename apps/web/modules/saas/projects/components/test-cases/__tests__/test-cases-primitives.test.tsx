import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OwnerAvatar } from "../OwnerAvatar";
import { TestCasePriorityBars } from "../TestCasePriorityBars";
import { TestCaseResultPill } from "../TestCaseResultPill";

describe("TestCaseResultPill", () => {
	it("renders an unknown result instead of crashing the list", () => {
		// `result` comes from the database, and the Temporal worker deploys on a
		// DIFFERENT pipeline from this bundle — so during a deploy window the
		// worker can already be writing a value this bundle has never heard of.
		// Indexing the tone/icon maps blindly made `tone` undefined and
		// `tone.pill` throw, taking the whole cases list down over one string.
		const { container } = render(
			<TestCaseResultPill result={"FLAKY" as never} />,
		);

		// Legible rather than pretty: the raw key, rendered neutral.
		expect(screen.getByText("FLAKY")).toBeInTheDocument();
		expect(
			container.querySelector(".text-muted-foreground"),
		).not.toBeNull();
	});

	it("renders a tone icon + label for each run result (never colour alone)", () => {
		const cases = [
			{ result: "PASSED", label: "Passed", tone: "text-secondary" },
			{ result: "FAILED", label: "Failed", tone: "text-destructive" },
			{ result: "BLOCKED", label: "Blocked", tone: "text-highlight" },
			{
				result: "NOT_RUN",
				label: "Not run",
				tone: "text-muted-foreground",
			},
			{
				result: "SKIPPED",
				label: "Skipped",
				tone: "text-muted-foreground",
			},
		] as const;

		for (const c of cases) {
			const { container, unmount } = render(
				<TestCaseResultPill result={c.result} />,
			);
			// Meaning is carried by the visible label…
			expect(screen.getByText(c.label)).toBeInTheDocument();
			// …plus a distinct, tone-coloured glyph (decorative for AT).
			const icon = container.querySelector(`.${c.tone}`);
			expect(icon).not.toBeNull();
			expect(icon?.getAttribute("aria-hidden")).toBe("true");
			unmount();
		}
	});

	it("keeps the label available to assistive tech when icon-only", () => {
		render(<TestCaseResultPill result="PASSED" iconOnly />);
		// aria-label on the pill + visually-hidden text keep it non-visual-safe.
		expect(screen.getByLabelText("Passed")).toBeInTheDocument();
	});

	it("prefers an explicit (translated) label when provided", () => {
		render(<TestCaseResultPill result="PASSED" label="Bestanden" />);
		expect(screen.getByText("Bestanden")).toBeInTheDocument();
	});
});

describe("TestCasePriorityBars", () => {
	it("fills one bar per priority level and names the priority", () => {
		const cases = [
			{ priority: "LOW", filled: "bg-muted-foreground", count: 1 },
			{ priority: "HIGH", filled: "bg-highlight", count: 3 },
			{ priority: "CRITICAL", filled: "bg-destructive", count: 4 },
		] as const;

		for (const c of cases) {
			const { container, unmount } = render(
				<TestCasePriorityBars priority={c.priority} />,
			);
			// The fill count is the non-colour signal…
			expect(container.querySelectorAll(`.${c.filled}`).length).toBe(
				c.count,
			);
			// …and the priority is named for assistive tech.
			expect(
				container
					.querySelector('[role="img"]')
					?.getAttribute("aria-label"),
			).toBeTruthy();
			unmount();
		}
	});

	it("renders the visible label when asked", () => {
		render(<TestCasePriorityBars priority="HIGH" label="Hoch" showLabel />);
		expect(screen.getByText("Hoch")).toBeInTheDocument();
	});
});

describe("OwnerAvatar", () => {
	it("shows up to two initials from a name", () => {
		render(<OwnerAvatar name="Jane Doe" />);
		expect(screen.getByText("JD")).toBeInTheDocument();
	});

	it("shows a neutral glyph when assigned but the name is unknown", () => {
		const { container } = render(
			<OwnerAvatar assigned label="Owner assigned" />,
		);
		expect(screen.getByLabelText("Owner assigned")).toBeInTheDocument();
		// No initials → falls back to a user glyph.
		expect(container.querySelector("svg")).not.toBeNull();
	});

	it("renders a dashed placeholder when unassigned", () => {
		const { container } = render(<OwnerAvatar label="Unassigned" />);
		expect(screen.getByLabelText("Unassigned")).toBeInTheDocument();
		expect(container.querySelector(".border-dashed")).not.toBeNull();
	});
});
