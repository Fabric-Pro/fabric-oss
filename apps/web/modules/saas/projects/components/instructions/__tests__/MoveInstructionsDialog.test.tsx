/**
 * "Move these instructions into a repository" (Fizzy #2878 §9): the dialog
 * that starts the move of an upload project's published files into a
 * repository connected to it, as one pull request. Copy is the real `en.json`.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositorySyncIntegration } from "../../../lib/instructions-repository-sync";

vi.mock("next-intl", async () =>
	(await import("../../../__tests__/en-copy")).nextIntlMock(),
);

const m = vi.hoisted(() => ({
	migrate: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
	toast: {
		success: (...a: unknown[]) => m.toastSuccess(...a),
		error: (...a: unknown[]) => m.toastError(...a),
		info: vi.fn(),
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			instructions: {
				repositorySync: {
					migrate: {
						mutationOptions: (
							opts: Record<string, unknown> = {},
						) => ({
							mutationFn: (input: unknown) => m.migrate(input),
							...opts,
						}),
					},
				},
			},
		},
	},
}));

import { MoveInstructionsDialog } from "../MoveInstructionsDialog";

const FIRST: RepositorySyncIntegration = {
	id: "int_1",
	provider: "GITHUB",
	repositoryOwner: "example-org",
	repositoryName: "instructions",
	defaultBranch: "develop",
};
const SECOND: RepositorySyncIntegration = {
	id: "int_2",
	provider: "AZURE_DEVOPS",
	repositoryOwner: "example-org",
	repositoryName: "agents",
	defaultBranch: "trunk",
};

function Providers({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

function renderDialog(integrations = [FIRST]) {
	const onStarted = vi.fn();
	const onOpenChange = vi.fn();
	render(
		<MoveInstructionsDialog
			projectId="proj_1"
			open
			onOpenChange={onOpenChange}
			integrations={integrations}
			onStarted={onStarted}
		/>,
		{ wrapper: Providers },
	);
	return { onStarted, onOpenChange };
}

function refusal(
	code: string,
	data: Record<string, unknown>,
	message = "TEXT THAT MUST NOT BE SHOWN",
) {
	return Object.assign(new Error(message), { code, data });
}

beforeEach(() => {
	for (const fn of Object.values(m)) {
		fn.mockReset();
	}
	m.migrate.mockResolvedValue({
		state: "PROPOSING",
		branchId: "branch_1",
		snapshotId: "snap_1",
	});
});

describe("MoveInstructionsDialog", () => {
	it("says in one sentence what happens before anything is chosen", () => {
		renderDialog();

		expect(
			screen.getByText(
				"Fabric opens one pull request with the published files, and the project switches to syncing from that folder once it merges; until then the instructions stay as published.",
			),
		).toBeInTheDocument();
	});

	it("starts with the repository's default branch and the repository root", () => {
		renderDialog();

		expect(screen.getByLabelText("Branch")).toHaveValue("develop");
		expect(screen.getByLabelText("Folder")).toHaveValue("");
		expect(
			screen.getByText("example-org/instructions"),
		).toBeInTheDocument();
	});

	it("starts the move with the chosen branch and folder, then reports and closes", async () => {
		const user = userEvent.setup();
		const { onStarted, onOpenChange } = renderDialog();

		await user.clear(screen.getByLabelText("Branch"));
		await user.type(screen.getByLabelText("Branch"), "main");
		await user.type(
			screen.getByLabelText("Folder"),
			"  docs\\instructions/  ",
		);
		await user.click(
			screen.getByRole("button", { name: "Open pull request" }),
		);

		await waitFor(() =>
			expect(m.migrate).toHaveBeenCalledWith({
				projectId: "proj_1",
				repositoryIntegrationId: "int_1",
				ref: "main",
				rootPath: "docs/instructions",
			}),
		);
		await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(1));
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(m.toastSuccess).toHaveBeenCalledWith(
			"Fabric is preparing the pull request.",
		);
	});

	it("lets the member choose among several repositories and follows the choice's default branch", async () => {
		const user = userEvent.setup();
		renderDialog([FIRST, SECOND]);

		await user.click(screen.getByRole("combobox", { name: "Repository" }));
		await user.click(
			await screen.findByRole("option", {
				name: /Azure DevOps · example-org\/agents/,
			}),
		);

		expect(screen.getByLabelText("Branch")).toHaveValue("trunk");
	});

	it("cannot be started without a branch", async () => {
		const user = userEvent.setup();
		renderDialog();

		await user.clear(screen.getByLabelText("Branch"));

		expect(
			screen.getByRole("button", { name: "Open pull request" }),
		).toBeDisabled();
	});

	it("is not started twice while the first start is in flight", async () => {
		const user = userEvent.setup();
		let finish: (value: unknown) => void = () => {};
		m.migrate.mockReturnValue(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		const { onOpenChange } = renderDialog();

		await user.click(
			screen.getByRole("button", { name: "Open pull request" }),
		);

		expect(
			screen.getByRole("button", { name: "Open pull request" }),
		).toBeDisabled();
		await user.keyboard("{Escape}");
		expect(onOpenChange).not.toHaveBeenCalledWith(false);
		finish({ state: "PROPOSING", branchId: null, snapshotId: "s" });
	});
});

describe("MoveInstructionsDialog when the server refuses", () => {
	async function submitRefused(error: Error, folder = "docs/instructions") {
		const user = userEvent.setup();
		m.migrate.mockRejectedValue(error);
		const rendered = renderDialog();
		if (folder !== "") {
			await user.type(screen.getByLabelText("Folder"), folder);
		}
		await user.click(
			screen.getByRole("button", { name: "Open pull request" }),
		);
		return rendered;
	}

	it("says a folder that already has files cannot be used, beside the folder field", async () => {
		const { onStarted } = await submitRefused(
			refusal("CONFLICT", { reason: "FOLDER_NOT_EMPTY" }),
		);

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(
			"That folder already has files on this branch. Choose a folder that doesn't exist yet or has no files.",
		);
		expect(screen.getByLabelText("Folder")).toHaveAttribute(
			"aria-invalid",
			"true",
		);
		expect(alert).not.toHaveTextContent("MUST NOT BE SHOWN");
		expect(onStarted).not.toHaveBeenCalled();
	});

	it("says the repository root cannot be used when its files are in the way", async () => {
		await submitRefused(
			refusal("CONFLICT", { reason: "FOLDER_NOT_EMPTY" }),
			"",
		);

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"The repository already has files where these instructions would go. Choose a folder instead.",
		);
	});

	it.each([
		[
			"SYNC_CONFIGURED",
			"CONFLICT",
			"This project already has a repository sync set up. Switch it to upload mode first, then try again.",
		],
		[
			"NOTHING_PUBLISHED",
			"NOT_FOUND",
			"There are no published instructions to move yet.",
		],
		[
			"NOT_UPLOAD_SOURCED",
			"PRECONDITION_FAILED",
			"These instructions already come from a repository.",
		],
		[
			"MIGRATION_CANCELED",
			"CONFLICT",
			"The move was canceled while it was being prepared. Try again.",
		],
		[
			"ATTRIBUTION_REJECTED",
			"UNPROCESSABLE_CONTENT",
			"Your name can't be used as the author of a commit, so the move was not started.",
		],
	])("says %s in a plain sentence", async (reason, code, sentence) => {
		await submitRefused(refusal(code, { reason }));

		expect(await screen.findByRole("alert")).toHaveTextContent(sentence);
	});

	it("names the branch when the repository has no such branch", async () => {
		await submitRefused(refusal("NOT_FOUND", { code: "BRANCH_NOT_FOUND" }));

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("develop");
		expect(screen.getByLabelText("Branch")).toHaveAttribute(
			"aria-invalid",
			"true",
		);
	});

	it("says a move is already open in the shared sentence", async () => {
		await submitRefused(refusal("CONFLICT", { reason: "MIGRATION_OPEN" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			/^Moving to the repository: the pull request is still being prepared\./,
		);
	});

	it("toasts the generic line for a failure it does not know, never the server's text", async () => {
		await submitRefused(refusal("INTERNAL_SERVER_ERROR", {}));

		await waitFor(() =>
			expect(m.toastError).toHaveBeenCalledWith(
				"That didn't work. Try again.",
			),
		);
	});

	it("keeps the dialog open and lets the member try again after a refusal", async () => {
		const user = userEvent.setup();
		const { onOpenChange } = await submitRefused(
			refusal("CONFLICT", { reason: "FOLDER_NOT_EMPTY" }),
		);
		await screen.findByRole("alert");

		await user.type(screen.getByLabelText("Folder"), "-two");

		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(onOpenChange).not.toHaveBeenCalledWith(false);
		expect(
			within(screen.getByRole("dialog")).getByRole("button", {
				name: "Open pull request",
			}),
		).toBeEnabled();
	});
});
