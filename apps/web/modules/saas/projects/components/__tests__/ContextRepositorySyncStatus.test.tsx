/**
 * Living Memory's repository-sync status widget (design 2026-09-23 §7.1,
 * Fizzy #2657):
 *  - "Sync from repository" only for a configurer with an ACTIVE integration
 *    and nothing configured; nothing at all for a reader with nothing
 *    configured;
 *  - once configured, the repository/branch line and each last-applied
 *    outcome sentence (applied / partial / failed / not synced), the
 *    awaiting-index and cleanup-pending notes, and the attention list;
 *  - "Sync now" spins while running and is disabled meanwhile;
 *  - the menu's "Change branch or paths…" and "Disconnect" (behind a
 *    confirmation naming the repository);
 *  - a read-only member sees the status only — no button, no menu.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextSyncState } from "../../lib/context-repository-sync";

beforeAll(() => {
	if (typeof globalThis.ResizeObserver === "undefined") {
		class ResizeObserverPolyfill {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		}
		(
			globalThis as unknown as {
				ResizeObserver: typeof ResizeObserverPolyfill;
			}
		).ResizeObserver = ResizeObserverPolyfill;
	}
	if (typeof Element.prototype.hasPointerCapture === "undefined") {
		Element.prototype.hasPointerCapture = () => false;
	}
	if (typeof Element.prototype.scrollIntoView === "undefined") {
		Element.prototype.scrollIntoView = () => undefined;
	}
});

const { syncNowMock, disableMock, configureMock } = vi.hoisted(() => ({
	syncNowMock: vi.fn(),
	disableMock: vi.fn(),
	configureMock: vi.fn(),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			contexts: {
				repositorySync: {
					configure: {
						mutationOptions: () => ({
							mutationFn: (input: unknown) =>
								configureMock(input),
						}),
					},
					syncNow: {
						mutationOptions: (
							opts: Record<string, unknown> = {},
						) => ({
							mutationFn: (input: unknown) => syncNowMock(input),
							...opts,
						}),
					},
					disable: {
						mutationOptions: (
							opts: Record<string, unknown> = {},
						) => ({
							mutationFn: (input: unknown) => disableMock(input),
							...opts,
						}),
					},
					// The configure dialog's tree browser (Fizzy #2674); its
					// behavior is covered by the dialog's own test.
					listTree: {
						queryOptions: (options: {
							input: unknown;
							[key: string]: unknown;
						}) => ({
							...options,
							queryKey: ["listTree", options.input],
							queryFn: () => ({
								supported: true,
								entries: [],
								truncated: false,
							}),
						}),
					},
				},
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("date-fns", () => ({
	formatDistanceToNow: () => "3 minutes",
}));

vi.mock("next-intl", () => {
	function makeT(namespace: string) {
		const t = (key: string, values?: Record<string, unknown>) =>
			values
				? `${namespace}.${key}${JSON.stringify(values)}`
				: `${namespace}.${key}`;
		return t;
	}
	return {
		useTranslations: (namespace: string) => makeT(namespace),
	};
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ContextRepositorySyncStatus } from "../ContextRepositorySyncStatus";

function wrap(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

const NS = "projects.contexts.livingMemory.repositorySync";

const INTEGRATION = {
	id: "int_1",
	provider: "GITHUB",
	repositoryOwner: "example-org",
	repositoryName: "memory",
	defaultBranch: "main",
	status: "ACTIVE",
};

const CONFIGURED_BASE: ContextSyncState["configured"] = {
	syncId: "sync_1",
	repositoryIntegrationId: "int_1",
	ref: "main",
	paths: ["docs"],
	lastAppliedCommitSha: "abc1234def5678",
	configuredByName: "Example Member",
	createdAt: "2026-09-23T09:00:00.000Z",
	updatedAt: "2026-09-23T09:00:00.000Z",
	integration: {
		provider: "GITHUB",
		repositoryOwner: "example-org",
		repositoryName: "memory",
		status: "ACTIVE",
	},
};

function emptyRun(): NonNullable<ContextSyncState["lastAppliedRun"]> {
	return {
		id: "sync_1:run_a",
		trigger: "MANUAL",
		startedAt: "2026-09-23T10:00:00.000Z",
		finishedAt: "2026-09-23T10:01:00.000Z",
		status: "SUCCEEDED",
		error: null,
		commitSha: "abc1234def5678901234567890123456789abcd",
		userName: "Example Member",
		counts: {
			created: 14,
			updated: 0,
			adopted: 0,
			unchanged: 0,
			conflict: 0,
			pathInUse: 0,
			removed: 0,
			pruneConflicts: 0,
		},
		plan: null,
		applyAttention: [],
		pruneConflicts: { keys: [], overflow: 0 },
	};
}

function baseState(
	overrides: Partial<ContextSyncState> = {},
): ContextSyncState {
	return {
		canConfigure: true,
		running: false,
		configured: null,
		latestRun: null,
		lastAppliedRun: null,
		managedCount: 0,
		awaitingIndexCount: 0,
		cleanupPending: 0,
		availableIntegrations: [INTEGRATION],
		...overrides,
	};
}

function renderStatus(
	overrides: Partial<
		React.ComponentProps<typeof ContextRepositorySyncStatus>
	> = {},
) {
	const onChanged = vi.fn();
	wrap(
		<ContextRepositorySyncStatus
			projectId="proj_1"
			organizationId="org_1"
			state={baseState()}
			onChanged={onChanged}
			{...overrides}
		/>,
	);
	return { onChanged };
}

describe("ContextRepositorySyncStatus — entry point", () => {
	beforeEach(() => {
		syncNowMock.mockReset();
		disableMock.mockReset();
		configureMock.mockReset();
	});

	it("renders nothing while state is undefined (loading)", () => {
		const { container } = wrap(
			<ContextRepositorySyncStatus
				projectId="proj_1"
				organizationId="org_1"
				state={undefined}
				onChanged={vi.fn()}
			/>,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("offers Sync from repository to a configurer with an ACTIVE integration and nothing configured", () => {
		renderStatus();
		expect(
			screen.getByTestId("context-sync-from-repository"),
		).toHaveTextContent(`${NS}.entry`);
	});

	it("renders nothing for a reader with nothing configured", () => {
		const { container } = wrap(
			<ContextRepositorySyncStatus
				projectId="proj_1"
				organizationId="org_1"
				state={baseState({ canConfigure: false })}
				onChanged={vi.fn()}
			/>,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("renders nothing when nothing is configured and no ACTIVE integration exists", () => {
		const { container } = wrap(
			<ContextRepositorySyncStatus
				projectId="proj_1"
				organizationId="org_1"
				state={baseState({ availableIntegrations: [] })}
				onChanged={vi.fn()}
			/>,
		);
		expect(container).toBeEmptyDOMElement();
	});
});

describe("ContextRepositorySyncStatus — configured status line", () => {
	beforeEach(() => {
		syncNowMock.mockReset();
		disableMock.mockReset();
		configureMock.mockReset();
	});

	it("shows the repository @ ref line", () => {
		renderStatus({
			state: baseState({ configured: CONFIGURED_BASE }),
		});
		expect(
			screen.getByText(
				`${NS}.repositoryLine{"repository":"example-org/memory","ref":"main"}`,
			),
		).toBeInTheDocument();
	});

	it("says Not synced yet when nothing has been applied", () => {
		renderStatus({
			state: baseState({
				configured: CONFIGURED_BASE,
				lastAppliedRun: null,
			}),
		});
		expect(
			screen.getByTestId("context-sync-status-line"),
		).toHaveTextContent(`${NS}.status.notSynced`);
	});

	it("says Applied with the commit, time and file count on SUCCEEDED", () => {
		renderStatus({
			state: baseState({
				configured: CONFIGURED_BASE,
				lastAppliedRun: emptyRun(),
			}),
		});
		expect(
			screen.getByTestId("context-sync-status-line"),
		).toHaveTextContent(
			`${NS}.status.applied${JSON.stringify({
				sha: "abc1234",
				count: 14,
				time: "3 minutes",
			})}`,
		);
	});

	it("says Partially applied with the kept-older count on PARTIAL", () => {
		renderStatus({
			state: baseState({
				configured: CONFIGURED_BASE,
				lastAppliedRun: {
					...emptyRun(),
					status: "PARTIAL",
					counts: {
						...emptyRun().counts,
						created: 3,
						conflict: 2,
					},
				},
			}),
		});
		expect(
			screen.getByTestId("context-sync-status-line"),
		).toHaveTextContent(
			`${NS}.status.partial${JSON.stringify({ sha: "abc1234", count: 2 })}`,
		);
	});

	it("says Sync failed part-way on FAILED", () => {
		renderStatus({
			state: baseState({
				configured: CONFIGURED_BASE,
				lastAppliedRun: { ...emptyRun(), status: "FAILED" },
			}),
		});
		expect(
			screen.getByTestId("context-sync-status-line"),
		).toHaveTextContent(
			`${NS}.status.failed${JSON.stringify({ sha: "abc1234" })}`,
		);
	});

	it("shows a spinner and the running line instead of the status line while running", () => {
		renderStatus({
			state: baseState({
				configured: CONFIGURED_BASE,
				running: true,
				lastAppliedRun: emptyRun(),
			}),
		});
		expect(screen.getByTestId("context-sync-running")).toHaveTextContent(
			`${NS}.running`,
		);
		expect(
			screen.queryByTestId("context-sync-status-line"),
		).not.toBeInTheDocument();
	});

	it("shows the awaiting-index note only while awaitingIndexCount > 0", () => {
		renderStatus({
			state: baseState({
				configured: CONFIGURED_BASE,
				awaitingIndexCount: 4,
			}),
		});
		expect(
			screen.getByTestId("context-sync-awaiting-index"),
		).toHaveTextContent(
			`${NS}.awaitingIndex${JSON.stringify({ count: 4 })}`,
		);
	});

	it("omits the awaiting-index note when nothing awaits indexing", () => {
		renderStatus({ state: baseState({ configured: CONFIGURED_BASE }) });
		expect(
			screen.queryByTestId("context-sync-awaiting-index"),
		).not.toBeInTheDocument();
	});

	it("shows the cleanup-pending note only while cleanupPending > 0", () => {
		renderStatus({
			state: baseState({
				configured: CONFIGURED_BASE,
				cleanupPending: 2,
			}),
		});
		expect(
			screen.getByTestId("context-sync-cleanup-pending"),
		).toHaveTextContent(
			`${NS}.cleanupPending${JSON.stringify({ count: 2 })}`,
		);
	});

	it("lists attention items with copy per reason", () => {
		renderStatus({
			state: baseState({
				configured: CONFIGURED_BASE,
				lastAppliedRun: {
					...emptyRun(),
					status: "PARTIAL",
					applyAttention: [
						{ key: "docs/a.md", reason: "conflict" },
						{ key: "docs/b.md", reason: "path-in-use" },
					],
				},
			}),
		});
		const list = screen.getByTestId("context-sync-attention");
		expect(
			within(list).getByText(
				`${NS}.attention.conflict${JSON.stringify({ key: "docs/a.md" })}`,
			),
		).toBeInTheDocument();
		expect(
			within(list).getByText(
				`${NS}.attention.path-in-use${JSON.stringify({ key: "docs/b.md" })}`,
			),
		).toBeInTheDocument();
	});
});

describe("ContextRepositorySyncStatus — Sync now and the menu", () => {
	beforeEach(() => {
		syncNowMock.mockReset();
		disableMock.mockReset();
		configureMock.mockReset();
	});

	it("triggers syncNow and reports the result", async () => {
		syncNowMock.mockResolvedValue({ started: true });
		const user = userEvent.setup();
		renderStatus({ state: baseState({ configured: CONFIGURED_BASE }) });

		await user.click(screen.getByTestId("context-sync-now"));
		await waitFor(() =>
			expect(syncNowMock).toHaveBeenCalledWith({
				projectId: "proj_1",
				organizationId: "org_1",
			}),
		);
	});

	it("disables Sync now while a run is running", () => {
		renderStatus({
			state: baseState({ configured: CONFIGURED_BASE, running: true }),
		});
		expect(screen.getByTestId("context-sync-now")).toBeDisabled();
	});

	it("Change branch or paths… opens the configure dialog", async () => {
		const user = userEvent.setup();
		renderStatus({ state: baseState({ configured: CONFIGURED_BASE }) });

		await user.click(screen.getByTestId("context-sync-menu-trigger"));
		await user.click(await screen.findByTestId("context-sync-change"));

		expect(
			await screen.findByText(`${NS}.configureDialog.title`),
		).toBeInTheDocument();
	});

	it("Disconnect asks for confirmation naming the repository before calling disable", async () => {
		disableMock.mockResolvedValue({ disabled: true, managedCount: 3 });
		const user = userEvent.setup();
		renderStatus({ state: baseState({ configured: CONFIGURED_BASE }) });

		await user.click(screen.getByTestId("context-sync-menu-trigger"));
		await user.click(await screen.findByTestId("context-sync-disconnect"));

		expect(
			screen.getByText(
				`${NS}.disconnectConfirm.title${JSON.stringify({
					repository: "example-org/memory",
				})}`,
			),
		).toBeInTheDocument();
		expect(disableMock).not.toHaveBeenCalled();

		await user.click(screen.getByTestId("context-sync-disconnect-confirm"));
		await waitFor(() =>
			expect(disableMock).toHaveBeenCalledWith({
				projectId: "proj_1",
				organizationId: "org_1",
			}),
		);
	});
});

describe("ContextRepositorySyncStatus — read-only member", () => {
	beforeEach(() => {
		syncNowMock.mockReset();
		disableMock.mockReset();
		configureMock.mockReset();
	});

	it("sees the status line but no Sync now button or menu", () => {
		renderStatus({
			state: baseState({
				configured: CONFIGURED_BASE,
				canConfigure: false,
				lastAppliedRun: emptyRun(),
			}),
		});
		expect(
			screen.getByTestId("context-sync-status-line"),
		).toBeInTheDocument();
		expect(
			screen.queryByTestId("context-sync-now"),
		).not.toBeInTheDocument();
		expect(
			screen.queryByTestId("context-sync-menu-trigger"),
		).not.toBeInTheDocument();
	});
});
