import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { BacklogProposalsButton } from "../BacklogProposalsButton";

const backlogCount = vi.fn();

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			backlog: {
				proposals: {
					backlogCount: (...args: unknown[]) => backlogCount(...args),
				},
			},
		},
	},
}));

if (!(globalThis as { ResizeObserver?: unknown }).ResizeObserver) {
	(globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
}

beforeEach(() => {
	backlogCount.mockReset();
	backlogCount.mockResolvedValue({ count: 2 });
});

it("labels the archive control and tooltip as Rejected proposals", async () => {
	const user = userEvent.setup();
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});

	render(
		<QueryClientProvider client={client}>
			<BacklogProposalsButton
				projectId="project_1"
				organizationId={null}
				onOpenBacklog={vi.fn()}
			/>
		</QueryClientProvider>,
	);

	const button = await screen.findByRole("button", {
		name: "View rejected proposals",
	});
	await user.hover(button);

	expect(await screen.findByRole("tooltip")).toHaveTextContent(
		"Rejected proposals — recover or permanently delete dismissed proposals",
	);
});
