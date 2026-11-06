/**
 * "Delete from my branch" and "Restore published version": each confirmed
 * destructively, then sent as one `restoreMyBranchFile` call pinned to the
 * published version; and the branch panel's list of files the member's
 * branch differs on.
 */
import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

function resolve(path: string): unknown {
	return path.split(".").reduce<unknown>((node, key) => {
		return node && typeof node === "object"
			? (node as Record<string, unknown>)[key]
			: undefined;
	}, en);
}

vi.mock("next-intl", () => ({
	useTranslations:
		(namespace: string) =>
		(key: string, values?: Record<string, unknown>) => {
			const raw = resolve(`${namespace}.${key}`);
			if (typeof raw !== "string") {
				throw new Error(`missing translation: ${namespace}.${key}`);
			}
			return Object.entries(values ?? {}).reduce(
				(out, [name, value]) =>
					out.replaceAll(`{${name}}`, String(value)),
				raw,
			);
		},
}));

const state = vi.hoisted(() => ({
	restore: vi.fn(),
	answer: { operation: "delete" } as unknown,
	failure: null as Error | null,
	confirm: vi.fn(),
	invalidate: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
	listed: vi.fn(),
	branch: {
		branch: { id: "branch_1" },
		files: [] as unknown[],
	} as unknown,
	repositoryState: {
		availability: "READY",
		generation: 3,
		currentCommitSha: "a".repeat(40),
	} as unknown,
	published: { incomplete: false, files: [] as unknown[] } as unknown,
}));

function query(key: string, data: () => unknown) {
	return () => ({
		queryKey: [key],
		queryFn: async () => data(),
	});
}

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			instructions: {
				proposals: {
					myBranch: {
						queryOptions: query("myBranch", () => state.branch),
					},
					restoreMyBranchFile: {
						mutationOptions: (
							options: Record<string, unknown> = {},
						) => ({
							mutationFn: async (input: unknown) => {
								state.restore(input);
								if (state.failure) {
									throw state.failure;
								}
								return state.answer;
							},
							...options,
						}),
					},
				},
				repository: {
					getState: {
						queryOptions: query(
							"getState",
							() => state.repositoryState,
						),
					},
					listFiles: {
						queryOptions: query("listFiles", () => {
							state.listed();
							return state.published;
						}),
					},
				},
			},
		},
	},
}));
vi.mock("@saas/projects/lib/instructions-query-freshness", () => ({
	instructionsFreshness: { pinnedRead: {} },
}));
vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: state.confirm }),
}));
vi.mock("../lib/instructions-proposal-views", () => ({
	invalidateProposalViews: (...a: unknown[]) => state.invalidate(...a),
}));
vi.mock("sonner", () => ({
	toast: {
		success: (...a: unknown[]) => state.toastSuccess(...a),
		error: (...a: unknown[]) => state.toastError(...a),
	},
}));
vi.mock("@saas/projects/hooks/use-instruction-action-error", () => ({
	useInstructionActionError: () => () => "That didn't work.",
}));

import {
	BranchFileActionButton,
	BranchFileNotice,
	useMyBranchFiles,
	useRestoreBranchFile,
} from "../BranchFileActions";
import { BranchFileList } from "../BranchFileList";
import type { BranchMarker } from "../lib/branch-files";

const PIN = { generation: 3, commitSha: "a".repeat(40) };

