/**
 * Unit tests for HITLDialog component
 */

import { HITLDialog } from "@saas/agents/components/HITLDialog";
import type { HITLRequest } from "@saas/agents/hooks/useHumanInLoop";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("HITLDialog", () => {
	const mockOnRespond = vi.fn();
	const mockOnDismiss = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
	});

	const createRequest = (
		type: "approval" | "input" | "choice",
		overrides: Partial<HITLRequest> = {},
	): HITLRequest => ({
		requestId: "test-request-id",
		type,
		prompt: "Test prompt",
		createdAt: Date.now(),
		...overrides,
	});

	describe("Approval Dialog", () => {
		it("should render approval dialog correctly", () => {
			const request = createRequest("approval", {
				title: "Confirm Action",
				prompt: "Are you sure you want to proceed?",
			});

			render(
				<HITLDialog
					request={request}
					open={true}
					onRespond={mockOnRespond}
					onDismiss={mockOnDismiss}
				/>,
			);

			expect(screen.getByText("Confirm Action")).toBeInTheDocument();
			expect(
				screen.getByText("Are you sure you want to proceed?"),
			).toBeInTheDocument();
			expect(screen.getByText("Approve")).toBeInTheDocument();
			expect(screen.getByText("Reject")).toBeInTheDocument();
		});

		it("should call onRespond with true when approved", () => {
			const request = createRequest("approval");

			render(
				<HITLDialog
					request={request}
					open={true}
					onRespond={mockOnRespond}
					onDismiss={mockOnDismiss}
				/>,
			);

			fireEvent.click(screen.getByText("Approve"));
			expect(mockOnRespond).toHaveBeenCalledWith(true);
		});

		it("should call onRespond with false when rejected", () => {
			const request = createRequest("approval");

			render(
				<HITLDialog
					request={request}
					open={true}
					onRespond={mockOnRespond}
					onDismiss={mockOnDismiss}
				/>,
			);

			fireEvent.click(screen.getByText("Reject"));
			expect(mockOnRespond).toHaveBeenCalledWith(false);
		});
	});

	describe("Input Dialog", () => {
		it("should render input dialog with text field", () => {
			const request = createRequest("input", {
				prompt: "Enter your name",
				defaultValue: "John",
			});

			render(
				<HITLDialog
					request={request}
					open={true}
					onRespond={mockOnRespond}
					onDismiss={mockOnDismiss}
				/>,
			);

			expect(screen.getByText("Enter your name")).toBeInTheDocument();
			expect(screen.getByDisplayValue("John")).toBeInTheDocument();
		});

		it("should submit input value when approved", () => {
			const request = createRequest("input");

			render(
				<HITLDialog
					request={request}
					open={true}
					onRespond={mockOnRespond}
					onDismiss={mockOnDismiss}
				/>,
			);

			const input = screen.getByPlaceholderText("Enter your response...");
			fireEvent.change(input, { target: { value: "Test input" } });
			fireEvent.click(screen.getByText("Submit"));

			expect(mockOnRespond).toHaveBeenCalledWith(true, "Test input");
		});
	});

	describe("Choice Dialog", () => {
		it("should render choice dialog with options", () => {
			const request = createRequest("choice", {
				prompt: "Select an option",
				options: [
					{
						value: "opt1",
						label: "Option 1",
						description: "First option",
					},
					{ value: "opt2", label: "Option 2" },
				],
			});

			render(
				<HITLDialog
					request={request}
					open={true}
					onRespond={mockOnRespond}
					onDismiss={mockOnDismiss}
				/>,
			);

			expect(screen.getByText("Select an option")).toBeInTheDocument();
			expect(screen.getByText("Option 1")).toBeInTheDocument();
			expect(screen.getByText("Option 2")).toBeInTheDocument();
			expect(screen.getByText("First option")).toBeInTheDocument();
		});
	});

	describe("Timeout", () => {
		it("should show timeout progress bar when timeout is set", () => {
			const request = createRequest("approval", {
				timeout: 60000,
			});

			render(
				<HITLDialog
					request={request}
					open={true}
					onRespond={mockOnRespond}
					onDismiss={mockOnDismiss}
				/>,
			);

			expect(screen.getByText("Time remaining")).toBeInTheDocument();
		});
	});

	describe("Null request", () => {
		it("should return null when request is null", () => {
			const { container } = render(
				<HITLDialog
					request={null}
					open={true}
					onRespond={mockOnRespond}
					onDismiss={mockOnDismiss}
				/>,
			);

			expect(container.firstChild).toBeNull();
		});
	});
});
