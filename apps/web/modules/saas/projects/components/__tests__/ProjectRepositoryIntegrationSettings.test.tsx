/**
 * Tests for the "How AI agents search code" setting (<CodeSearchModeSetting />)
 * and the per-repository "Include in AI code search" switch.
 *
 * History: an earlier toggle rendered a warning block that leaked internal
 * deployment details — a feature-flag env var and "restart the temporal
 * worker". That banner was removed, and the deployment flag is gone. This file
 * locks in the invariants that survive:
 *
 *   - No internal-config copy EVER leaks (no env-var names, no temporal
 *     worker, no "code search not configured", no "indexer isn't running").
 *   - The project mode is one of Off / Code search / RAG, chosen from a
 *     labelled radio group that writes `codeSearchMode`.
 *   - Only RAG shows the refresh interval and the code index status line;
 *     the index status is fetched only in RAG mode.
 *   - RAG has no live-search fallback, so no status promises one.
 *   - Each repository row has an accessible include switch whenever the mode
 *     is not Off.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodeIndexDetailsPanel } from "../CodeIndexDetailsPanel";

// ---------------------------------------------------------------------------
// Mocks — declared BEFORE the component import per Vitest hoisting rules.
// CodeSearchModeSetting reads rag settings from `orpc.projects.ragSettings.get`
// and the index status from `orpc.agents.codeIndex.status` (TanStack queries),
// and writes via `orpcClient.projects.ragSettings.update`. We stub those
// boundaries and let the real useQuery drive rendering.
// ---------------------------------------------------------------------------

type CodeSearchModeFixture = "OFF" | "CODE_SEARCH" | "RAG";

type RagSettingsFixture = {
	settings: {
		codeSearchMode: CodeSearchModeFixture;
		codeIndexRefreshInterval?: string;
	} | null;
};

type CodeIndexFixture = {
	status: string;
	indexedAt: string | null;
	filesIndexed: number;
	chunksCreated: number;
	error: string | null;
};

// Mutable per-test fixtures returned by the mocked queries.
let ragGetFixture: RagSettingsFixture;
let codeIndexFixture: CodeIndexFixture;
// When true, the code-index query stays pending / rejects so the loading and
// error states can be asserted deterministically.
let codeIndexPending = false;
let codeIndexShouldError = false;

const updateMutationFn = vi.fn();
const updateInclusionFn = vi.fn();
// Spy on the code-index status queryFn so tests can assert it fires only in
// RAG mode (the `enabled` gate).
const codeIndexQueryFn = vi.fn(async (): Promise<CodeIndexFixture> => {
	if (codeIndexShouldError) {
		throw new Error("status fetch failed");
	}
	if (codeIndexPending) {
		return new Promise<CodeIndexFixture>(() => {});
	}
	return codeIndexFixture;
});

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			ragSettings: {
				get: {
					queryOptions: (opts: { input: unknown }) => ({
						queryKey: ["rag-settings", opts?.input],
						queryFn: async () => ragGetFixture,
					}),
				},
			},
		},
		agents: {
			codeIndex: {
				status: {
					queryOptions: (opts: { input: unknown }) => ({
						queryKey: ["code-index-status", opts?.input],
						queryFn: codeIndexQueryFn,
					}),
				},
			},
		},
	},
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => false,
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			ragSettings: {
				update: (...args: unknown[]) => updateMutationFn(...args),
			},
			repositoryIntegrations: {
				updateCodeSearchInclusion: (...args: unknown[]) =>
					updateInclusionFn(...args),
			},
		},
	},
}));

// Import AFTER the mocks so the component picks up the stubs.
import {
	CodeSearchModeSetting,
	IntegrationStatusRow,
} from "../ProjectRepositoryIntegrationSettings";

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

function newQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
}

function renderSetting() {
	const queryClient = newQueryClient();
	const utils = render(
		<QueryClientProvider client={queryClient}>
			<CodeSearchModeSetting projectId="proj-1" organizationId={null} />
		</QueryClientProvider>,
	);
	return { ...utils, queryClient };
}

function setMode(mode: CodeSearchModeFixture) {
	ragGetFixture = { settings: { codeSearchMode: mode } };
}

async function findModeGroup() {
	return screen.findByRole("radiogroup", {
		name: /how ai agents search code/i,
	});
}

async function expectChecked(name: RegExp) {
	await waitFor(() => {
		expect(screen.getByRole("radio", { name })).toHaveAttribute(
			"aria-checked",
			"true",
		);
	});
}

function expectNoLeakedInternals() {
	expect(screen.queryByText(/code search not configured/i)).toBeNull();
	expect(screen.queryByText(/FEATURE_CODE_INDEXING/)).toBeNull();
	expect(screen.queryByText(/temporal worker/i)).toBeNull();
	expect(screen.queryByText(/indexer isn't running/i)).toBeNull();
	expect(screen.queryByText(/on this deployment/i)).toBeNull();
}

beforeEach(() => {
	updateMutationFn.mockReset();
	updateMutationFn.mockResolvedValue({});
	updateInclusionFn.mockReset();
	updateInclusionFn.mockResolvedValue({
		integration: { id: "int-1", includedInCodeSearch: false },
	});
	setMode("CODE_SEARCH");
	codeIndexFixture = {
		status: "MISSING",
		indexedAt: null,
		filesIndexed: 0,
		chunksCreated: 0,
		error: null,
	};
	codeIndexPending = false;
	codeIndexShouldError = false;
	codeIndexQueryFn.mockClear();
});

describe("CodeSearchModeSetting — options", () => {
	it("offers Off, Code search and RAG in a labelled radio group", async () => {
		renderSetting();
		await findModeGroup();

		expect(
			screen.getByRole("radio", { name: /^off$/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("radio", { name: /^code search$/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("radio", { name: /^rag$/i }),
		).toBeInTheDocument();
		await expectChecked(/^code search$/i);
		expectNoLeakedInternals();
	});

	it("shows no refresh interval and no status line in Code search mode", async () => {
		renderSetting();
		await findModeGroup();
		await expectChecked(/^code search$/i);

		expect(
			screen.queryByLabelText(/keep the code index up to date/i),
		).toBeNull();
		expect(screen.queryByRole("status")).toBeNull();
		expect(codeIndexQueryFn).not.toHaveBeenCalled();
		expectNoLeakedInternals();
	});

	it("shows no refresh interval and no status line when Off", async () => {
		setMode("OFF");
		renderSetting();
		await findModeGroup();
		await expectChecked(/^off$/i);

		expect(
			screen.queryByLabelText(/keep the code index up to date/i),
		).toBeNull();
		expect(screen.queryByRole("status")).toBeNull();
		expect(codeIndexQueryFn).not.toHaveBeenCalled();
		expectNoLeakedInternals();
	});

	it("shows the refresh interval and fetches the index status in RAG mode", async () => {
		setMode("RAG");
		renderSetting();
		await findModeGroup();
		await expectChecked(/^rag$/i);

		expect(
			await screen.findByLabelText(/keep the code index up to date/i),
		).toBeInTheDocument();
		await waitFor(() => {
			expect(codeIndexQueryFn).toHaveBeenCalled();
		});
	});
});

describe("CodeSearchModeSetting — changing the mode", () => {
	it("writes codeSearchMode when another option is chosen", async () => {
		const user = userEvent.setup();
		renderSetting();
		await findModeGroup();
		await expectChecked(/^code search$/i);

		await user.click(screen.getByRole("radio", { name: /^rag$/i }));

		await waitFor(() => {
			expect(updateMutationFn).toHaveBeenCalledTimes(1);
		});
		expect(updateMutationFn).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: null,
			codeSearchMode: "RAG",
		});
	});

	it("refreshes the capability gates once the mode changes (Fizzy #1930)", async () => {
		// The mode decides whether a gate says "turn code search on" or "start
		// indexing"; the gates must re-read when it moves.
		setMode("OFF");
		const user = userEvent.setup();
		const { queryClient } = renderSetting();
		const invalidate = vi.spyOn(queryClient, "invalidateQueries");
		await findModeGroup();
		await expectChecked(/^off$/i);

		await user.click(screen.getByRole("radio", { name: /^code search$/i }));

		await waitFor(() =>
			expect(invalidate).toHaveBeenCalledWith({
				queryKey: ["capability-gates"],
			}),
		);
	});
});

describe("CodeSearchModeSetting — RAG index status", () => {
	beforeEach(() => setMode("RAG"));

	it("reports a ready index with the file count", async () => {
		codeIndexFixture = {
			status: "READY",
			indexedAt: new Date().toISOString(),
			filesIndexed: 1234,
			chunksCreated: 5678,
			error: null,
		};
		renderSetting();

		const status = await screen.findByRole("status");
		await waitFor(() => {
			expect(status).toHaveTextContent(/code indexed/i);
		});
		// Locale-robust: the count is rendered via toLocaleString().
		expect(status).toHaveTextContent(`${(1234).toLocaleString()} files`);
		expectNoLeakedInternals();
	});

	it("shows a neutral checking state while the index status loads", async () => {
		codeIndexPending = true; // query never resolves → stays loading
		renderSetting();

		const status = await screen.findByRole("status");
		expect(status).toHaveTextContent(/checking the code index status/i);
		// The loading state must not read as an unindexed project.
		expect(status).not.toHaveTextContent(/not indexed yet/i);
		expectNoLeakedInternals();
	});

	it("reports index failure without promising a live-search fallback", async () => {
		codeIndexFixture = {
			status: "FAILED",
			indexedAt: null,
			filesIndexed: 0,
			chunksCreated: 0,
			error: "boom",
		};
		renderSetting();

		const status = await screen.findByRole("status");
		await waitFor(() => {
			expect(status).toHaveTextContent(/indexing failed/i);
		});
		expect(status).not.toHaveTextContent(/live search/i);
		// A raw backend error string must not surface to the user.
		expect(screen.queryByText(/boom/)).toBeNull();
		expectNoLeakedInternals();
	});

	it("says the code is not indexed yet for a missing index", async () => {
		renderSetting();

		const status = await screen.findByRole("status");
		await waitFor(() => {
			expect(status).toHaveTextContent(/not indexed yet/i);
		});
		expect(status).not.toHaveTextContent(/live search/i);
		expectNoLeakedInternals();
	});

	it("reports a queued index", async () => {
		codeIndexFixture = { ...codeIndexFixture, status: "PENDING" };
		renderSetting();

		const status = await screen.findByRole("status");
		await waitFor(() => {
			expect(status).toHaveTextContent(/code index queued/i);
		});
	});

	it("reports an index being built", async () => {
		codeIndexFixture = { ...codeIndexFixture, status: "INDEXING" };
		renderSetting();

		const status = await screen.findByRole("status");
		await waitFor(() => {
			expect(status).toHaveTextContent(/building the code index/i);
		});
	});

	it("reports a stale index that refreshes on the next change", async () => {
		codeIndexFixture = { ...codeIndexFixture, status: "STALE" };
		renderSetting();

		const status = await screen.findByRole("status");
		await waitFor(() => {
			expect(status).toHaveTextContent(/out of date/i);
		});
		expect(status).toHaveTextContent(/refreshes on the next change/i);
	});

	it("stays honest when the status lookup fails — never a false 'not indexed'", async () => {
		codeIndexShouldError = true;
		renderSetting();

		const status = await screen.findByRole("status");
		await waitFor(() => {
			expect(status).toHaveTextContent(
				/couldn't check the code index status/i,
			);
		});
		// A failed lookup must NOT be reported as an unindexed project…
		expect(status).not.toHaveTextContent(/not indexed yet/i);
		// …and must not leak the raw query error.
		expect(screen.queryByText(/status fetch failed/i)).toBeNull();
		expectNoLeakedInternals();
	});
});

describe("IntegrationStatusRow — Include in AI code search", () => {
	const baseIntegration = {
		id: "int-1",
		status: "ACTIVE",
		provider: "GITHUB",
		repositoryOwner: "example-org",
		repositoryName: "example-repo",
		roleTag: null,
	};

	function renderRow(
		overrides: Partial<
			React.ComponentProps<typeof IntegrationStatusRow>
		> = {},
	) {
		const queryClient = newQueryClient();
		render(
			<QueryClientProvider client={queryClient}>
				<IntegrationStatusRow
					integration={baseIntegration}
					projectId="proj-1"
					organizationId={null}
					canManageIntegrations
					onReconnect={vi.fn()}
					onEdit={vi.fn()}
					onDisconnect={vi.fn()}
					isDisconnecting={false}
					codeSearchMode="CODE_SEARCH"
					{...overrides}
				/>
			</QueryClientProvider>,
		);
		return { queryClient };
	}

	const switchName = /include example-org\/example-repo in ai code search/i;

	it("names the repository in the switch and defaults to included", () => {
		renderRow();
		expect(
			screen.getByRole("switch", { name: switchName }),
		).toHaveAttribute("aria-checked", "true");
	});

	it("is hidden when the project mode is Off", () => {
		renderRow({ codeSearchMode: "OFF" });
		expect(screen.queryByRole("switch", { name: switchName })).toBeNull();
	});

	it("is hidden on the legacy fallback row", () => {
		renderRow({ isLegacy: true });
		expect(screen.queryByRole("switch", { name: switchName })).toBeNull();
	});

	it("writes the inclusion through updateCodeSearchInclusion", async () => {
		const user = userEvent.setup();
		renderRow();

		await user.click(screen.getByRole("switch", { name: switchName }));

		await waitFor(() => {
			expect(updateInclusionFn).toHaveBeenCalledWith({
				projectId: "proj-1",
				integrationId: "int-1",
				organizationId: null,
				included: false,
			});
		});
	});

	it("explains an excluded repository in plain words", () => {
		renderRow({
			integration: { ...baseIntegration, includedInCodeSearch: false },
		});
		expect(
			screen.getByRole("switch", { name: switchName }),
		).toHaveAttribute("aria-checked", "false");
		expect(
			screen.getByText(/ai agents don't search or read this repository/i),
		).toBeInTheDocument();
		expectNoLeakedInternals();
	});

	it("is read-only for people who can't manage repositories", () => {
		renderRow({ canManageIntegrations: false });
		expect(screen.getByRole("switch", { name: switchName })).toBeDisabled();
	});

	it("offers no indexing controls for an excluded repository in RAG mode", async () => {
		const user = userEvent.setup();
		renderRow({
			codeSearchMode: "RAG",
			integration: {
				...baseIntegration,
				includedInCodeSearch: false,
				codeIndex: null,
			},
		});

		await user.click(
			screen.getByRole("button", {
				name: /manage example-org\/example-repo/i,
			}),
		);
		expect(
			screen.queryByRole("menuitem", {
				name: /index codebase|re-index/i,
			}),
		).toBeNull();
	});
});

describe("First-Time Codebase Indexing Warning Suppression", () => {
	function renderPanel(
		overrides: Partial<
			React.ComponentProps<typeof CodeIndexDetailsPanel>
		> = {},
	) {
		const onReindexMock = vi.fn();
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});

		render(
			<QueryClientProvider client={queryClient}>
				<CodeIndexDetailsPanel
					projectId="proj-1"
					organizationId={null}
					repositoryIntegrationId="repo-1"
					codeIndex={null}
					isStateKnown={true}
					canManageIntegrations={true}
					onReindex={onReindexMock}
					{...overrides}
				/>
			</QueryClientProvider>,
		);
		return { onReindexMock };
	}

	it("renders first-time indexing prompt banner when codeIndex is canonical null", () => {
		renderPanel({ codeIndex: null, isStateKnown: true });

		expect(screen.getByText("Index your codebase")).toBeInTheDocument();
		expect(screen.getByText("Start indexing")).toBeInTheDocument();
	});

	it("hides prompt banner when index state is indeterminate (fallback/loading)", () => {
		renderPanel({ codeIndex: null, isStateKnown: false });

		expect(
			screen.queryByText("Index your codebase"),
		).not.toBeInTheDocument();
	});

	it("hides prompt banner when prior failed or partial index record exists", () => {
		renderPanel({
			codeIndex: {
				status: "FAILED",
				indexedAt: "2026-08-01T00:00:00Z",
			},
			isStateKnown: true,
		});

		expect(
			screen.queryByText("Index your codebase"),
		).not.toBeInTheDocument();
	});

	it("labels a user-cancelled index as cancelled, not failed", () => {
		renderPanel({
			codeIndex: { status: "FAILED", cancelled: true },
			isStateKnown: true,
		});

		expect(screen.getByText("Indexing cancelled")).toBeInTheDocument();
		expect(screen.queryByText("Indexing failed")).not.toBeInTheDocument();
	});

	it("keeps the failed label for an index that broke", () => {
		renderPanel({
			codeIndex: { status: "FAILED", cancelled: false },
			isStateKnown: true,
		});

		expect(screen.getByText("Indexing failed")).toBeInTheDocument();
	});

	it("hides prompt banner when user lacks management permissions", () => {
		renderPanel({ codeIndex: null, canManageIntegrations: false });

		expect(
			screen.queryByText("Index your codebase"),
		).not.toBeInTheDocument();
	});

	it("hides prompt banner when project carries a legacy null-keyed index record", () => {
		renderPanel({
			codeIndex: null,
			isStateKnown: true,
			hasLegacyIndexRecord: true,
		});

		expect(
			screen.queryByText("Index your codebase"),
		).not.toBeInTheDocument();
	});
});
