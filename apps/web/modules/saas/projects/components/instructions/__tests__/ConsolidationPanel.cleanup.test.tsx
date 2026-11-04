/**
 * The cleanup pull request on "Keep AI files out of the code repository":
 * merge it from Fabric after a confirmation, the merged state and its next
 * step, a pull request closed unmerged, and no merge button for a caller
 * who may not merge. Every identifier is synthetic.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	getConsolidation: vi.fn(),
	getSync: vi.fn(),
	cleanup: vi.fn(),
	merge: vi.fn(),
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("next/navigation", () => ({
	useSearchParams: () => new URLSearchParams(),
}));
vi.mock("../RepositoryChoice", () => ({ RepositoryChoice: () => null }));
vi.mock("@shared/lib/orpc-query-utils", () => {
	const query = (name: string, fn: (input: unknown) => unknown) => ({
		queryOptions: (options: { input: unknown }) => ({
			queryKey: [name, options.input],
			queryFn: () => fn(options.input),
		}),
		key: () => [name],
	});
	return {
		orpc: {
			projects: {
				instructions: {
					key: () => ["instructions"],
					repositorySync: {
						key: () => ["repositorySync"],
						get: query("get", (i) => m.getSync(i)),
						getConsolidation: query("getConsolidation", (i) =>
							m.getConsolidation(i),
						),
						getConsolidationCleanupPullRequest: query(
							"getConsolidationCleanupPullRequest",
							(i) => m.cleanup(i),
						),
						mergeConsolidationCleanupPullRequest: {
							mutationOptions: () => ({
								mutationFn: (input: unknown) => m.merge(input),
							}),
						},
						retryConsolidation: {
							mutationOptions: () => ({ mutationFn: vi.fn() }),
						},
						previewConsolidation: {
							mutationOptions: () => ({ mutationFn: vi.fn() }),
						},
						startConsolidation: {
							mutationOptions: () => ({ mutationFn: vi.fn() }),
						},
					},
				},
			},
		},
	};
});

import { ConsolidationPanel } from "../ConsolidationPanel";

const PR_URL = "https://github.com/example-org/example-app/pull/7";

const RUN = {
	id: "run-1",
	status: "COMPLETED",
	step: "DONE",
	fileCount: 4,
	targetRepositoryUrl: "https://github.com/example-org/example-app-ai",
	cleanupPullRequestUrl: PR_URL,
	error: null,
};

function pullRequest(over: Record<string, unknown> = {}) {
	return {
		state: "OPEN",
		url: PR_URL,
		number: "7",
		provider: "GITHUB",
		repository: "example-org/example-app",
		defaultBranch: "main",
		fileCount: 4,
		mergedAt: null,
		canMerge: true,
		...over,
	};
}

function mount(canEdit = true) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<ConsolidationPanel projectId="project_1" canEdit={canEdit} />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	m.getConsolidation.mockResolvedValue({ run: RUN });
	m.getSync.mockResolvedValue({
		configured: null,
		availableIntegrations: [],
	});
});

describe("ConsolidationPanel cleanup pull request", () => {
	it("merges after the confirmation names the pull request, branch, file count and repository", async () => {
		m.cleanup
			.mockResolvedValueOnce({ pullRequest: pullRequest() })
			.mockResolvedValue({
				pullRequest: pullRequest({ state: "MERGED", canMerge: false }),
			});
		m.merge.mockResolvedValue({
			pullRequest: pullRequest({ state: "MERGED" }),
		});
		const user = userEvent.setup();
		mount();

		await user.click(
			await screen.findByRole("button", { name: "Merge cleanup PR" }),
		);
		const dialog = await screen.findByRole("dialog");
		expect(dialog).toHaveTextContent(
			"Merge pull request #7 into main? It deletes 4 AI tool files from example-org/example-app.",
		);
		expect(m.merge).not.toHaveBeenCalled();

		await user.click(within(dialog).getByRole("button", { name: "Merge" }));
		await waitFor(() =>
			expect(m.merge).toHaveBeenCalledWith({
				projectId: "project_1",
				pullRequestNumber: "7",
			}),
		);
		expect(await screen.findByText("Cleanup merged")).toBeInTheDocument();
		expect(
			screen.getByText(/connect your coding tool/i),
		).toBeInTheDocument();
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("Cancel closes the confirmation without merging, and the link opens the pull request", async () => {
		m.cleanup.mockResolvedValue({ pullRequest: pullRequest() });
		const user = userEvent.setup();
		mount();

		const link = await screen.findByRole("link", {
			name: /I'll merge it myself/,
		});
		expect(link).toHaveAttribute("href", PR_URL);
		expect(link).toHaveAttribute("target", "_blank");

		await user.click(
			screen.getByRole("button", { name: "Merge cleanup PR" }),
		);
		await user.click(
			within(await screen.findByRole("dialog")).getByRole("button", {
				name: "Cancel",
			}),
		);
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
		expect(m.merge).not.toHaveBeenCalled();
	});

	it("shows a provider refusal inside the confirmation", async () => {
		m.cleanup.mockResolvedValue({ pullRequest: pullRequest() });
		m.merge.mockRejectedValue(
			new Error(
				"GitHub won't merge pull request #7 yet: required checks or reviews may be missing.",
			),
		);
		const user = userEvent.setup();
		mount();
		await user.click(
			await screen.findByRole("button", { name: "Merge cleanup PR" }),
		);
		const dialog = await screen.findByRole("dialog");
		await user.click(within(dialog).getByRole("button", { name: "Merge" }));
		expect(await within(dialog).findByRole("alert")).toHaveTextContent(
			/required checks or reviews/,
		);
	});

	it("shows a pull request found merged on open as merged, with the next step", async () => {
		m.cleanup.mockResolvedValue({
			pullRequest: pullRequest({ state: "MERGED", canMerge: false }),
		});
		mount();
		expect(await screen.findByText("Cleanup merged")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Merge cleanup PR" }),
		).not.toBeInTheDocument();
	});

	it("says a pull request closed unmerged left the files in place", async () => {
		m.cleanup.mockResolvedValue({
			pullRequest: pullRequest({ state: "CLOSED", canMerge: false }),
		});
		mount();
		expect(
			await screen.findByText(/was closed without merging/),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Merge cleanup PR" }),
		).not.toBeInTheDocument();
		// The move can be started again.
		expect(
			screen.getByRole("button", { name: "Move AI files out" }),
		).toBeInTheDocument();
	});

	it("has no merge button for a viewer who may not merge, only the link", async () => {
		m.cleanup.mockResolvedValue({
			pullRequest: pullRequest({ canMerge: false }),
		});
		mount(false);
		expect(
			await screen.findByRole("link", {
				name: /Open the cleanup pull request/,
			}),
		).toHaveAttribute("href", PR_URL);
		expect(
			screen.queryByRole("button", { name: "Merge cleanup PR" }),
		).not.toBeInTheDocument();
	});
});
