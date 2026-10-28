import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatFailureNotice } from "../shared/ChatFailureNotice";

vi.mock("@/components/ai-elements/response", () => ({
	Response: ({ children }: { children: React.ReactNode }) => (
		<div>{children}</div>
	),
}));

describe("ChatFailureNotice", () => {
	it("keeps the partial answer outside the failure alert", () => {
		render(
			<ChatFailureNotice
				content="Partial answer"
				error="Connection interrupted"
			/>,
		);
		expect(screen.getByText("Partial answer")).toBeVisible();
		expect(screen.getByRole("alert")).toHaveTextContent(
			"Connection interrupted",
		);
		expect(screen.getByRole("alert")).not.toHaveTextContent(
			"Partial answer",
		);
	});
	it("does not repeat legacy error-only content", () => {
		render(
			<ChatFailureNotice
				content="Error: Connection interrupted"
				error="Connection interrupted"
			/>,
		);
		expect(screen.getAllByText(/Connection interrupted/)).toHaveLength(1);
	});
});
