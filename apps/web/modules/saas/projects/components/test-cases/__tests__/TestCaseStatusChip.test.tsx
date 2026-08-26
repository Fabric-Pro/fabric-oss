import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TestCaseStatusChip } from "../TestCaseStatusChip";

describe("TestCaseStatusChip", () => {
	it("renders the label text and a tone dot for each test-case state", () => {
		const cases = [
			{ status: "READY", label: "Ready", dot: "bg-secondary" },
			{ status: "DRAFT", label: "Draft", dot: "bg-highlight" },
			{ status: "CLOSED", label: "Closed", dot: "bg-muted-foreground" },
		] as const;

		for (const c of cases) {
			const { container, unmount } = render(
				<TestCaseStatusChip status={c.status} />,
			);
			// Meaning is carried by the visible text label…
			expect(screen.getByText(c.label)).toBeInTheDocument();
			// …plus a coloured dot (never colour alone)…
			expect(container.querySelector(`.${c.dot}`)).not.toBeNull();
			// …and the dot itself is decorative for assistive tech.
			expect(
				container.querySelector('[aria-hidden="true"]'),
			).not.toBeNull();
			unmount();
		}
	});

	it("prefers an explicit (translated) label when provided", () => {
		render(<TestCaseStatusChip status="READY" label="Bereit" />);
		expect(screen.getByText("Bereit")).toBeInTheDocument();
	});

	it("maps a CONFLICT / FAILED pm-sync status to the destructive tone", () => {
		const conflict = render(<TestCaseStatusChip status="CONFLICT" />);
		expect(
			conflict.container.querySelector(".bg-destructive"),
		).not.toBeNull();
		conflict.unmount();

		const failed = render(<TestCaseStatusChip status="FAILED" />);
		expect(
			failed.container.querySelector(".bg-destructive"),
		).not.toBeNull();
	});
});
