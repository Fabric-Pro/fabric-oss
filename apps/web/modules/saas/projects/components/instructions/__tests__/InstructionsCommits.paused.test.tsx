/**
 * The Commits view while uploaded instructions are being moved into a
 * repository (Fizzy #2878 §9): a project that is switching over is already
 * repository-backed, so it has Commits, but the server refuses a revert until
 * the move ends. Revert stays on its row, disabled, and says why; reading and
 * comparing commits are unchanged.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async () =>
	(await import("../../../__tests__/en-copy")).nextIntlMock(),
);

const mocks = vi.hoisted(() => ({
	revert: vi.fn(),
	confirm: vi.fn(),
	toastInfo: vi.fn(),
}));

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			instructions: {
				repository: {
					getCommitParent: {
						queryOptions: () => ({
							queryKey: ["commitParent"],
							enabled: false,
						}),
					},
				},
				repositorySync: {
					listCommits: {
						queryOptions: (o: { input: unknown }) => ({
							queryKey: ["listCommits", o.input],
							queryFn: async () => ({
								commits: [
									{
										sha: SHA,
										author: { name: "Example Member" },
										date: new Date().toISOString(),
										message: "Update AGENTS.md",
										url: `https://github.com/example-org/instructions/commit/${SHA}`,
										parent: "9".repeat(40),
										published: null,
										refused: false,
										isFabric: false,
									},
								],
								nextCursor: null,
							}),
						}),
						key: () => ["listCommits"],
					},
					compareCommits: {
						queryOptions: (o: { input: unknown }) => ({
							queryKey: ["compareCommits", o.input],
							queryFn: async () => ({}),
						}),
					},
					readCommitFile: {
						queryOptions: (o: { input: unknown }) => ({
							queryKey: ["readCommitFile", o.input],
							queryFn: async () => ({ state: "absent" }),
						}),
					},
				},
				revertCommit: {
					mutationOptions: (opts: Record<string, unknown> = {}) => ({
						mutationFn: (input: unknown) => mocks.revert(input),
						...opts,
					}),
				},
			},
		},
	},
}));
vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: mocks.confirm }),
}));
vi.mock("sonner", () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
		info: (...a: unknown[]) => mocks.toastInfo(...a),
	},
}));

import { InstructionsCommits } from "../InstructionsCommits";

const REASON =
	"Moving to example-org/instructions: the pull request was merged and the project is switching to the repository. Changes are paused until that finishes.";

function Providers({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

function renderCommits(pausedReason: string | null) {
	render(
		<InstructionsCommits
			projectId="p"
			open
			onOpenChange={() => undefined}
			provider="GITHUB"
			branch="main"
			rootPath=""
			published={{ sha: null, version: 1 }}
			canRevert
			canCompare
			pausedReason={pausedReason}
			onChanged={vi.fn()}
		/>,
		{ wrapper: Providers },
	);
}

beforeEach(() => {
	for (const fn of Object.values(mocks)) {
		fn.mockReset();
	}
});

describe("InstructionsCommits while a move into a repository is open", () => {
	it("keeps Revert on the row but disabled, and says why when it is pressed", async () => {
		const user = userEvent.setup();
		renderCommits(REASON);

		const revert = await screen.findByRole("button", { name: "Revert" });
		await user.click(revert);

		expect(revert).toHaveAttribute("aria-disabled", "true");
		expect(mocks.toastInfo).toHaveBeenCalledWith(REASON);
		expect(mocks.confirm).not.toHaveBeenCalled();
		expect(mocks.revert).not.toHaveBeenCalled();
	});

	it("still offers Compare with parent", async () => {
		renderCommits(REASON);

		expect(
			await screen.findByRole("button", { name: "Compare with parent" }),
		).toBeEnabled();
	});

	it("still asks before reverting when nothing is moving", async () => {
		const user = userEvent.setup();
		renderCommits(null);

		const revert = await screen.findByRole("button", { name: "Revert" });
		await user.click(revert);

		expect(revert).not.toHaveAttribute("aria-disabled");
		expect(mocks.confirm).toHaveBeenCalledTimes(1);
		expect(mocks.toastInfo).not.toHaveBeenCalled();
	});
});
