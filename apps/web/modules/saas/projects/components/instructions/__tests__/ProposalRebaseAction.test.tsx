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
	rebase: vi.fn(),
	answers: [] as unknown[],
	toastSuccess: vi.fn(),
	toastInfo: vi.fn(),
	toastError: vi.fn(),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			instructions: {
				proposals: {
					rebase: {
						mutationOptions: (
							options: Record<string, unknown> = {},
						) => ({
							mutationFn: async (input: unknown) => {
								state.rebase(input);
								const answer = state.answers.shift();
								if (answer instanceof Error) {
									throw answer;
								}
								return answer;
							},
							...options,
						}),
					},
				},
			},
		},
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

import { ProposalRebaseAction } from "../ProposalRebaseAction";

function Wrapper({ children }: { children: ReactNode }) {
	return (
		<QueryClientProvider
			client={
				new QueryClient({
					defaultOptions: { mutations: { retry: false } },
				})
			}
		>
			{children}
		</QueryClientProvider>
	);
}

const CONFLICTS = {
	outcome: "conflicts",
	publishedSnapshotId: "snap_published",
	publishedVersion: 8,
	conflicts: [
		{
			path: "AGENTS.md",
			reason: "content",
			text: "a\n<<<<<<< your proposal (version 7)\nours\n=======\ntheirs\n>>>>>>> published (version 8)\n",
		},
		{ path: "logo.png", reason: "binary", text: null },
	],
	clean: [{ path: "ok.md", op: "put" }],
};

function renderAction(onRebased = vi.fn()) {
	render(
		<ProposalRebaseAction
			projectId="p"
			snapshotId="snap_proposal"
			onRebased={onRebased}
		/>,
		{ wrapper: Wrapper },
	);
	return onRebased;
}

beforeEach(() => {
	vi.clearAllMocks();
	state.answers = [];
});

