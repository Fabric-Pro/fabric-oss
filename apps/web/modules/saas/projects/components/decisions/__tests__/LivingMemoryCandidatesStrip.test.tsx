/**
 * LivingMemoryCandidatesStrip — decisions found in synced Living Memory files,
 * offered for review in the Decisions tab. It renders nothing when there are
 * no candidates (a project without synced files sees no strip), shows the
 * file path and a "May update" hint per candidate, and sends the matched
 * decision's id only when the reviewer chooses "Create as update".
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	response: { candidates: [] } as {
		candidates: Array<Record<string, unknown>>;
		filesSkippedAtFirstSync?: number;
	},
	createCalls: [] as unknown[],
	dismissCalls: [] as unknown[],
	scanCalls: [] as unknown[],
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			architectureDecisions: {
				livingMemoryDecisions: {
					list: {
						queryOptions: (opts: { input: unknown }) => ({
							queryKey: ["living-memory-candidates", opts.input],
							queryFn: async () => state.response,
						}),
					},
					createFrom: {
						mutationOptions: (opts: Record<string, unknown>) => ({
							...opts,
							mutationFn: async (input: unknown) => {
								state.createCalls.push(input);
								return { decision: { id: "dec-new" } };
							},
						}),
					},
					dismiss: {
						mutationOptions: (opts: Record<string, unknown>) => ({
							...opts,
							mutationFn: async (input: unknown) => {
								state.dismissCalls.push(input);
								return { dismissed: true };
							},
						}),
					},
					scanFirstSync: {
						mutationOptions: (opts: Record<string, unknown>) => ({
							...opts,
							mutationFn: async (input: unknown) => {
								state.scanCalls.push(input);
								return { fileCount: 3, alreadyRunning: false };
							},
						}),
					},
				},
			},
		},
	},
}));

import { LivingMemoryCandidatesStrip } from "../LivingMemoryCandidatesStrip";

const plainCandidate = {
	extractionId: "ext-1",
	decisionIndex: 0,
	sourcePath: "docs/architecture/storage.md",
	extractedAt: "2026-11-01T10:00:00.000Z",
	text: "Use Postgres for all persistence",
};

const updateCandidate = {
	extractionId: "ext-1",
	decisionIndex: 1,
	sourcePath: "docs/architecture/queues.md",
	extractedAt: "2026-11-01T10:00:00.000Z",
	text: "Move background jobs to Temporal",
	matchedDecision: {
		id: "dec-7",
		identifier: "ADR-007",
		title: "Run background jobs on a cron queue",
	},
};

function renderStrip({
	canEdit = true,
	onCreated = vi.fn(),
}: {
	canEdit?: boolean;
	onCreated?: (id: string) => void;
} = {}) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={queryClient}>
			<LivingMemoryCandidatesStrip
				projectId="proj-1"
				organizationId={null}
				canEdit={canEdit}
				onCreated={onCreated}
			/>
		</QueryClientProvider>,
	);
	return { onCreated };
}

async function expand() {
	await userEvent.click(
		await screen.findByRole("button", { name: "strip.toggleAria" }),
	);
}

beforeEach(() => {
	state.response = { candidates: [] };
	state.createCalls = [];
	state.dismissCalls = [];
	state.scanCalls = [];
});

describe("LivingMemoryCandidatesStrip", () => {
	it("renders nothing when the project has no candidates", async () => {
		renderStrip();

		await waitFor(() => {
			expect(
				screen.queryByRole("button", { name: "strip.toggleAria" }),
			).not.toBeInTheDocument();
		});
	});

	it("renders collapsed, then lists each candidate with its source file", async () => {
		state.response = { candidates: [plainCandidate, updateCandidate] };
		renderStrip();

		const toggle = await screen.findByRole("button", {
			name: "strip.toggleAria",
		});
		expect(toggle).toHaveAttribute("aria-expanded", "false");

		await expand();

		expect(
			screen.getByText("Use Postgres for all persistence"),
		).toBeInTheDocument();
		expect(
			screen.getByText("docs/architecture/storage.md"),
		).toBeInTheDocument();
		// Only the candidate that reads like an existing decision is marked.
		expect(screen.getAllByText("strip.mayUpdate")).toHaveLength(1);
	});

	it("creates a candidate that matches an existing decision as an update", async () => {
		state.response = { candidates: [updateCandidate] };
		const { onCreated } = renderStrip();
		await expand();

		await userEvent.click(
			screen.getByRole("button", { name: "strip.review" }),
		);
		await userEvent.click(
			await screen.findByRole("button", {
				name: "dialog.createAsUpdate",
			}),
		);

		await waitFor(() => expect(onCreated).toHaveBeenCalledWith("dec-new"));
		expect(state.createCalls).toEqual([
			{
				projectId: "proj-1",
				organizationId: null,
				extractionId: "ext-1",
				decisionIndex: 1,
				updatesDecisionId: "dec-7",
			},
		]);
	});

	it("creates a matched candidate as a new decision when asked", async () => {
		state.response = { candidates: [updateCandidate] };
		renderStrip();
		await expand();

		await userEvent.click(
			screen.getByRole("button", { name: "strip.review" }),
		);
		await userEvent.click(
			await screen.findByRole("button", { name: "dialog.createNew" }),
		);

		await waitFor(() => expect(state.createCalls).toHaveLength(1));
		expect(state.createCalls[0]).not.toHaveProperty("updatesDecisionId");
	});

	it("dismisses a candidate without creating anything", async () => {
		state.response = { candidates: [plainCandidate] };
		renderStrip();
		await expand();

		await userEvent.click(
			screen.getByRole("button", { name: "strip.dismiss" }),
		);

		await waitFor(() => expect(state.dismissCalls).toHaveLength(1));
		expect(state.dismissCalls[0]).toEqual({
			projectId: "proj-1",
			organizationId: null,
			extractionId: "ext-1",
			decisionIndex: 0,
		});
		expect(state.createCalls).toHaveLength(0);
	});

	it("hides the review actions from a reader who cannot create decisions", async () => {
		state.response = { candidates: [plainCandidate] };
		renderStrip({ canEdit: false });
		await expand();

		expect(
			screen.getByText("Use Postgres for all persistence"),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "strip.review" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "strip.dismiss" }),
		).not.toBeInTheDocument();
	});

	it("offers a scan for the files a first sync skipped, before any candidate exists", async () => {
		state.response = { candidates: [], filesSkippedAtFirstSync: 3 };
		renderStrip();

		await userEvent.click(
			await screen.findByRole("button", { name: "strip.scanFirstSync" }),
		);

		expect(screen.getByText("strip.firstSyncSkipped")).toBeInTheDocument();
		await waitFor(() => {
			expect(state.scanCalls).toEqual([
				{ projectId: "proj-1", organizationId: null },
			]);
		});
	});

	it("keeps the scan offer beside candidates", async () => {
		state.response = {
			candidates: [plainCandidate],
			filesSkippedAtFirstSync: 1,
		};
		renderStrip();

		expect(
			await screen.findByRole("button", { name: "strip.scanFirstSync" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "strip.toggleAria" }),
		).toBeInTheDocument();
	});

	it("tells a reader about skipped files without offering the scan", async () => {
		state.response = { candidates: [], filesSkippedAtFirstSync: 3 };
		renderStrip({ canEdit: false });

		expect(
			await screen.findByText("strip.firstSyncSkipped"),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "strip.scanFirstSync" }),
		).not.toBeInTheDocument();
	});
});
