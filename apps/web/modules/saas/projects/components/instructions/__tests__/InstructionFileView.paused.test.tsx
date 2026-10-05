/**
 * The file view while the project's uploaded instructions are being moved into
 * a repository (Fizzy #2878 §9): the server refuses every edit, so Edit,
 * Rename and Delete stay on the page but say why they do nothing, in the same
 * sentence a refused action gives. Pressing one never opens the editor or asks
 * for a confirmation.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openFileActions } from "./file-actions-menu";

vi.mock("next-intl", async () =>
	(await import("../../../__tests__/en-copy")).nextIntlMock(),
);

const mocks = vi.hoisted(() => ({
	confirm: vi.fn(),
	toastInfo: vi.fn(),
	toastError: vi.fn(),
	toastSuccess: vi.fn(),
	save: vi.fn(),
}));

vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: mocks.confirm }),
}));
vi.mock("sonner", () => ({
	toast: {
		info: (...a: unknown[]) => mocks.toastInfo(...a),
		error: (...a: unknown[]) => mocks.toastError(...a),
		success: (...a: unknown[]) => mocks.toastSuccess(...a),
	},
}));
vi.mock("@saas/projects/lib/edit-snapshot", () => ({
	editInstructionSnapshot: (...a: unknown[]) => mocks.save(...a),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { projects: { instructions: { commitChange: vi.fn() } } },
}));

const TEXT_FILE = {
	path: ".claude/skills/review/SKILL.md",
	kind: "SKILL",
	name: "review",
	description: "Reviews a change.",
	size: 120,
	mimeType: "text/markdown",
	isText: true,
	mode: null,
	body: "# Review\nOriginal body.",
	offset: 0,
	nextOffset: null,
	truncated: false,
	url: null,
};

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			instructions: {
				getFile: {
					queryOptions: (o: unknown) => ({
						queryKey: ["getFile", o],
						queryFn: async () => TEXT_FILE,
					}),
				},
				get: {
					queryOptions: (o: unknown) => ({
						queryKey: ["get", o],
						queryFn: async () => ({}),
					}),
				},
				proposals: {
					myBranch: {
						queryOptions: (o: unknown) => ({
							queryKey: ["myBranch", o],
							queryFn: async () => ({
								branch: null,
								liveChanges: 0,
								files: [],
								branches: [],
							}),
						}),
					},
					myBranchFile: {
						queryOptions: (o: unknown) => ({
							queryKey: ["myBranchFile", o],
							queryFn: async () => ({}),
						}),
					},
					getPullRequestStatus: {
						queryOptions: (o: unknown) => ({
							queryKey: ["getPullRequestStatus", o],
							queryFn: async () => ({
								pullRequest: { url: null },
							}),
						}),
					},
				},
			},
		},
	},
}));

import { InstructionFileView } from "../InstructionFileView";

const REASON =
	"Moving to example-org/instructions: pull request #12 is open. Changes are paused until it is merged and synced, or the move is canceled.";

function TestQueryProvider({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

function renderView(
	props: Partial<React.ComponentProps<typeof InstructionFileView>> = {},
) {
	render(
		<InstructionFileView
			projectId="p"
			snapshotId="s7"
			path={TEXT_FILE.path}
			canEdit
			existingPaths={new Set([TEXT_FILE.path])}
			onChanged={vi.fn()}
			{...props}
		/>,
		{ wrapper: TestQueryProvider },
	);
}

beforeEach(() => {
	for (const fn of Object.values(mocks)) {
		fn.mockReset();
	}
});

describe("InstructionFileView while a move into a repository is open", () => {
	it("keeps Edit on the page but disabled, and says why when it is pressed", async () => {
		const user = userEvent.setup();
		renderView({ pausedReason: REASON });

		const edit = await screen.findByRole("button", { name: "Edit" });
		await user.click(edit);

		expect(edit).toHaveAttribute("aria-disabled", "true");
		expect(mocks.toastInfo).toHaveBeenCalledWith(REASON);
		expect(
			screen.queryByRole("textbox", { name: /^Contents of/ }),
		).not.toBeInTheDocument();
	});

	it("does not ask to delete the file, and says why instead", async () => {
		const user = userEvent.setup();
		renderView({ pausedReason: REASON });

		await screen.findByRole("button", { name: "Edit" });
		await openFileActions(user);
		const del = await screen.findByRole("menuitem", {
			name: "Delete file",
		});
		expect(del).toHaveAttribute("aria-disabled", "true");
		await user.click(del);

		expect(mocks.confirm).not.toHaveBeenCalled();
		expect(mocks.save).not.toHaveBeenCalled();
		expect(mocks.toastInfo).toHaveBeenCalledWith(REASON);
	});

	it("does not rename a file of the synced branch while paused", async () => {
		const user = userEvent.setup();
		renderView({
			pausedReason: REASON,
			canEdit: false,
			canCommit: true,
			repositoryTarget: {
				repository: "example-org/instructions",
				ref: "main",
			},
		});

		await screen.findByRole("button", { name: "Edit" });
		await openFileActions(user);
		const rename = await screen.findByRole("menuitem", { name: "Rename" });
		expect(rename).toHaveAttribute("aria-disabled", "true");
		await user.click(rename);

		expect(
			screen.queryByRole("dialog", { name: /Rename/ }),
		).not.toBeInTheDocument();
		expect(mocks.toastInfo).toHaveBeenCalledWith(REASON);
	});

	it("still offers every action when nothing is moving", async () => {
		const user = userEvent.setup();
		renderView();

		const edit = await screen.findByRole("button", { name: "Edit" });
		await user.click(edit);

		expect(edit).not.toHaveAttribute("aria-disabled");
		expect(mocks.toastInfo).not.toHaveBeenCalled();
		expect(
			await screen.findByRole("textbox", { name: /^Contents of/ }),
		).toBeInTheDocument();
	});
});
