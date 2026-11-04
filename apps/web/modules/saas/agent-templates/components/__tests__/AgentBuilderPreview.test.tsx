import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ preview: vi.fn() }));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { agents: { previewDraft: h.preview } },
}));
vi.mock("../../../../../components/ai-elements/response", () => ({
	Response: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { AgentBuilderPreview } from "../AgentBuilderPreview";

const props = {
	organizationId: "example-org",
	instructions: "Answer with an example",
	expectedOutput: "A concise answer",
};
const wrapper = ({ children }: { children: ReactNode }) => (
	<QueryClientProvider
		client={
			new QueryClient({
				defaultOptions: {
					queries: { retry: false },
					mutations: { retry: false },
				},
			})
		}
	>
		{children}
	</QueryClientProvider>
);
beforeEach(() => {
	h.preview.mockReset();
});
it("runs only an explicit instruction test using the current draft and organization", async () => {
	h.preview.mockResolvedValue({ success: true, response: "Example output" });
	const v = render(<AgentBuilderPreview {...props} />, { wrapper });
	expect(h.preview).not.toHaveBeenCalled();
	expect(
		v.getByText(/excludes tools, knowledge, skills, and goal loops/),
	).toBeInTheDocument();
	fireEvent.change(v.getByLabelText("Test message"), {
		target: { value: "Try this" },
	});
	fireEvent.click(v.getByRole("button", { name: "Test instructions" }));
	await v.findByText("Example output");
	expect(h.preview).toHaveBeenCalledExactlyOnceWith({
		organizationId: "example-org",
		systemPrompt: props.instructions,
		userMessage: "Try this",
		capabilityIds: [],
		mcpConfigIds: [],
		maxIterations: 1,
	});
	v.rerender(
		<AgentBuilderPreview {...props} instructions="A different draft" />,
	);
	expect(v.getByText("Result from earlier instructions")).toBeInTheDocument();
	expect(h.preview).toHaveBeenCalledTimes(1);
});
it("keeps provider failures out of the interface and offers deliberate retry", async () => {
	h.preview.mockRejectedValue(new Error("private provider details"));
	const v = render(<AgentBuilderPreview {...props} />, { wrapper });
	fireEvent.change(v.getByLabelText("Test message"), {
		target: { value: "Try" },
	});
	fireEvent.click(v.getByRole("button", { name: "Test instructions" }));
	await v.findByText("Preview could not complete");
	expect(v.queryByText("private provider details")).not.toBeInTheDocument();
	await waitFor(() =>
		expect(
			v.getByRole("button", { name: "Test instructions" }),
		).toBeEnabled(),
	);
	expect(h.preview).toHaveBeenCalledTimes(1);
});
it("does not silently execute the saved agent and keeps its link separate", () => {
	const v = render(
		<AgentBuilderPreview
			{...props}
			savedAgentHref="/app/example-org/agents?agentId=example-agent&agentView=new"
		/>,
		{ wrapper },
	);
	expect(
		v.getByRole("link", { name: /Run the saved agent/ }),
	).toHaveAttribute("target", "_blank");
	expect(h.preview).not.toHaveBeenCalled();
});
