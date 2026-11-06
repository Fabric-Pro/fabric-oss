import { ORPCError } from "@orpc/client";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

const { create, error } = vi.hoisted(() => ({
	create: vi.fn(),
	error: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { projects: { contexts: { create } } },
}));
vi.mock("sonner", () => ({ toast: { error, success: vi.fn() } }));
vi.mock("../../lib/notion-content-fetcher", () => ({
	fetchNotionPageContent: vi.fn().mockResolvedValue({
		content: "",
		title: "Example",
		contentFetchFailed: true,
	}),
}));
vi.mock("../NotionPageSelector", () => ({
	NotionPageSelector: ({
		onConfirm,
	}: {
		onConfirm: (pages: unknown[]) => void;
	}) => (
		<button
			type="button"
			onClick={() =>
				onConfirm([
					{ pageId: "empty-example", title: "Empty example" },
					{ pageId: "readable-example", title: "Readable example" },
				])
			}
		>
			Confirm
		</button>
	),
}));

import { NotionResourceBrowser } from "../NotionResourceBrowser";

it("names a rejected page and continues with the next page", async () => {
	create
		.mockRejectedValueOnce(
			new ORPCError("BAD_REQUEST", {
				data: { reason: "NOTION_EMPTY_CONTENT" },
				message:
					"Fabric could not read any content from this Notion page",
			}),
		)
		.mockResolvedValue({});
	render(
		<NotionResourceBrowser
			open
			onOpenChange={vi.fn()}
			mcpConfigId="mcp-example"
			projectId="project-example"
			organizationId="example-org"
		/>,
	);
	await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
	await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
	expect(error).toHaveBeenCalledWith('Could not add "Empty example"', {
		description: "Fabric could not read any content from this Notion page.",
	});
});
