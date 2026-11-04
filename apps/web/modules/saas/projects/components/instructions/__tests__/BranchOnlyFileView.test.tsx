/**
 * A file only the member's own proposal branch holds: the view reads the
 * branch bytes, and Edit suggests a change to them as an ordinary proposal
 * pinned to the published version.
 */
import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
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
	readFile: vi.fn(),
	file: {
		body: "# Branch rule\n",
		truncated: false,
		url: null,
	} as unknown,
	edit: vi.fn(),
	invalidate: vi.fn(),
	toastSuccess: vi.fn(),
	toastInfo: vi.fn(),
	toastError: vi.fn(),
	actionButton: vi.fn(),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			instructions: {
				proposals: {
					myBranchFile: {
						queryOptions: ({ input }: { input: unknown }) => ({
							queryKey: ["myBranchFile", input],
							queryFn: async () => {
								state.readFile(input);
								return state.file;
							},
						}),
					},
				},
			},
		},
	},
}));
vi.mock("@saas/projects/lib/edit-snapshot", () => ({
	editInstructionSnapshot: async (input: unknown) => state.edit(input),
}));
vi.mock("../lib/instructions-proposal-views", () => ({
	invalidateProposalViews: (...a: unknown[]) => state.invalidate(...a),
}));
vi.mock("../InstructionMarkdown", () => ({
	InstructionMarkdown: ({ children }: { children: string }) => (
		<div data-testid="markdown">{children}</div>
	),
}));
vi.mock("../BranchFileActions", () => ({
	BranchFileActionButton: (props: { path: string; marker: string }) => {
		state.actionButton(props);
		return <button type="button">{`action ${props.marker}`}</button>;
	},
}));
vi.mock("sonner", () => ({
	toast: {
		success: (...a: unknown[]) => state.toastSuccess(...a),
		info: (...a: unknown[]) => state.toastInfo(...a),
		error: (...a: unknown[]) => state.toastError(...a),
	},
}));
vi.mock("@saas/projects/hooks/use-instruction-action-error", () => ({
	useInstructionActionError: () => () => "That didn't work.",
}));

import { BranchOnlyFileView } from "../BranchOnlyFileView";

const PIN = { generation: 3, commitSha: "a".repeat(40) };
const RESTORE = { request: vi.fn(), pending: false, available: true };

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

function renderView(canPropose = true, onChanged = vi.fn()) {
	render(
		<BranchOnlyFileView
			projectId="p"
			branchId="branch_1"
			path="rules/new.md"
			nativeBase={PIN}
			canPropose={canPropose}
			restore={RESTORE}
			onChanged={onChanged}
		/>,
		{ wrapper: Wrapper },
	);
	return onChanged;
}

beforeEach(() => {
	vi.clearAllMocks();
	state.file = { body: "# Branch rule\n", truncated: false, url: null };
	state.edit.mockResolvedValue({ snapshotId: "snap_1" });
});

describe("BranchOnlyFileView", () => {
	it("shows the branch bytes with the branch-only badge and the delete action", async () => {
		renderView();

		expect(await screen.findByTestId("markdown")).toHaveTextContent(
			"# Branch rule",
		);
		expect(state.readFile).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "p",
				branchId: "branch_1",
				path: "rules/new.md",
				offset: 0,
			}),
		);
		expect(screen.getByText("Only on your branch")).toBeInTheDocument();
		expect(state.actionButton).toHaveBeenCalledWith(
			expect.objectContaining({
				path: "rules/new.md",
				marker: "branchOnly",
			}),
		);
	});

	it("suggests an edit of the branch bytes as a proposal on the published pin", async () => {
		const user = userEvent.setup();
		const onChanged = renderView();
		await screen.findByTestId("markdown");

		await user.click(screen.getByRole("button", { name: "Edit" }));
		const editor = screen.getByRole("textbox", {
			name: "Edit rules/new.md",
		});
		expect((editor as HTMLTextAreaElement).value).toBe("# Branch rule\n");
		await user.type(editor, "more");
		await user.click(
			screen.getByRole("button", { name: "Suggest change" }),
		);

		await waitFor(() =>
			expect(state.toastSuccess).toHaveBeenCalledWith(
				"Suggested. Fabric will add the change to your branch.",
			),
		);
		expect(state.edit).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "p",
				nativeBase: PIN,
				proposal: true,
				publishOnReady: false,
				edits: [
					expect.objectContaining({
						op: "put",
						path: "rules/new.md",
					}),
				],
			}),
		);
		const body = (
			state.edit.mock.calls[0]?.[0] as { edits: { body: Blob }[] }
		).edits[0]?.body;
		expect(await body?.text()).toBe("# Branch rule\nmore");
		expect(state.invalidate).toHaveBeenCalled();
		expect(onChanged).toHaveBeenCalled();
	});

	it("sends nothing when the text is unchanged", async () => {
		const user = userEvent.setup();
		renderView();
		await screen.findByTestId("markdown");

		await user.click(screen.getByRole("button", { name: "Edit" }));
		await user.click(
			screen.getByRole("button", { name: "Suggest change" }),
		);

		expect(state.edit).not.toHaveBeenCalled();
		expect(state.toastInfo).toHaveBeenCalledWith(
			"There is no change to suggest.",
		);
	});

	it("offers no edit or delete to a member who cannot propose", async () => {
		renderView(false);
		await screen.findByTestId("markdown");

		expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
		expect(state.actionButton).not.toHaveBeenCalled();
	});
});
