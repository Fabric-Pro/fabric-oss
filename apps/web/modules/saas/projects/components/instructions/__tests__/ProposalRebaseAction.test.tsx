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
								return state.answers.shift();
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
			"Rebased as proposal version 9. It replaces the stale proposal.",
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
