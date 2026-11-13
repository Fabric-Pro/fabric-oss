/**
 * LivingMemoryCandidatesStrip — decisions found in synced Living Memory files,
 * offered for review in the Decisions tab. It renders nothing when there are
 * no candidates (a project without synced files sees no strip), shows the
 * file path and a "May update" hint per candidate, links the work item a
 * candidate came from, names the files only partly read, and sends the
 * matched decision's id only when the reviewer chooses "Create as update".
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	response: { candidates: [] } as {
		candidates: Array<Record<string, unknown>>;
		filesNotScanned?: number;
		limitedFiles?: Array<{
			sourcePath: string;
			truncated: boolean;
			capped: boolean;
		}>;
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
		state.response = { candidates: [], filesNotScanned: 3 };
		renderStrip();

		await userEvent.click(
			await screen.findByRole("button", { name: "strip.scanFirstSync" }),
		);

		expect(screen.getByText("strip.filesNotScanned")).toBeInTheDocument();
		await waitFor(() => {
			expect(state.scanCalls).toEqual([
				{ projectId: "proj-1", organizationId: null },
			]);
		});
	});

	it("keeps the scan offer beside candidates", async () => {
		state.response = {
			candidates: [plainCandidate],
			filesNotScanned: 1,
		};
		renderStrip();

		expect(
			await screen.findByRole("button", { name: "strip.scanFirstSync" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "strip.toggleAria" }),
		).toBeInTheDocument();
	});

	it("links a candidate to the work item it came from", async () => {
		state.response = {
			candidates: [
				{
					...plainCandidate,
					workItem: { id: "story-12", identifier: "F-012" },
				},
				updateCandidate,
			],
		};
		renderStrip();
		await expand();

		const links = screen.getAllByRole("link", { name: "workItemLink" });
		expect(links).toHaveLength(1);
		expect(links[0]).toHaveTextContent("F-012");
		expect(links[0]?.getAttribute("href")).toMatch(/\/stories\/story-12$/);
	});

	it("names each file only partly read, with the limit it met", async () => {
		state.response = {
			candidates: [plainCandidate],
			limitedFiles: [
				{ sourcePath: "docs/huge.md", truncated: true, capped: false },
				{ sourcePath: "docs/log.md", truncated: true, capped: true },
			],
		};
		renderStrip();
		await expand();

		const notice = screen.getByRole("list", { name: "limits.label" });
		const items = within(notice).getAllByRole("listitem");
		expect(items).toHaveLength(2);
		expect(items[0]).toHaveTextContent("docs/huge.md: limits.truncated");
		expect(items[0]).not.toHaveTextContent("limits.capped");
		expect(items[1]).toHaveTextContent(
			"docs/log.md: limits.truncated limits.capped",
		);
	});

	it("names the first few partly read files and counts the rest", async () => {
		state.response = {
			candidates: [plainCandidate],
			limitedFiles: Array.from({ length: 5 }, (_, i) => ({
				sourcePath: `docs/file-${i}.md`,
				truncated: false,
				capped: true,
			})),
		};
		renderStrip();
		await expand();

		const notice = screen.getByRole("list", { name: "limits.label" });
		expect(within(notice).getAllByRole("listitem")).toHaveLength(4);
		expect(within(notice).getByText("limits.more")).toBeInTheDocument();
		expect(within(notice).queryByText(/docs\/file-3\.md/)).toBeNull();
	});

	it("says nothing about limits when no file met one", async () => {
		state.response = { candidates: [plainCandidate], limitedFiles: [] };
		renderStrip();
		await expand();

		expect(
			screen.queryByRole("list", { name: "limits.label" }),
		).not.toBeInTheDocument();
	});

	it("tells a reader about skipped files without offering the scan", async () => {
		state.response = { candidates: [], filesNotScanned: 3 };
		renderStrip({ canEdit: false });

		expect(
			await screen.findByText("strip.filesNotScanned"),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "strip.scanFirstSync" }),
		).not.toBeInTheDocument();
	});
});
