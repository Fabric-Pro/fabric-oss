import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	success: vi.fn(),
	error: vi.fn(),
	warning: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: m }));

import { TextToWorkflow } from "../TextToWorkflow";

beforeEach(() => vi.clearAllMocks());
it("applies a generated draft without saving, publishing or executing it", async () => {
	const draft = { action: "replace", nodes: [], edges: [] };
	const apply = vi.fn();
	const fetcher = vi
		.fn()
		.mockResolvedValue({ ok: true, json: async () => draft });
	vi.stubGlobal("fetch", fetcher);
	render(
		<TextToWorkflow
			inline
			organizationId="example-org"
			onWorkflowGenerated={apply}
		/>,
	);
	fireEvent.change(screen.getByLabelText("Describe your workflow"), {
		target: { value: "Create a release briefing workflow" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Generate" }));
	await waitFor(() => expect(apply).toHaveBeenCalledWith(draft));
	expect(fetcher).toHaveBeenCalledTimes(1);
	expect(fetcher.mock.calls[0][0]).toBe("/api/ai/generate-workflow");
	expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({
		mode: "create",
		organizationId: "example-org",
	});
});
it("keeps user edits when an AI result arrives for an older graph", async () => {
	let finish!: (x: unknown) => void;
	const apply = vi.fn();
	vi.stubGlobal(
		"fetch",
		vi.fn(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		),
	);
	const props = {
		inline: true,
		organizationId: "example-org",
		onWorkflowGenerated: apply,
	};
	const view = render(<TextToWorkflow {...props} />);
	fireEvent.change(screen.getByLabelText("Describe your workflow"), {
		target: { value: "Create a release briefing workflow" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Generate" }));
	view.rerender(
		<TextToWorkflow
			{...props}
			currentNodes={[
				{
					id: "example-step",
					type: "trigger",
					position: { x: 0, y: 0 },
					data: { label: "New user edit" },
				},
			]}
		/>,
	);
	finish({
		ok: true,
		json: async () => ({ action: "replace", nodes: [], edges: [] }),
	});
	await waitFor(() => expect(m.warning).toHaveBeenCalled());
	expect(apply).not.toHaveBeenCalled();
});
