/**
 * "Sync now" only STARTS a workflow. Everything the findings list and the
 * Cases table show is written later, by the ingest that workflow runs — so a
 * refresh at the moment the mutation succeeds reads the pre-sync state and
 * keeps it. QA saw "Seen 1 time" beside two ingested red runs, and "Not run"
 * beside a failed case, until a full page reload (Fizzy #2226).
 *
 * Real react-query here, not a mock of it: the defect is about WHEN a cached
 * query is re-read, which a mocked `useQuery` cannot show.
 */

import {
	QueryClient,
	QueryClientProvider,
	useQuery,
} from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** What the server would answer right now. Tests move it forward. */
const server = {
	syncStates: [] as Array<{
		id: string;
		provider: string;
		status: string;
		lastFetchedAt: Date | null;
	}>,
	findingsSeen: 1,
	caseResult: "NOT_RUN",
};

function queryOf<T>(name: string, read: () => T) {
	return {
		key: () => [name],
		queryOptions: (opts: {
			input?: unknown;
			refetchInterval?: unknown;
		}) => ({
			queryKey: [name, opts.input],
			queryFn: async () => read(),
			refetchInterval: opts.refetchInterval,
		}),
	};
}

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			pipelineResults: {
				listRuns: queryOf("runs", () => []),
				listRunsPage: {
					key: () => ["runsPage"],
					infiniteOptions: () => ({
						queryKey: ["runsPage"],
						queryFn: async () => ({ runs: [], total: 0 }),
					}),
				},
				syncStates: queryOf("syncStates", () => server.syncStates),
				sources: queryOf("sources", () => ({
					sources: [{ id: "r1" }],
					noSourcesReason: null,
				})),
				findings: queryOf("findings", () => ({
					seen: server.findingsSeen,
				})),
				unmatchedTests: queryOf("unmatched", () => []),
				sync: {
					mutationOptions: (opts: object) => ({
						mutationFn: async () => ({ status: "started" }),
						...opts,
					}),
				},
			},
			testCases: {
				list: queryOf("cases", () => ({ result: server.caseResult })),
				resultHistory: queryOf("resultHistory", () => []),
			},
		},
	},
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

/**
 * Stand-ins for the two views the ticket names, reading the SAME query keys
 * the real ones do. What they print is what a user would be looking at.
 */
vi.mock("../FindingsSection", async () => {
	const { orpc } = await import("@shared/lib/orpc-query-utils");
	return {
		FindingsSection: () => {
			const q = useQuery(
				orpc.projects.pipelineResults.findings.queryOptions({
					input: { status: "OPEN" },
				}),
			);
			return <div data-testid="findings">{`Seen ${q.data?.seen}`}</div>;
		},
	};
});
vi.mock("../UnmatchedTestsSection", () => ({
	UnmatchedTestsSection: () => null,
}));
vi.mock("../TriggerRunDialog", () => ({ TriggerRunDialog: () => null }));
vi.mock("../PipelineRunDetailSheet", () => ({
	PipelineRunDetailSheet: () => null,
}));
vi.mock("../../HistoryMoreDialog", () => ({
	HISTORY_DIALOG_PAGE: 20,
	HISTORY_PANEL_PREVIEW: 5,
	HistoryMoreDialog: () => null,
}));

import { orpc } from "@shared/lib/orpc-query-utils";
import { PipelineRunsPanel } from "../PipelineRunsPanel";

/** The Cases table's RESULT column, mounted beside the panel as it is on the tab. */
function CasesResult() {
	const q = useQuery(
		orpc.projects.testCases.list.queryOptions({ input: {} }),
	);
	return <div data-testid="case-result">{q.data?.result}</div>;
}

function renderTab() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<CasesResult />
			<PipelineRunsPanel projectId="p1" />
		</QueryClientProvider>,
	);
	return client;
}

/** The poll tick that follows a sync, without waiting three real seconds. */
async function pollSyncStates(client: QueryClient) {
	await act(async () => {
		await client.refetchQueries({ queryKey: ["syncStates"] });
	});
}

beforeEach(() => {
	server.syncStates = [
		{
			id: "s1",
			provider: "GITHUB_ACTIONS",
			status: "OK",
			lastFetchedAt: new Date("2026-08-17T17:00:00Z"),
		},
	];
	server.findingsSeen = 1;
	server.caseResult = "NOT_RUN";
});

describe("PipelineRunsPanel — what a completed sync produced is visible without a reload", () => {
	it("re-reads the findings and the case results once the sync's ingest lands", async () => {
		const client = renderTab();
		expect(await screen.findByText("Seen 1")).toBeInTheDocument();
		expect(await screen.findByText("NOT_RUN")).toBeInTheDocument();

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /^sync$/ }));
		});

		// The workflow finishes after the mutation has already returned: its
		// ingest writes the second occurrence and the failed result, then
		// advances the source's lastFetchedAt.
		server.findingsSeen = 2;
		server.caseResult = "FAILED";
		server.syncStates = [
			{
				...server.syncStates[0],
				lastFetchedAt: new Date("2026-08-17T17:05:00Z"),
			},
		];
		await pollSyncStates(client);

		expect(await screen.findByText("Seen 2")).toBeInTheDocument();
		expect(await screen.findByText("FAILED")).toBeInTheDocument();
	});

	it("does not re-read them on a poll that found no newer fetch", async () => {
		const client = renderTab();
		expect(await screen.findByText("Seen 1")).toBeInTheDocument();

		// Something changed server-side that no sync of this panel produced;
		// an unchanged lastFetchedAt must not turn every poll tick into a
		// refetch of the whole Cases table.
		server.findingsSeen = 5;
		await pollSyncStates(client);

		expect(screen.getByTestId("findings")).toHaveTextContent("Seen 1");
	});
});
