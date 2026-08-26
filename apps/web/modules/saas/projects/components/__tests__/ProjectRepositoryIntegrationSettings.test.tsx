/**
 * Tests for the code-search status surface in <CodeSearchToggle />.
 *
 * History: the toggle once rendered a warning block that leaked internal
 * deployment details — `FEATURE_CODE_INDEXING=true` and "restart the temporal
 * worker" — whenever code search was on but the indexing flag was off. That
 * leaky banner was removed. This file locks in the invariant that survives, and
 * covers the honest, user-facing status line that replaced it:
 *
 *   - No internal-config copy EVER leaks (no FEATURE_CODE_INDEXING, no temporal
 *     worker, no "code search not configured", no "indexer isn't running").
 *   - When code search is on but the deployment isn't indexing, the user is told
 *     plainly that search runs live on-demand (not silently degraded).
 *   - When indexing is on, the row reflects the real ProjectCodeIndex status
 *     (READY / FAILED / …) so the user knows whether a pre-built index is used.
 *   - The toggle itself still fires the update mutation.
 *
 * The status line is a deliberate, non-leaky element and uses role="status" as a
 * polite live region — distinct from the removed banner, whose problem was the
 * copy, not the role.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodeIndexDetailsPanel } from "../CodeIndexDetailsPanel";

// ---------------------------------------------------------------------------
// Mocks — declared BEFORE the component import per Vitest hoisting rules.
// CodeSearchToggle reads rag settings from `orpc.projects.ragSettings.get` and
// the index status from `orpc.agents.codeIndex.status` (TanStack queries), and
// writes via `orpcClient.projects.ragSettings.update`. We stub those boundaries
// and let the real useQuery drive rendering.
// ---------------------------------------------------------------------------

type RagSettingsFixture = {
	settings: {
		codeSearchEnabled: boolean;
		codeSearchProvider: string | null;
	} | null;
	featureCodeIndexingEnabled: boolean;
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
// Spy on the code-index status queryFn so tests can assert it fires only when
// the toggle AND the deployment flag are both on (the `enabled` gate).
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

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			ragSettings: {
				update: (...args: unknown[]) => updateMutationFn(...args),
			},
		},
	},
}));

// Import AFTER the mocks so the component picks up the stubs.
import { CodeSearchToggle } from "../ProjectRepositoryIntegrationSettings";

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

function renderToggle() {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const utils = render(
		<QueryClientProvider client={queryClient}>
			<CodeSearchToggle projectId="proj-1" organizationId={null} />
		</QueryClientProvider>,
	);
	return { ...utils, queryClient };
}

async function findToggle() {
	return screen.findByRole("switch", {
		name: /enable code search for ai agents/i,
	});
}

function expectNoLeakedInternals() {
	expect(screen.queryByText(/code search not configured/i)).toBeNull();
	expect(screen.queryByText(/FEATURE_CODE_INDEXING/)).toBeNull();
	expect(screen.queryByText(/temporal worker/i)).toBeNull();
	expect(screen.queryByText(/indexer isn't running/i)).toBeNull();
}

/** Deployment has indexing turned on and code search enabled. */
function enableIndexing() {
	ragGetFixture = {
		settings: { codeSearchEnabled: true, codeSearchProvider: "api" },
		featureCodeIndexingEnabled: true,
	};
}

