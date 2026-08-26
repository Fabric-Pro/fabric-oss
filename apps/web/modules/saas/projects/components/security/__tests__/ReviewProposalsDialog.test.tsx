import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ScanFindingReview } from "../lib";
import { ReviewProposalsDialog } from "../ReviewProposalsDialog";

beforeAll(() => {
	HTMLElement.prototype.hasPointerCapture ??= () => false;
	HTMLElement.prototype.scrollIntoView ??= () => {};
});

const TITLES: Record<string, string> = {
	"f-fp": "Plaintext password in logs",
	"f-sev": "Missing rate limit on login",
	"f-confirmed": "SQL injection in search",
	"f-uncertain": "Possible SSRF in webhook",
};

/** A review with one of each proposal kind. */
function buildReview(): ScanFindingReview {
	return {
		id: "review-1",
		status: "COMPLETED",
		reviewedCount: 4,
		proposals: [
			{
				findingId: "f-fp",
				verdict: "false_positive",
				suggestedStatus: "DISMISSED",
				reasoning: "The log line is a placeholder, not a real secret.",
				confidence: "high",
				evidenceQuote: 'password = "REDACTED"',
			},
			{
				findingId: "f-sev",
				verdict: "confirmed",
				suggestedSeverity: "HIGH",
				reasoning: "Real, but impact is higher than rated.",
				confidence: "medium",
			},
			{
				findingId: "f-confirmed",
				verdict: "confirmed",
				reasoning: "Concatenated query with user input — real.",
				confidence: "high",
			},
			{
				findingId: "f-uncertain",
				verdict: "uncertain",
				reasoning:
					"Couldn't determine if the URL is attacker-controlled.",
				confidence: "low",
			},
		],
	} as unknown as ScanFindingReview;
}

function renderDialog(overrides?: Partial<ScanFindingReview>) {
	const onApply = vi.fn();
	const review = { ...buildReview(), ...overrides } as ScanFindingReview;
	render(
		<ReviewProposalsDialog
			open
			onOpenChange={vi.fn()}
			review={review}
			getFindingTitle={(id) => TITLES[id]}
			isApplying={false}
			onApply={onApply}
		/>,
	);
	return { onApply };
}

describe("ReviewProposalsDialog", () => {
	it("uses calm, advisory copy and never auto-applies", () => {
		renderDialog();
		expect(
			screen.getByText(/suggested changes are ready for your review/i),
		).toBeInTheDocument();
	});

	it("renders every proposal with its verdict and finding title", () => {
		renderDialog();
		expect(
			screen.getByText("Plaintext password in logs"),
		).toBeInTheDocument();
		expect(screen.getByText("SQL injection in search")).toBeInTheDocument();
		expect(screen.getByText(/likely false positive/i)).toBeInTheDocument();
		// Evidence quote surfaced.
		expect(screen.getByText(/password = "REDACTED"/)).toBeInTheDocument();
	});

	it("pre-checks only the actionable proposals (dismiss + severity)", () => {
		renderDialog();
		// 2 actionable suggestions out of 4 proposals.
		expect(
			screen.getByText(/2 of 2 suggested changes selected/i),
		).toBeInTheDocument();
		// Confirmed-with-no-suggestion and uncertain rows render WITHOUT a checkbox.
		const checkboxes = screen.getAllByRole("checkbox");
		expect(checkboxes).toHaveLength(2);
	});

	it("applies only the selected decisions, mapping false_positive→DISMISSED and severity", async () => {
		const user = userEvent.setup();
		const { onApply } = renderDialog();

		await user.click(
			screen.getByRole("button", { name: /apply selected/i }),
		);

		expect(onApply).toHaveBeenCalledTimes(1);
		const decisions = onApply.mock.calls[0][0];
		expect(decisions).toHaveLength(2);
		expect(decisions).toContainEqual({
			findingId: "f-fp",
			status: "DISMISSED",
		});
		expect(decisions).toContainEqual({
			findingId: "f-sev",
			severity: "HIGH",
		});
	});

	it("excludes a proposal the user unchecks before applying", async () => {
		const user = userEvent.setup();
		const { onApply } = renderDialog();

		// Uncheck the false-positive suggestion.
		const fpCheckbox = screen.getByRole("checkbox", {
			name: /apply suggestion for plaintext password in logs/i,
		});
		await user.click(fpCheckbox);

		await user.click(
			screen.getByRole("button", { name: /apply selected/i }),
		);
		const decisions = onApply.mock.calls[0][0];
		expect(decisions).toHaveLength(1);
		expect(decisions[0]).toEqual({ findingId: "f-sev", severity: "HIGH" });
	});

	it("disables apply and shows an empty state when there are no suggestions", () => {
		renderDialog({ proposals: [] });
		expect(
			screen.getByText(/no suggestions this time/i),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /apply selected/i }),
		).toBeDisabled();
	});

	it("keeps an uncertain proposal informational (no checkbox, shown for the user to decide)", () => {
		renderDialog();
		const uncertainRow = screen
			.getByText("Possible SSRF in webhook")
			.closest("li") as HTMLElement;
		expect(
			within(uncertainRow).queryByRole("checkbox"),
		).not.toBeInTheDocument();
		expect(uncertainRow).toHaveTextContent(/couldn't tell/i);
	});
});

