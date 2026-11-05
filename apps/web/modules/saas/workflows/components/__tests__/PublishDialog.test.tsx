vi.mock("../WorkflowReadiness", () => ({
	WorkflowReadiness: () => (
		<section aria-label="Workflow configuration check" />
	),
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ publish: vi.fn(), unpublish: vi.fn() }));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		workflows: {
			publish: { publish: mocks.publish, unpublish: mocks.unpublish },
		},
	},
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		workflows: {
			get: {
				key: ({ input }: { input: unknown }) => ["workflow-get", input],
			},
			list: { key: () => ["workflow-list"] },
		},
	},
}));

import { PublishDialog } from "../PublishDialog";

const props = {
	open: true,
	onOpenChange: vi.fn(),
	workflowId: "workflow-example",
	organizationId: "org-example",
	workflowName: "Example",
	currentVersion: 1,
	status: "DRAFT" as const,
};
function show(status: "DRAFT" | "PUBLISHED" = "DRAFT") {
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false } },
	});
	const invalidated = vi.spyOn(client, "invalidateQueries");
	const changed = vi.fn();
	render(
		<QueryClientProvider client={client}>
			<PublishDialog {...props} status={status} onPublished={changed} />
		</QueryClientProvider>,
	);
	return { invalidated, changed };
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.publish.mockResolvedValue({
		success: true,
		version: 2,
		validation: { errors: [] },
	});
	mocks.unpublish.mockResolvedValue({ success: true });
});
describe("workflow publishing commands", () => {
	it("publishes under the explicit organization and invalidates the actual get and list query keys", async () => {
		const { invalidated, changed } = show();
		fireEvent.click(
			screen.getByRole("button", { name: "Publish", exact: true }),
		);
		await waitFor(() =>
			expect(mocks.publish).toHaveBeenCalledWith({
				workflowId: "workflow-example",
				organizationId: "org-example",
				changelog: undefined,
				enableWebhook: false,
			}),
		);
		await waitFor(() => expect(changed).toHaveBeenCalledOnce());
		expect(invalidated).toHaveBeenCalledWith({
			queryKey: [
				"workflow-get",
				{ id: "workflow-example", organizationId: "org-example" },
			],
		});
		expect(invalidated).toHaveBeenCalledWith({
			queryKey: ["workflow-list"],
		});
	});
	it("shows a refused publish as validation errors instead of success", async () => {
		mocks.publish.mockResolvedValue({
			success: false,
			validation: { errors: ["Workflow has no nodes"] },
		});
		const { changed } = show();
		fireEvent.click(
			screen.getByRole("button", { name: "Publish", exact: true }),
		);
		expect(
			await screen.findByText("Workflow has no nodes"),
		).toBeInTheDocument();
		expect(
			screen.queryByText("Workflow Published!"),
		).not.toBeInTheDocument();
		expect(changed).not.toHaveBeenCalled();
	});
	it("unpublishes in the same organization and refreshes the displayed status", async () => {
		vi.spyOn(window, "confirm").mockReturnValue(true);
		const { changed } = show("PUBLISHED");
		fireEvent.click(screen.getByRole("button", { name: "Unpublish" }));
		await waitFor(() =>
			expect(mocks.unpublish).toHaveBeenCalledWith({
				workflowId: "workflow-example",
				organizationId: "org-example",
			}),
		);
		await waitFor(() => expect(changed).toHaveBeenCalledOnce());
		vi.restoreAllMocks();
	});
});