beforeEach(() => {
	updateMutationFn.mockReset();
	updateMutationFn.mockResolvedValue({
		settings: { codeSearchEnabled: true, codeSearchProvider: "api" },
	});
	// Default: the exact state that used to trigger the leaky banner —
	// code search ON, indexing feature flag OFF.
	ragGetFixture = {
		settings: { codeSearchEnabled: true, codeSearchProvider: "api" },
		featureCodeIndexingEnabled: false,
	};
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

describe("CodeSearchToggle — no leaked internals", () => {
	it("never leaks internal config, even when code search is on and indexing is off", async () => {
		renderToggle();

		const toggle = await findToggle();
		await waitFor(() => {
			expect(toggle).toHaveAttribute("aria-checked", "true");
		});

		expectNoLeakedInternals();
	});

	it("shows no status line and no leaked copy when code search is disabled", async () => {
		ragGetFixture = {
			settings: { codeSearchEnabled: false, codeSearchProvider: null },
			featureCodeIndexingEnabled: false,
		};
		renderToggle();

		const toggle = await findToggle();
		await waitFor(() => {
			expect(toggle).toHaveAttribute("aria-checked", "false");
		});

		expect(screen.queryByRole("status")).toBeNull();
		expectNoLeakedInternals();
	});
});

describe("CodeSearchToggle — honest code-search status", () => {
	it("tells the user search is live on-demand when the deployment isn't indexing", async () => {
		// codeSearchEnabled=true, featureCodeIndexingEnabled=false (default fixture).
		renderToggle();
		await findToggle();

		const status = await screen.findByRole("status");
		expect(status).toHaveTextContent(/live on-demand search/i);
		expectNoLeakedInternals();
	});

	it("reports a ready pre-built index with the file count", async () => {
		ragGetFixture = {
			settings: { codeSearchEnabled: true, codeSearchProvider: "api" },
			featureCodeIndexingEnabled: true,
		};
		codeIndexFixture = {
			status: "READY",
			indexedAt: new Date().toISOString(),
			filesIndexed: 1234,
			chunksCreated: 5678,
			error: null,
		};
		renderToggle();
		await findToggle();

		const status = await screen.findByRole("status");
		await waitFor(() => {
			expect(status).toHaveTextContent(/code indexed/i);
		});
		// Locale-robust: the count is rendered via toLocaleString().
		expect(status).toHaveTextContent(`${(1234).toLocaleString()} files`);
		expectNoLeakedInternals();
	});

	it("shows a neutral checking state while the index status loads", async () => {
		ragGetFixture = {
			settings: { codeSearchEnabled: true, codeSearchProvider: "api" },
			featureCodeIndexingEnabled: true,
		};
		codeIndexPending = true; // query never resolves → stays loading
		renderToggle();
		await findToggle();

		const status = await screen.findByRole("status");
		expect(status).toHaveTextContent(/checking the code index status/i);
		// The loading state must not read as an unindexed project.
		expect(status).not.toHaveTextContent(/not indexed yet/i);
		expectNoLeakedInternals();
	});

	it("reports index failure as a fall back to live search", async () => {
		ragGetFixture = {
			settings: { codeSearchEnabled: true, codeSearchProvider: "api" },
			featureCodeIndexingEnabled: true,
		};
		codeIndexFixture = {
			status: "FAILED",
			indexedAt: null,
			filesIndexed: 0,
			chunksCreated: 0,
			error: "boom",
		};
		renderToggle();
		await findToggle();

		const status = await screen.findByRole("status");
		await waitFor(() => {
			expect(status).toHaveTextContent(/indexing failed/i);
		});
		expect(status).toHaveTextContent(/fall back to live search/i);
		// A raw backend error string must not surface to the user.
		expect(screen.queryByText(/boom/)).toBeNull();
		expectNoLeakedInternals();
	});
});

describe("CodeSearchToggle — index states (indexing on)", () => {
	it("says the code is not indexed yet for a missing index", async () => {
		enableIndexing();
		codeIndexFixture = { ...codeIndexFixture, status: "MISSING" };
		renderToggle();
		await findToggle();

		const status = await screen.findByRole("status");
		await waitFor(() => {
			expect(status).toHaveTextContent(/not indexed yet/i);
		});
		expectNoLeakedInternals();
	});

	it("reports a queued index", async () => {
		enableIndexing();
		codeIndexFixture = { ...codeIndexFixture, status: "PENDING" };
		renderToggle();
		await findToggle();

		const status = await screen.findByRole("status");
		await waitFor(() => {
			expect(status).toHaveTextContent(/code index queued/i);
		});
		expectNoLeakedInternals();
	});

	it("reports an index being built", async () => {
		enableIndexing();
		codeIndexFixture = { ...codeIndexFixture, status: "INDEXING" };
		renderToggle();
		await findToggle();

		const status = await screen.findByRole("status");
		await waitFor(() => {
			expect(status).toHaveTextContent(/building the code index/i);
		});
		expectNoLeakedInternals();
	});

	it("reports a stale index that refreshes on the next change", async () => {
		enableIndexing();
		codeIndexFixture = { ...codeIndexFixture, status: "STALE" };
		renderToggle();
		await findToggle();

		const status = await screen.findByRole("status");
		await waitFor(() => {
			expect(status).toHaveTextContent(/out of date/i);
		});
		expect(status).toHaveTextContent(/refreshes on the next change/i);
		expectNoLeakedInternals();
	});

	it("stays honest when the status lookup fails — never a false 'not indexed'", async () => {
		enableIndexing();
		codeIndexShouldError = true;
		renderToggle();
		await findToggle();

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

describe("CodeSearchToggle — status query gating", () => {
	it("does not fetch index status when code search is disabled", async () => {
		ragGetFixture = {
			settings: { codeSearchEnabled: false, codeSearchProvider: null },
			featureCodeIndexingEnabled: true,
		};
		renderToggle();

		const toggle = await findToggle();
		await waitFor(() => {
			expect(toggle).toHaveAttribute("aria-checked", "false");
		});
		expect(codeIndexQueryFn).not.toHaveBeenCalled();
	});

	it("does not fetch index status when the deployment isn't indexing", async () => {
		// codeSearchEnabled=true, featureCodeIndexingEnabled=false (default fixture).
		renderToggle();

		const toggle = await findToggle();
		await waitFor(() => {
			expect(toggle).toHaveAttribute("aria-checked", "true");
		});
		expect(codeIndexQueryFn).not.toHaveBeenCalled();
	});

	it("fetches index status only when the toggle and the flag are both on", async () => {
		enableIndexing();
		renderToggle();
		await findToggle();

		await waitFor(() => {
			expect(codeIndexQueryFn).toHaveBeenCalled();
		});
	});
});

describe("CodeSearchToggle — toggle behaviour", () => {
	it("keeps the toggle functional — flipping it off calls the update mutation", async () => {
		const user = userEvent.setup();
		renderToggle();

		const toggle = await findToggle();
		await waitFor(() => {
			expect(toggle).toHaveAttribute("aria-checked", "true");
		});

		await user.click(toggle);

		await waitFor(() => {
			expect(updateMutationFn).toHaveBeenCalledTimes(1);
		});
		expect(updateMutationFn).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				organizationId: null,
				codeSearchEnabled: false,
				codeSearchProvider: null,
			}),
		);
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