function Wrapper({ children }: { children: ReactNode }) {
	return (
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
}

function ActionHarness({
	path,
	marker,
	pinned = true,
	onChanged,
}: {
	path: string;
	marker: BranchMarker;
	pinned?: boolean;
	onChanged?: () => void;
}) {
	const restore = useRestoreBranchFile({
		projectId: "p",
		nativeBase: pinned ? PIN : null,
		onChanged,
	});
	return (
		<BranchFileActionButton path={path} marker={marker} restore={restore} />
	);
}

/** Runs the confirmed action the last `confirm` call was given. */
function acceptConfirm() {
	const options = state.confirm.mock.calls.at(-1)?.[0] as {
		onConfirm: () => void;
	};
	options.onConfirm();
}

beforeEach(() => {
	vi.clearAllMocks();
	state.answer = { operation: "delete" };
	state.failure = null;
	state.branch = { branch: { id: "branch_1" }, files: [] };
	state.published = { incomplete: false, files: [] };
});

describe("useMyBranchFiles", () => {
	// The tree waits on `isPending` before saying nothing is there; a disabled
	// read, which TanStack keeps pending for good, must not hold it forever.
	it("is pending only while an enabled read is under way", async () => {
		const enabled = renderHook(() => useMyBranchFiles("p", true), {
			wrapper: Wrapper,
		});
		expect(enabled.result.current.isPending).toBe(true);
		await waitFor(() =>
			expect(enabled.result.current.isPending).toBe(false),
		);
		expect(enabled.result.current.branchId).toBe("branch_1");

		const disabled = renderHook(() => useMyBranchFiles("p", false), {
			wrapper: Wrapper,
		});
		expect(disabled.result.current.isPending).toBe(false);
		expect(disabled.result.current.files).toEqual([]);
	});
});

describe("BranchFileActionButton", () => {
	it("deletes a branch-only file from the member's branch after a destructive confirm", async () => {
		const user = userEvent.setup();
		const onChanged = vi.fn();
		render(
			<ActionHarness
				path="rules/new.md"
				marker="branchOnly"
				onChanged={onChanged}
			/>,
			{ wrapper: Wrapper },
		);

		await user.click(
			screen.getByRole("button", {
				name: "Delete from my branch: rules/new.md",
			}),
		);

		expect(state.restore).not.toHaveBeenCalled();
		expect(state.confirm).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "Delete rules/new.md from your proposal branch?",
				confirmLabel: "Delete from my branch",
				destructive: true,
			}),
		);
		acceptConfirm();

		await waitFor(() =>
			expect(state.toastSuccess).toHaveBeenCalledWith(
				"Suggested. Fabric will delete the file from your branch.",
			),
		);
		expect(state.restore).toHaveBeenCalledWith({
			projectId: "p",
			nativeBase: PIN,
			path: "rules/new.md",
		});
		expect(state.invalidate).toHaveBeenCalled();
		expect(onChanged).toHaveBeenCalled();
	});

	it("restores a published file the branch changes", async () => {
		const user = userEvent.setup();
		state.answer = { operation: "put" };
		render(<ActionHarness path="AGENTS.md" marker="changedOnBranch" />, {
			wrapper: Wrapper,
		});

		await user.click(
			screen.getByRole("button", {
				name: "Restore published version: AGENTS.md",
			}),
		);
		expect(state.confirm).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "Restore AGENTS.md to the published version?",
				destructive: true,
			}),
		);
		acceptConfirm();

		await waitFor(() =>
			expect(state.toastSuccess).toHaveBeenCalledWith(
				"Suggested. Fabric will put the published version back on your branch.",
			),
		);
		expect(state.restore).toHaveBeenCalledWith({
			projectId: "p",
			nativeBase: PIN,
			path: "AGENTS.md",
		});
	});

	it("shows the translated line when the restore fails", async () => {
		const user = userEvent.setup();
		state.failure = new Error("raw server wording");
		render(<ActionHarness path="AGENTS.md" marker="deletedOnBranch" />, {
			wrapper: Wrapper,
		});

		await user.click(
			screen.getByRole("button", {
				name: "Restore published version: AGENTS.md",
			}),
		);
		acceptConfirm();

		await waitFor(() =>
			expect(state.toastError).toHaveBeenCalledWith("That didn't work."),
		);
		expect(state.toastSuccess).not.toHaveBeenCalled();
	});

	it("says a changed file is changed without claiming the published version is shown", () => {
		function NoticeHarness({
			marker,
		}: {
			marker: "changedOnBranch" | "deletedOnBranch";
		}) {
			const restore = useRestoreBranchFile({
				projectId: "p",
				nativeBase: PIN,
			});
			return (
				<BranchFileNotice
					path="AGENTS.md"
					marker={marker}
					restore={restore}
				/>
			);
		}
		const changed = render(<NoticeHarness marker="changedOnBranch" />, {
			wrapper: Wrapper,
		});
		expect(
			screen.getByText("Your proposal branch changes this file."),
		).toBeInTheDocument();
		expect(
			screen.queryByText(/You see the published version here/),
		).not.toBeInTheDocument();
		changed.unmount();

		render(<NoticeHarness marker="deletedOnBranch" />, {
			wrapper: Wrapper,
		});
		expect(
			screen.getByText(
				"Your proposal branch deletes this file. You see the published version here.",
			),
		).toBeInTheDocument();
	});

	it("is unavailable while the published pin is unknown", () => {
		render(
			<ActionHarness
				path="AGENTS.md"
				marker="changedOnBranch"
				pinned={false}
			/>,
			{ wrapper: Wrapper },
		);

		expect(
			screen.getByRole("button", {
				name: "Restore published version: AGENTS.md",
			}),
		).toBeDisabled();
	});
});

describe("BranchFileList", () => {
	it("lists each file the branch differs on with its marker and action", async () => {
		state.branch = {
			branch: { id: "branch_1" },
			files: [
				{ path: "AGENTS.md", state: "written", objectId: "p1" },
				{ path: "rules/a.md", state: "written", objectId: "b2" },
				{ path: "rules/b.md", state: "deleted", objectId: null },
				{ path: "rules/new.md", state: "written", objectId: "b4" },
			],
		};
		state.published = {
			incomplete: false,
			files: [
				{ path: "AGENTS.md", kind: "AGENTS", blobId: "p1" },
				{ path: "rules/a.md", kind: "RULE", blobId: "p2" },
				{ path: "rules/b.md", kind: "RULE", blobId: "p3" },
			],
		};
		render(<BranchFileList projectId="p" />, { wrapper: Wrapper });

		expect(
			await screen.findByText("Files your branch changes"),
		).toBeInTheDocument();
		const items = screen.getAllByRole("listitem");
		expect(items.map((item) => item.textContent)).toEqual([
			"rules/a.mdchanged on your branchRestore published version",
			"rules/b.mddeleted on your branchRestore published version",
			"rules/new.mdyour branchDelete from my branch",
		]);
		expect(
			screen.getByRole("button", {
				name: "Delete from my branch: rules/new.md",
			}),
		).toBeEnabled();
	});

	it("renders nothing when the branch matches the published version", async () => {
		state.branch = {
			branch: { id: "branch_1" },
			files: [{ path: "AGENTS.md", state: "written", objectId: "p1" }],
		};
		state.published = {
			incomplete: false,
			files: [{ path: "AGENTS.md", kind: "AGENTS", blobId: "p1" }],
		};
		const { container } = render(<BranchFileList projectId="p" />, {
			wrapper: Wrapper,
		});

		await waitFor(() => expect(state.listed).toHaveBeenCalled());
		expect(container).toBeEmptyDOMElement();
	});
});
