import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ExecutionStatusBadge } from "../ExecutionStatusBadge";

describe("ExecutionStatusBadge", () => {
	it("renders a 'Cancelled' label for CANCELLED", () => {
		render(<ExecutionStatusBadge status="CANCELLED" />);
		expect(screen.getByText("Cancelled")).toBeInTheDocument();
	});

	it("renders the existing labels for the other statuses", () => {
		const { rerender } = render(
			<ExecutionStatusBadge status="COMPLETED" />,
		);
		expect(screen.getByText("Completed")).toBeInTheDocument();

		rerender(<ExecutionStatusBadge status="RUNNING" />);
		expect(screen.getByText("Running")).toBeInTheDocument();

		rerender(<ExecutionStatusBadge status="FAILED" />);
		expect(screen.getByText("Failed")).toBeInTheDocument();

		rerender(<ExecutionStatusBadge status="PENDING" />);
		expect(screen.getByText("Pending")).toBeInTheDocument();
	});
});