describe("ReviewProposalsDialog — selection toolbar", () => {
	it("shows a live 'X of Y selected' count in the toolbar (pre-checked actionable)", () => {
		renderDialog();
		// 2 actionable, both pre-checked on open.
		expect(screen.getByText("2 of 2 selected")).toBeInTheDocument();
	});

	it("Select none clears every checkbox; Select all re-checks all actionable", async () => {
		const user = userEvent.setup();
		renderDialog();

		await user.click(screen.getByRole("button", { name: /select none/i }));
		expect(screen.getByText("0 of 2 selected")).toBeInTheDocument();
		// Every actionable checkbox is now unchecked.
		for (const cb of screen.getAllByRole("checkbox")) {
			expect(cb).not.toBeChecked();
		}

		await user.click(screen.getByRole("button", { name: /select all/i }));
		expect(screen.getByText("2 of 2 selected")).toBeInTheDocument();
		for (const cb of screen.getAllByRole("checkbox")) {
			expect(cb).toBeChecked();
		}
	});

	it("Select false positives selects only the dismiss suggestions (not the severity one)", async () => {
		const user = userEvent.setup();
		const { onApply } = renderDialog();

		// One false positive (f-fp). The severity proposal (f-sev) is actionable
		// but NOT a false positive, so it's excluded.
		await user.click(
			screen.getByRole("button", {
				name: /select false positives \(1\)/i,
			}),
		);
		expect(screen.getByText("1 of 2 selected")).toBeInTheDocument();

		// Applying now sends ONLY the false-positive dismissal.
		await user.click(
			screen.getByRole("button", { name: /apply selected/i }),
		);
		const decisions = onApply.mock.calls[0][0];
		expect(decisions).toEqual([{ findingId: "f-fp", status: "DISMISSED" }]);
	});

	it("hides the toolbar entirely when there are no actionable proposals", () => {
		renderDialog({ proposals: [] });
		expect(
			screen.queryByRole("button", { name: /select all/i }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /select false positives/i }),
		).not.toBeInTheDocument();
	});

	it("hides 'Select false positives' when no proposal is a false positive", () => {
		// Only a severity suggestion — actionable, but not a dismissal.
		renderDialog({
			proposals: [
				{
					findingId: "f-sev",
					verdict: "confirmed",
					suggestedSeverity: "HIGH",
					reasoning: "Real, but impact is higher than rated.",
					confidence: "medium",
				},
			],
		} as unknown as Partial<ScanFindingReview>);
		// Select all / none still present…
		expect(
			screen.getByRole("button", { name: /select all/i }),
		).toBeInTheDocument();
		// …but no false-positive quick action.
		expect(
			screen.queryByRole("button", { name: /select false positives/i }),
		).not.toBeInTheDocument();
	});
});
