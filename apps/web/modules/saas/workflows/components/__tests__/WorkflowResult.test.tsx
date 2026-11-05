import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { WorkflowResult } from "../editor/WorkflowResult";

it("renders actual AI headings and tables, and preserves exact raw output for copying", async () => {
	const output = {
		text: "### Action plan\n\n| Action | Owner |\n|---|---|\n| Review tests | Not assigned |",
		tokens: 12,
	};
	const writeText = vi.fn().mockResolvedValue(undefined);
	Object.defineProperty(navigator, "clipboard", {
		value: { writeText },
		configurable: true,
	});
	render(<WorkflowResult output={output} nodeType="ai-generate-text" />);
	expect(screen.getByRole("heading", { name: "Action plan" })).toBeVisible();
	expect(screen.getByRole("table")).toHaveTextContent("Not assigned");
	fireEvent.click(screen.getByRole("button", { name: "Copy result" }));
	await waitFor(() => expect(writeText).toHaveBeenCalledWith(output.text));
	fireEvent.mouseDown(screen.getByRole("tab", { name: "Raw output" }), {
		button: 0,
	});
	fireEvent.click(screen.getByRole("tab", { name: "Raw output" }));
	await waitFor(() =>
		expect(screen.getByLabelText("Raw step output")).toBeVisible(),
	);
	fireEvent.click(screen.getByRole("button", { name: "Copy result" }));
	await waitFor(() =>
		expect(writeText).toHaveBeenLastCalledWith(
			JSON.stringify(output, null, 2),
		),
	);
});
it("keeps HTML inert, removes remote images and rejects unsafe links", () => {
	const { container } = render(
		<WorkflowResult
			output={
				"<script>alert(1)</script>\n\n![secret](https://example.com/track)\n\n[unsafe](javascript:alert(1))"
			}
		/>,
	);
	expect(container.querySelector("script")).toBeNull();
	expect(container.querySelector("img")).toBeNull();
	expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
});
it("keeps structured connector output as JSON", () => {
	render(
		<WorkflowResult
			output={{ rows: [{ ok: true }] }}
			nodeType="http-request"
		/>,
	);
	expect(screen.getByRole("tabpanel")).toHaveTextContent('"ok": true');
});

it("formats and copies the full recorded agent Markdown rather than its truncated excerpt", async () => {
	const writeText = vi.fn().mockResolvedValue(undefined);
	Object.defineProperty(navigator, "clipboard", {
		value: { writeText },
		configurable: true,
	});
	render(
		<WorkflowResult
			output={{
				text: "short excerpt",
				markdown: "# Complete report\n\nAll recorded findings.",
			}}
			nodeType="agent-task"
		/>,
	);
	expect(
		screen.getByRole("heading", { name: "Complete report" }),
	).toBeVisible();
	fireEvent.click(screen.getByRole("button", { name: "Copy result" }));
	await waitFor(() =>
		expect(writeText).toHaveBeenCalledWith(
			"# Complete report\n\nAll recorded findings.",
		),
	);
});

it("copies the visible JSON for a non-text connector even if it has a text property", async () => {
	const writeText = vi.fn().mockResolvedValue(undefined);
	Object.defineProperty(navigator, "clipboard", {
		value: { writeText },
		configurable: true,
	});
	const output = { text: "summary", status: 200 };
	render(<WorkflowResult output={output} nodeType="http-request" />);
	fireEvent.click(screen.getByRole("button", { name: "Copy result" }));
	await waitFor(() =>
		expect(writeText).toHaveBeenCalledWith(JSON.stringify(output, null, 2)),
	);
});
