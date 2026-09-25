/**
 * Fizzy #2250 (defect 3), the AI enhancer surface: an empty, blank or
 * over-length body must be refused inline — a `role="alert"` message the
 * textarea points at with `aria-describedby` — with Save disabled, instead of
 * the server's rejection arriving later as a global toast.
 *
 * The enhancer's Save always writes a new version, so the body is judged as
 * soon as it is loaded: a body saved before the length limit existed cannot be
 * saved again as-is, and the user is told why before they try.
 */

import { PromptContentEnhancer } from "@saas/prompts/components/PromptContentEnhancer";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@copilotkit/react-core", () => ({
	useCoAgent: () => ({ state: {}, setState: vi.fn(), nodeName: undefined }),
	useCopilotAction: vi.fn(),
	useCopilotChat: () => ({ isLoading: false }),
	useCopilotReadable: vi.fn(),
}));

vi.mock("@copilotkit/react-ui", () => ({
	CopilotSidebar: ({ children }: { children?: React.ReactNode }) => (
		<>{children}</>
	),
}));

vi.mock("@saas/shared/components/copilot/CopilotAssistantMessage", () => ({
	CopilotAssistantMessageForPromptEnhancer: () => null,
}));

vi.mock("@saas/shared/components/FabricLogo", () => ({
	FabricLogo: () => null,
}));

function renderEnhancer(initialContent = "Summarise the meeting notes.") {
	const onSave = vi.fn();
	render(
		<PromptContentEnhancer
			promptId="p1"
			promptName="Meeting summary"
			format="PLAIN_TEXT"
			tags={[]}
			initialContent={initialContent}
			onSave={onSave}
			onCancel={vi.fn()}
		/>,
	);
	return { onSave };
}

const textarea = () => screen.getByPlaceholderText(/prompt here/);
const saveButton = () => screen.getByRole("button", { name: /Save/ });

describe("PromptContentEnhancer content validation", () => {
	it("shows no alert and allows Save for a valid body", () => {
		renderEnhancer();

		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(textarea()).not.toHaveAttribute("aria-invalid");
		expect(saveButton()).toBeEnabled();
	});

	it("shows the blank-body alert, associates it, and disables Save when cleared", async () => {
		const user = userEvent.setup();
		const { onSave } = renderEnhancer();

		await user.clear(textarea());

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Prompt content cannot be empty");
		expect(textarea()).toHaveAttribute("aria-invalid", "true");
		expect(textarea()).toHaveAttribute("aria-describedby", alert.id);
		expect(saveButton()).toBeDisabled();
		await user.click(saveButton());
		expect(onSave).not.toHaveBeenCalled();
	});

	it("treats a body of only invisible characters as blank", () => {
		renderEnhancer();

		fireEvent.change(textarea(), { target: { value: " ​\n\t " } });

		expect(screen.getByRole("alert")).toHaveTextContent(
			"Prompt content cannot be empty",
		);
		expect(saveButton()).toBeDisabled();
	});

	it("shows the too-long alert and disables Save over 50,000 characters", () => {
		renderEnhancer();

		fireEvent.change(textarea(), { target: { value: "x".repeat(50_001) } });

		expect(screen.getByRole("alert")).toHaveTextContent(
			"Prompt content is 50,001 characters; the maximum is 50,000.",
		);
		expect(textarea()).toHaveAttribute("aria-invalid", "true");
		expect(saveButton()).toBeDisabled();
	});

	it("says up front that a body already over the limit cannot be saved as-is", () => {
		renderEnhancer("x".repeat(60_000));

		expect(screen.getByRole("alert")).toHaveTextContent(
			"Prompt content is 60,000 characters; the maximum is 50,000.",
		);
		expect(saveButton()).toBeDisabled();
	});

	it("clears the alert and re-enables Save once the body is fixed", async () => {
		const user = userEvent.setup();
		const { onSave } = renderEnhancer();

		await user.clear(textarea());
		expect(await screen.findByRole("alert")).toBeInTheDocument();
		await user.type(textarea(), "A valid prompt.");

		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		await user.click(saveButton());
		expect(onSave).toHaveBeenCalledWith("A valid prompt.");
	});
});