describe("ProposalRebaseAction", () => {
	it("replaces the proposal at once when the rebase is clean", async () => {
		const user = userEvent.setup();
		state.answers = [
			{
				outcome: "rebased",
				snapshotId: "snap_rebased",
				version: 9,
				baseVersion: 8,
				putCount: 1,
				deleteCount: 0,
			},
		];
		const onRebased = renderAction();

		await user.click(
			screen.getByRole("button", { name: "Rebase onto current version" }),
		);

		await waitFor(() =>
			expect(onRebased).toHaveBeenCalledWith("snap_rebased"),
		);
		expect(state.rebase).toHaveBeenCalledWith({
			projectId: "p",
			snapshotId: "snap_proposal",
			resolutions: [],
		});
		expect(state.toastSuccess).toHaveBeenCalledWith(
			"Rebased as proposal version 9. It replaces the stale proposal once its checks pass.",
		);
	});

	it("opens the conflicts with their markers and holds the submit until they are resolved", async () => {
		const user = userEvent.setup();
		state.answers = [
			CONFLICTS,
			{
				outcome: "rebased",
				snapshotId: "snap_rebased",
				version: 9,
				baseVersion: 8,
				putCount: 2,
				deleteCount: 0,
			},
		];
		const onRebased = renderAction();

		await user.click(
			screen.getByRole("button", { name: "Rebase onto current version" }),
		);

		const text = await screen.findByRole("textbox", {
			name: "Text of AGENTS.md",
		});
		expect((text as HTMLTextAreaElement).value).toContain("<<<<<<<");
		expect(onRebased).not.toHaveBeenCalled();
		const submit = screen.getByRole("button", {
			name: "Submit rebased proposal",
		});
		expect(submit).toBeDisabled();
		expect(screen.getByRole("alert")).toHaveTextContent(
			"Some text still holds conflict markers",
		);

		await user.clear(text);
		await user.type(text, "a{enter}both{enter}");
		expect(submit).toBeEnabled();
		await user.click(submit);

		await waitFor(() =>
			expect(onRebased).toHaveBeenCalledWith("snap_rebased"),
		);
		expect(state.rebase).toHaveBeenLastCalledWith({
			projectId: "p",
			snapshotId: "snap_proposal",
			expectedPublishedSnapshotId: "snap_published",
			resolutions: [
				{ op: "put", path: "AGENTS.md", content: "a\nboth\n" },
				{ op: "published", path: "logo.png" },
			],
		});
	});

	it("lets the proposer delete a conflicting file instead", async () => {
		const user = userEvent.setup();
		state.answers = [CONFLICTS, CONFLICTS];
		renderAction();

		await user.click(
			screen.getByRole("button", { name: "Rebase onto current version" }),
		);
		const deletes = await screen.findAllByRole("button", {
			name: "Delete the file",
		});
		await user.click(deletes[0] as HTMLElement);
		await user.click(
			screen.getByRole("button", { name: "Submit rebased proposal" }),
		);

		await waitFor(() =>
			expect(state.rebase).toHaveBeenLastCalledWith(
				expect.objectContaining({
					resolutions: [
						{ op: "delete", path: "AGENTS.md" },
						{ op: "published", path: "logo.png" },
					],
				}),
			),
		);
	});

	it("reads the conflicts again when a newer version was published while they were resolved", async () => {
		const user = userEvent.setup();
		const newer = {
			...CONFLICTS,
			publishedSnapshotId: "snap_newer",
			publishedVersion: 9,
		};
		state.answers = [
			CONFLICTS,
			Object.assign(new Error("A newer version was published"), {
				code: "CONFLICT",
				data: {
					reason: "REBASE_PUBLISHED_CHANGED",
					publishedSnapshotId: "snap_newer",
				},
			}),
			newer,
			{
				outcome: "rebased",
				snapshotId: "snap_rebased",
				version: 10,
				baseVersion: 9,
				putCount: 0,
				deleteCount: 1,
			},
		];
		const onRebased = renderAction();

		await user.click(
			screen.getByRole("button", { name: "Rebase onto current version" }),
		);
		const deletes = await screen.findAllByRole("button", {
			name: "Delete the file",
		});
		await user.click(deletes[0] as HTMLElement);
		await user.click(
			screen.getByRole("button", { name: "Submit rebased proposal" }),
		);

		await waitFor(() => expect(state.rebase).toHaveBeenCalledTimes(3));
		expect(state.rebase).toHaveBeenNthCalledWith(2, {
			projectId: "p",
			snapshotId: "snap_proposal",
			expectedPublishedSnapshotId: "snap_published",
			resolutions: [
				{ op: "delete", path: "AGENTS.md" },
				{ op: "published", path: "logo.png" },
			],
		});
		expect(state.rebase).toHaveBeenNthCalledWith(3, {
			projectId: "p",
			snapshotId: "snap_proposal",
			resolutions: [],
		});
		expect(state.toastInfo).toHaveBeenCalledWith(
			"A newer version was published while you resolved the conflicts. The conflicts are shown again against it.",
		);
		expect(state.toastError).not.toHaveBeenCalled();
		await screen.findByText(/published version 9/);

		const freshDeletes = screen.getAllByRole("button", {
			name: "Delete the file",
		});
		await user.click(freshDeletes[0] as HTMLElement);
		await user.click(
			screen.getByRole("button", { name: "Submit rebased proposal" }),
		);
		await waitFor(() =>
			expect(onRebased).toHaveBeenCalledWith("snap_rebased"),
		);
		expect(state.rebase).toHaveBeenLastCalledWith(
			expect.objectContaining({
				expectedPublishedSnapshotId: "snap_newer",
			}),
		);
	});

	it("shows any other refusal as an error and keeps the conflicts open", async () => {
		const user = userEvent.setup();
		state.answers = [
			CONFLICTS,
			Object.assign(new Error("Not allowed"), {
				code: "CONFLICT",
				data: { reason: "REBASE_UNAVAILABLE" },
			}),
		];
		renderAction();

		await user.click(
			screen.getByRole("button", { name: "Rebase onto current version" }),
		);
		const deletes = await screen.findAllByRole("button", {
			name: "Delete the file",
		});
		await user.click(deletes[0] as HTMLElement);
		await user.click(
			screen.getByRole("button", { name: "Submit rebased proposal" }),
		);

		await waitFor(() =>
			expect(state.toastError).toHaveBeenCalledWith("That didn't work."),
		);
		expect(state.rebase).toHaveBeenCalledTimes(2);
		expect(state.toastInfo).not.toHaveBeenCalled();
	});

	it("says so when the same rebase was already proposed", async () => {
		const user = userEvent.setup();
		state.answers = [
			{ outcome: "duplicate", snapshotId: "snap_other", version: 10 },
		];
		const onRebased = renderAction();

		await user.click(
			screen.getByRole("button", { name: "Rebase onto current version" }),
		);

		await waitFor(() =>
			expect(onRebased).toHaveBeenCalledWith("snap_other"),
		);
		expect(state.toastInfo).toHaveBeenCalled();
	});
});
