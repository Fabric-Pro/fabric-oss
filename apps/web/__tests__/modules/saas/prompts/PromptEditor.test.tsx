/**
 * Fizzy #2250 (defect 3): an empty or over-limit prompt body disabled Save
 * with no visible or programmatically associated message — a screen-reader
 * user got no explanation, and a sighted user saw only that the button had
 * stopped responding.
 *
 * Guards:
 *   - a cleared, whitespace-only, or over-length body renders a `role="alert"`
 *     message and marks the textarea `aria-invalid` + `aria-describedby`
 *     pointing at it;
 *   - Save stays disabled in each case;
 *   - a valid body shows no alert and leaves the textarea valid.
 */

import { PromptEditor } from "@saas/prompts/components/PromptEditor";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const initialData = {
	name: "Agenda generator",
	description: "Drafts a meeting agenda",
	scope: "USER" as const,
	format: "PLAIN_TEXT" as const,
	category: undefined,
	tags: [],
	isPublic: false,
	content: "Write a concise agenda for {{topic}}.",
};

function renderEditor(data = initialData) {
	const onSave = vi.fn();
	const onCancel = vi.fn();
	render(
		<PromptEditor
			initialData={data}
			onSave={onSave}
			onCancel={onCancel}
			canEditScope={false}
		/>,
	);
	return { onSave, onCancel };
}

const saveButton = () => screen.getByRole("button", { name: /Save changes/ });
const textarea = () => screen.getByLabelText("Prompt content");

describe("PromptEditor content validation", () => {
	it("shows no alert and a valid textarea for the initial, valid body", () => {
		renderEditor();

		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(textarea()).not.toHaveAttribute("aria-invalid");
		expect(textarea()).not.toHaveAttribute("aria-describedby");
	});

	it("shows the blank-body alert, associates it, and disables Save when cleared", async () => {
		const user = userEvent.setup();
		renderEditor();

		await user.clear(textarea());

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Prompt content cannot be empty");
		expect(textarea()).toHaveAttribute("aria-invalid", "true");
		expect(textarea()).toHaveAttribute("aria-describedby", alert.id);
		expect(saveButton()).toBeDisabled();
	});

	it("shows the same alert for a whitespace-only body", async () => {
		const user = userEvent.setup();
		renderEditor();

		await user.clear(textarea());
		await user.type(textarea(), "   \n\t  ");

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Prompt content cannot be empty");
		expect(saveButton()).toBeDisabled();
	});

	it("shows the too-long alert and disables Save for a body over 50,000 characters", async () => {
		renderEditor();
		// Typing 50,001 characters through userEvent is far too slow for a unit
		// test; set the value directly and dispatch the change React listens
		// for, exactly what a paste of a huge body does.
		fireEvent.change(textarea(), {
			target: { value: "x".repeat(50_001) },
		});

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(
			"Prompt content is 50,001 characters; the maximum is 50,000.",
		);
		expect(textarea()).toHaveAttribute("aria-invalid", "true");
		expect(textarea()).toHaveAttribute("aria-describedby", alert.id);
		expect(saveButton()).toBeDisabled();
	});

	it("re-enables Save and clears the alert once the body is fixed", async () => {
		const user = userEvent.setup();
		renderEditor();

		await user.clear(textarea());
		expect(await screen.findByRole("alert")).toBeInTheDocument();

		await user.type(textarea(), "A valid prompt body.");

		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(textarea()).not.toHaveAttribute("aria-invalid");
	});
});

// A body saved before the limit existed can be longer than it. The server
// accepts a metadata-only save of such a prompt, so the editor must too: the
// limit applies to the body a user is saving, not to one they left alone.
describe("PromptEditor with a body already over the limit", () => {
	const legacy = { ...initialData, content: "x".repeat(60_000) };

	it("lets the prompt be renamed without touching the body", async () => {
		const user = userEvent.setup();
		const { onSave } = renderEditor(legacy);

		await user.click(screen.getByRole("button", { name: /Details/ }));
		await user.type(screen.getByLabelText("Name"), " v2");

		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(saveButton()).toBeEnabled();
		await user.click(saveButton());
		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "Agenda generator v2",
				content: legacy.content,
			}),
		);
	});

	it("still refuses an edit that leaves the body over the limit", async () => {
		renderEditor(legacy);

		fireEvent.change(textarea(), { target: { value: "y".repeat(55_000) } });

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Prompt content is 55,000 characters; the maximum is 50,000.",
		);
		expect(saveButton()).toBeDisabled();
	});
});
