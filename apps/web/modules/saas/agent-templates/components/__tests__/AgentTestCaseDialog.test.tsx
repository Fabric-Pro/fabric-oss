import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";

const h = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn() }));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { agents: { tests: { cases: h } } },
}));

import { AgentTestCaseDialog } from "../AgentTestCaseDialog";

function wrapper({ children }: { children: ReactNode }) {
	return (
		<QueryClientProvider client={new QueryClient()}>
			{children}
		</QueryClientProvider>
	);
}
beforeEach(() => {
	vi.clearAllMocks();
	h.create.mockResolvedValue({ id: "example-case" });
});
it("saves an editable task and exact checks while retaining preview provenance", async () => {
	const onClose = vi.fn();
	const v = render(
		<AgentTestCaseDialog
			organizationId="example-org"
			instanceId="example-agent"
			initialInput="Original task"
			sourcePreview={{ workflowId: "example-preview" }}
			onClose={onClose}
		/>,
		{ wrapper },
	);
	expect(v.getByRole("button", { name: "Save test" })).toBeDisabled();
	fireEvent.change(v.getByLabelText("Test name"), {
		target: { value: "Source check" },
	});
	fireEvent.change(v.getByLabelText("Task for a new run"), {
		target: { value: "Standalone task" },
	});
	fireEvent.change(v.getByLabelText("Must include"), {
		target: { value: "Source\nEvidence" },
	});
	fireEvent.change(v.getByLabelText("Must not include"), {
		target: { value: "Invented" },
	});
	fireEvent.click(v.getByRole("button", { name: "Save test" }));
	await waitFor(() =>
		expect(h.create).toHaveBeenCalledWith({
			organizationId: "example-org",
			instanceId: "example-agent",
			sourcePreview: { workflowId: "example-preview" },
			name: "Source check",
			input: "Standalone task",
			checks: {
				requiredPhrases: ["Source", "Evidence"],
				forbiddenPhrases: ["Invented"],
			},
		}),
	);
	expect(onClose).toHaveBeenCalledTimes(1);
});
it("rejects oversized or excessive checks before a request", () => {
	const v = render(
		<AgentTestCaseDialog
			organizationId="example-org"
			instanceId="example-agent"
			initialInput="Task"
			onClose={() => undefined}
		/>,
		{ wrapper },
	);
	fireEvent.change(v.getByLabelText("Test name"), {
		target: { value: "Example test" },
	});
	fireEvent.change(v.getByLabelText("Must include"), {
		target: { value: "x".repeat(513) },
	});
	expect(v.getByRole("button", { name: "Save test" })).toBeDisabled();
	fireEvent.change(v.getByLabelText("Must include"), {
		target: {
			value: Array.from({ length: 21 }, (_, i) => `Phrase ${i}`).join(
				"\n",
			),
		},
	});
	expect(v.getByRole("button", { name: "Save test" })).toBeDisabled();
	expect(h.create).not.toHaveBeenCalled();
});

it("gives the test editor an accessible dialog name and form labels", async () => {
	const v = render(
		<AgentTestCaseDialog
			organizationId="example-org"
			instanceId="example-agent"
			onClose={() => undefined}
		/>,
		{ wrapper },
	);
	expect(
		(
			await axe(v.getByRole("dialog"), {
				rules: { "color-contrast": { enabled: false } },
			})
		).violations,
	).toEqual([]);
});
