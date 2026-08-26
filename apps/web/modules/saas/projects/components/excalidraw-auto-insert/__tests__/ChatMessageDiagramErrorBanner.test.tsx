/**
 * Tests for `<ChatMessageDiagramErrorBanner />` (D6 / spec § 8.4, § 14.5,
 * FR-10).
 *
 * Coverage:
 *   - Renders the FR-10 message with both `docName` and `projectName`
 *     substitutions in the visible text.
 *   - Wraps the message in `role="status"` + `aria-live="polite"` so
 *     screen readers announce it without interrupting.
 *   - Retry button is a real `<button>` with the spec's label string;
 *     keyboard reachable (Tab focuses it).
 *   - Clicking Retry invokes `onRetry`.
 *   - Token classes live on the wrapper -- `border-destructive/40` and
 *     `bg-destructive/5` per § 14.5 (no hardcoded hex anywhere).
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

// Translate-by-key mock so visible-text assertions can match on the
// final substituted English copy without booting the real next-intl
// provider. Matches the `apps/web` precedent of in-test KEY_MAP mocks.
vi.mock("next-intl", () => ({
	useTranslations: () => {
		const t = (key: string, values?: Record<string, string>) => {
			if (key === "bannerEditorFailure") {
				return `Saved to ${values?.projectName} diagrams — couldn't add it to ${values?.docName}.`;
			}
			if (key === "bannerEditorFailureRetry") {
				return "Retry";
			}
			return key;
		};
		return t;
	},
}));

const { ChatMessageDiagramErrorBanner } = await import(
	"../ChatMessageDiagramErrorBanner"
);

describe("ChatMessageDiagramErrorBanner -- D6 / spec § 8.4", () => {
	it("renders the FR-10 message with both names substituted", () => {
		render(
			<ChatMessageDiagramErrorBanner
				docName="Architecture spec"
				projectName="Atlas"
				onRetry={() => {}}
			/>,
		);

		expect(
			screen.getByText(
				/Saved to Atlas diagrams — couldn't add it to Architecture spec\./,
			),
		).toBeInTheDocument();
	});

	it("wraps the message in role=status + aria-live=polite", () => {
		render(
			<ChatMessageDiagramErrorBanner
				docName="Spec"
				projectName="Atlas"
				onRetry={() => {}}
			/>,
		);

		const region = screen.getByRole("status");
		expect(region).toHaveAttribute("aria-live", "polite");
	});

	it("renders Retry as a real keyboard-reachable button", async () => {
		const user = userEvent.setup();
		render(
			<ChatMessageDiagramErrorBanner
				docName="Spec"
				projectName="Atlas"
				onRetry={() => {}}
			/>,
		);

		const retry = screen.getByRole("button", { name: /retry/i });
		expect(retry).toBeInTheDocument();

		// Verify keyboard focusability without competing against the user-agent
		// tab order: ghost-variant Button has no `tabindex` override and the
		// element is the only focusable item in the banner.
		await user.tab();
		expect(retry).toHaveFocus();
	});

	it("invokes onRetry when the Retry button is clicked", async () => {
		const user = userEvent.setup();
		const onRetry = vi.fn();
		render(
			<ChatMessageDiagramErrorBanner
				docName="Spec"
				projectName="Atlas"
				onRetry={onRetry}
			/>,
		);

		await user.click(screen.getByRole("button", { name: /retry/i }));
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("applies the spec-mandated destructive token classes to the wrapper", () => {
		// Spec § 14.5: tokens via CSS variables -- `border-destructive/40` and
		// `bg-destructive/5`. The class strings must be present so the
		// design-token contract is preserved (no hardcoded hex anywhere).
		render(
			<ChatMessageDiagramErrorBanner
				docName="Spec"
				projectName="Atlas"
				onRetry={() => {}}
			/>,
		);

		const region = screen.getByRole("status");
		expect(region.className).toContain("border-destructive/40");
		expect(region.className).toContain("bg-destructive/5");
		expect(region.className).toContain("text-destructive");
	});
});
