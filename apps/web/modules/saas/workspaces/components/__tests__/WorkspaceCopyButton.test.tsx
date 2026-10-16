/**
 * Making a copy of a Workspace: the person is asked first, told what the copy
 * carries, and taken to it when it is made.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	callFabricTool: vi.fn(),
	push: vi.fn(),
	toast: vi.fn(),
}));

vi.mock("@saas/mcp/lib/fabric-tool-client", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@saas/mcp/lib/fabric-tool-client")
	>()),
	callFabricTool: mocks.callFabricTool,
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: mocks.push }),
}));

vi.mock("@ui/hooks/use-toast", () => ({
	useToast: () => ({ toast: mocks.toast }),
}));

import { FabricToolError } from "@saas/mcp/lib/fabric-tool-client";
import { WorkspaceCopyButton } from "../WorkspaceCopyButton";

function renderButton(
	runtimeTools: readonly string[] = [],
	projectId?: string,
) {
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<WorkspaceCopyButton
				frameId="frame-1"
				organizationId="org-1"
				organizationSlug="example-org"
				projectId={projectId}
				runtimeTools={runtimeTools}
			/>
		</QueryClientProvider>,
	);
}

const openDialog = () =>
	fireEvent.click(screen.getByRole("button", { name: "Make a copy" }));

const confirm = () =>
	fireEvent.click(
		screen
			.getAllByRole("button", { name: /Make a copy/ })
			.find((button) =>
				button.closest('[role="alertdialog"]'),
			) as HTMLElement,
	);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.callFabricTool.mockResolvedValue({ frameId: "frame-2" });
});

describe("making a copy", () => {
	it("asks first, and calls nothing until the person says yes", () => {
		renderButton();

		openDialog();

		expect(screen.getByRole("alertdialog")).toHaveTextContent(
			"Make a copy of this workspace?",
		);
		expect(mocks.callFabricTool).not.toHaveBeenCalled();
	});

	it("copies the page with the tools it declares, which the question names, and goes to the copy", async () => {
		renderButton(["fabric_page_data_list", "fabric_page_data_set"]);

		openDialog();
		const dialog = screen.getByRole("alertdialog");
		expect(dialog).toHaveTextContent("fabric_page_data_list");
		expect(dialog).toHaveTextContent("fabric_page_data_set");
		expect(dialog).toHaveTextContent("running as the person who opens it");
		expect(dialog).not.toHaveTextContent("as whoever opens it");
		confirm();

		await waitFor(() =>
			expect(mocks.push).toHaveBeenCalledWith(
				"/app/example-org/workspaces/frame-2",
			),
		);
		expect(mocks.callFabricTool).toHaveBeenCalledWith(
			"fabric_duplicate_frame",
			{
				frameId: "frame-1",
				runtimeTools: ["fabric_page_data_list", "fabric_page_data_set"],
			},
			expect.objectContaining({ organizationId: "org-1" }),
		);
		expect(mocks.toast).toHaveBeenCalledWith({ title: "Copy made" });
	});

	it("passes no tools, and says nothing of them, for a page that declares none", async () => {
		renderButton([]);

		openDialog();
		expect(screen.getByRole("alertdialog")).not.toHaveTextContent(
			/Fabric tools/,
		);
		confirm();

		await waitFor(() => expect(mocks.push).toHaveBeenCalled());
		expect(mocks.callFabricTool.mock.calls[0][1]).toEqual({
			frameId: "frame-1",
		});
	});

	it("does nothing when the person cancels", () => {
		renderButton(["fabric_page_data_list"]);

		openDialog();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		expect(mocks.callFabricTool).not.toHaveBeenCalled();
		expect(mocks.push).not.toHaveBeenCalled();
	});

	it("says it could not be made, without the tool's id or an HTTP status, and stays where it is", async () => {
		mocks.callFabricTool.mockRejectedValue(
			new FabricToolError(
				"fabric_duplicate_frame failed with HTTP 503",
				"fabric_duplicate_frame",
			),
		);
		renderButton();

		openDialog();
		confirm();

		await waitFor(() =>
			expect(mocks.toast).toHaveBeenCalledWith({
				title: "Could not make a copy",
				description: "Please try again.",
				variant: "destructive",
			}),
		);
		expect(mocks.push).not.toHaveBeenCalled();
	});

	it("says what the tool said when it refused for a reason meant for the person", async () => {
		mocks.callFabricTool.mockRejectedValue(
			new FabricToolError(
				"Too many writes. Try again in 20 seconds.",
				"fabric_duplicate_frame",
				{ reason: "rate_limited" },
			),
		);
		renderButton();

		openDialog();
		confirm();

		await waitFor(() =>
			expect(mocks.toast).toHaveBeenCalledWith(
				expect.objectContaining({
					description: "Too many writes. Try again in 20 seconds.",
				}),
			),
		);
	});

	it("says the copy stays in the project only for a page that belongs to one", () => {
		const inProject = renderButton([], "project-1");
		openDialog();
		expect(screen.getByRole("alertdialog")).toHaveTextContent(
			"to change, in the same project.",
		);
		inProject.unmount();

		renderButton([]);
		openDialog();

		expect(screen.getByRole("alertdialog")).not.toHaveTextContent(
			/same project/,
		);
		expect(screen.getByRole("alertdialog")).toHaveTextContent(
			"You get your own copy to change.",
		);
	});

	it("names each tool in words, with its id beneath, and a connected read by what it reaches", () => {
		renderButton(["fabric_list_workflows", "connected:linear/list_issues"]);

		openDialog();

		const dialog = screen.getByRole("alertdialog");
		expect(dialog).toHaveTextContent("List workflows");
		expect(dialog).toHaveTextContent("fabric_list_workflows");
		expect(dialog).toHaveTextContent("Read list_issues from linear");
		expect(dialog).toHaveTextContent("connected:linear/list_issues");
	});

	it("scrolls inside the window", () => {
		renderButton(["fabric_list_workflows"]);

		openDialog();

		expect(screen.getByRole("alertdialog").className).toContain(
			"max-h-[90dvh]",
		);
		expect(screen.getByRole("alertdialog").className).toContain(
			"overflow-y-auto",
		);
	});

	it("is closed by Esc before a copy is started", async () => {
		renderButton();

		openDialog();
		fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });

		await waitFor(() =>
			expect(screen.queryByRole("alertdialog")).toBeNull(),
		);
		expect(mocks.callFabricTool).not.toHaveBeenCalled();
	});

	it("is not closed by Esc while the copy is being made", async () => {
		mocks.callFabricTool.mockReturnValue(new Promise(() => {}));
		renderButton();

		openDialog();
		confirm();
		await waitFor(() => expect(mocks.callFabricTool).toHaveBeenCalled());
		fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
		await new Promise((resolve) => setTimeout(resolve, 30));

		expect(screen.getByRole("alertdialog")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Making a copy/ }),
		).toBeDisabled();
	});

	it("treats an answer without the copy's id as a failure", async () => {
		mocks.callFabricTool.mockImplementation(
			async (
				_name: string,
				_args: unknown,
				options: { schema: { parse: (value: unknown) => unknown } },
			) => options.schema.parse({ title: "no id" }),
		);
		renderButton();

		openDialog();
		confirm();

		await waitFor(() =>
			expect(mocks.toast).toHaveBeenCalledWith(
				expect.objectContaining({ title: "Could not make a copy" }),
			),
		);
		expect(mocks.push).not.toHaveBeenCalled();
	});
});
