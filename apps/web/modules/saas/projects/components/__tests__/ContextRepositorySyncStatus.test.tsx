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
 *  - a read-only member sees the status only — no button, no menu;
 *  - automatic sync (design §11.1, Fizzy #2673): the status line names the
 *    applied run's trigger, the menu's "Automatic sync" toggle calls
 *    `configure` with the stored repository, branch and paths and the
 *    flipped flag, a pause shows its reason and "Re-enable" (which reopens
 *    the configure dialog) only while automatic sync is on, and a reader
 *    sees the state as text.
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
						mutationOptions: (
							opts: Record<string, unknown> = {},
						) => ({
							mutationFn: (input: unknown) =>
								configureMock(input),
							...opts,
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
					// The configure dialog's selection tree (Fizzy #2674, #2750); its
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
import { toast } from "sonner";
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
	// `get` returns what the sync leaves out (Fizzy #2750 §5.5).
	excludedPaths: [],
	automatic: false,
	automaticPausedReason: null,
	automaticPausedAt: null,
	nextCheckAt: "2026-09-23T09:00:00.000Z",
	failureCount: 0,
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
		latestFinishedRun: null,
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

	it("says what syncs under the repository line, without a count, since no listing is read here (Fizzy #2750 §6)", () => {
		renderStatus({
			state: baseState({
				configured: {
					...CONFIGURED_BASE,
					paths: ["docs", "notes/today.md"],
					excludedPaths: ["docs/old"],
				} as NonNullable<ContextSyncState["configured"]>,
			}),
		});
		expect(
			screen.getByTestId("context-sync-selection-summary"),
		).toHaveTextContent(
			`${NS}.summary.leadExcept${JSON.stringify({
				excluded: 1,
				what: `${NS}.summary.what.paths${JSON.stringify({ count: 2 })}`,
			})}`,
		);
		expect(screen.queryByText(/summary\.matchNow/)).not.toBeInTheDocument();
	});

	it("names the whole repository when that is what syncs", () => {
		renderStatus({
			state: baseState({
				configured: {
					...CONFIGURED_BASE,
					paths: [""],
				} as NonNullable<ContextSyncState["configured"]>,
			}),
		});
		expect(
			screen.getByTestId("context-sync-selection-summary"),
		).toHaveTextContent(
			`${NS}.summary.lead${JSON.stringify({
				what: `${NS}.summary.what.wholeRepository`,
			})}`,
		);
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

const CONFIGURED = CONFIGURED_BASE as NonNullable<
	ContextSyncState["configured"]
>;

describe("ContextRepositorySyncStatus — run trigger", () => {
	it.each([
		["MANUAL", "triggers.MANUAL"],
		["POLL", "triggers.POLL"],
		["WEBHOOK", "triggers.WEBHOOK"],
	])("names a %s run on the status line", (trigger, key) => {
		renderStatus({
			state: baseState({
				configured: CONFIGURED,
				lastAppliedRun: { ...emptyRun(), trigger },
			}),
		});
		expect(
			screen.getByTestId("context-sync-status-line"),
		).toHaveTextContent(`${NS}.${key}`);
	});

	it("names no trigger while nothing was applied, even after a run that never reached a commit", () => {
		// The status line describes the last APPLIED run; a later run that
		// failed before pinning a commit has not replaced it.
		renderStatus({
			state: baseState({
				configured: CONFIGURED,
				lastAppliedRun: null,
				latestRun: {
					...emptyRun(),
					trigger: "POLL",
					status: "FAILED",
					error: "REF_MISSING",
					commitSha: null,
				},
			}),
		});
		expect(
			screen.getByTestId("context-sync-status-line"),
		).not.toHaveTextContent(`${NS}.triggers.`);
	});
});

describe("ContextRepositorySyncStatus — automatic sync toggle", () => {
	beforeEach(() => {
		syncNowMock.mockReset();
		disableMock.mockReset();
		configureMock.mockReset();
		vi.mocked(toast.success).mockReset();
		vi.mocked(toast.error).mockReset();
	});

	it("turns automatic sync on with the stored repository, branch and paths", async () => {
		configureMock.mockResolvedValue({ syncId: "sync_1", generation: 2 });
		const user = userEvent.setup();
		const { onChanged } = renderStatus({
			state: baseState({ configured: CONFIGURED }),
		});

		await user.click(screen.getByTestId("context-sync-menu-trigger"));
		const toggle = await screen.findByTestId("context-sync-automatic");
		expect(toggle).toHaveAttribute("role", "menuitemcheckbox");
		expect(toggle).toHaveAttribute("aria-checked", "false");
		await user.click(toggle);

		await waitFor(() =>
			expect(configureMock).toHaveBeenCalledWith({
				projectId: "proj_1",
				organizationId: "org_1",
				repositoryIntegrationId: "int_1",
				ref: "main",
				paths: ["docs"],
				automatic: true,
			}),
		);
		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith(
				`${NS}.settings.automaticTurnedOn`,
			),
		);
		expect(onChanged).toHaveBeenCalled();
	});

	it("leaves out excludedPaths, so the stored exclusions stand (Fizzy #2750 §5.2)", async () => {
		configureMock.mockResolvedValue({ syncId: "sync_1", generation: 2 });
		const user = userEvent.setup();
		renderStatus({
			state: baseState({
				configured: { ...CONFIGURED, excludedPaths: ["docs/old"] },
			}),
		});

		await user.click(screen.getByTestId("context-sync-menu-trigger"));
		await user.click(await screen.findByTestId("context-sync-automatic"));

		await waitFor(() => expect(configureMock).toHaveBeenCalledTimes(1));
		// Omitted, not `undefined` spelled out and not the stored list: an
		// omitted field keeps what is stored, and `[]` would clear it.
		expect(configureMock.mock.calls[0]?.[0]).not.toHaveProperty(
			"excludedPaths",
		);
	});

	it("turns automatic sync off when it is on", async () => {
		configureMock.mockResolvedValue({ syncId: "sync_1", generation: 2 });
		const user = userEvent.setup();
		renderStatus({
			state: baseState({
				configured: { ...CONFIGURED, automatic: true },
			}),
		});

		await user.click(screen.getByTestId("context-sync-menu-trigger"));
		const toggle = await screen.findByTestId("context-sync-automatic");
		expect(toggle).toHaveAttribute("aria-checked", "true");
		await user.click(toggle);

		await waitFor(() =>
			expect(configureMock).toHaveBeenCalledWith(
				expect.objectContaining({ automatic: false }),
			),
		);
		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith(
				`${NS}.settings.automaticTurnedOff`,
			),
		);
	});

	it("toasts a refused toggle with the configure error copy", async () => {
		configureMock.mockRejectedValue({
			message: "server message",
			data: { code: "BRANCH_NOT_FOUND" },
		});
		const user = userEvent.setup();
		renderStatus({ state: baseState({ configured: CONFIGURED }) });

		await user.click(screen.getByTestId("context-sync-menu-trigger"));
		await user.click(await screen.findByTestId("context-sync-automatic"));

		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(
				`${NS}.configureDialog.errors.BRANCH_NOT_FOUND${JSON.stringify({
					path: "",
					withPath: "",
					managedCount: 0,
				})}`,
			),
		);
		expect(toast.success).not.toHaveBeenCalled();
	});

	it("shows a reader the state as text, with no toggle", () => {
		renderStatus({
			state: baseState({
				configured: { ...CONFIGURED, automatic: true },
				canConfigure: false,
			}),
		});
		expect(
			screen.getByTestId("context-sync-automatic-state"),
		).toHaveTextContent(
			`${NS}.settings.automaticState${JSON.stringify({
				state: `${NS}.settings.automaticOn`,
			})}`,
		);
		expect(
			screen.queryByTestId("context-sync-automatic"),
		).not.toBeInTheDocument();
	});
});

describe("ContextRepositorySyncStatus — paused automatic sync", () => {
	beforeEach(() => {
		syncNowMock.mockReset();
		disableMock.mockReset();
		configureMock.mockReset();
	});

	it("names the pause and reopens the configure dialog from Re-enable", async () => {
		const user = userEvent.setup();
		renderStatus({
			state: baseState({
				configured: {
					...CONFIGURED,
					automatic: true,
					automaticPausedReason: "REF_MISSING",
					automaticPausedAt: "2026-09-23T11:00:00.000Z",
				},
			}),
		});
		expect(screen.getByTestId("context-sync-paused")).toHaveTextContent(
			`${NS}.pausedLine${JSON.stringify({
				reason: `${NS}.pausedReasons.REF_MISSING`,
			})}`,
		);
		expect(
			screen.queryByText(`${NS}.configureDialog.title`),
		).not.toBeInTheDocument();

		await user.click(
			screen.getByRole("button", { name: `${NS}.reEnableButton` }),
		);

		expect(
			await screen.findByText(`${NS}.configureDialog.title`),
		).toBeInTheDocument();
	});

	it("names a revoked permission", () => {
		renderStatus({
			state: baseState({
				configured: {
					...CONFIGURED,
					automatic: true,
					automaticPausedReason: "PERMISSION_REVOKED",
				},
			}),
		});
		expect(screen.getByTestId("context-sync-paused")).toHaveTextContent(
			`${NS}.pausedReasons.PERMISSION_REVOKED`,
		);
	});

	it("keeps the pause line dormant while automatic sync is off", () => {
		renderStatus({
			state: baseState({
				configured: {
					...CONFIGURED,
					automatic: false,
					automaticPausedReason: "REF_MISSING",
				},
			}),
		});
		expect(
			screen.queryByTestId("context-sync-paused"),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: `${NS}.reEnableButton` }),
		).not.toBeInTheDocument();
	});

	it("shows a reader the pause without Re-enable", () => {
		renderStatus({
			state: baseState({
				canConfigure: false,
				configured: {
					...CONFIGURED,
					automatic: true,
					automaticPausedReason: "REF_MISSING",
				},
			}),
		});
		expect(screen.getByTestId("context-sync-paused")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: `${NS}.reEnableButton` }),
		).not.toBeInTheDocument();
	});
});

function finishedRun(
	overrides: Partial<NonNullable<ContextSyncState["latestFinishedRun"]>> = {},
): NonNullable<ContextSyncState["latestFinishedRun"]> {
	return {
		id: "sync_1:run_b",
		trigger: "POLL",
		startedAt: "2026-09-23T11:00:00.000Z",
		finishedAt: "2026-09-23T11:01:00.000Z",
		status: "FAILED",
		error: "CLONE_FAILED",
		limitDetail: null,
		commitSha: null,
		...overrides,
	};
}

describe("ContextRepositorySyncStatus — a failed run (Fizzy #2784)", () => {
	const failureLine = () => screen.getByTestId("context-sync-failure");
	/** The line the widget builds: the time, the trigger, and the detail's own words. */
	const lineWith = (detail: string, trigger = "POLL") =>
		`${NS}.failure.line${JSON.stringify({
			time: "3 minutes",
			trigger: `${NS}.triggers.${trigger}`,
			detail,
		})}`;

	it("says so beside the applied line when a run failed before it applied anything", () => {
		renderStatus({
			state: baseState({
				configured: CONFIGURED_BASE,
				lastAppliedRun: emptyRun(),
				latestFinishedRun: finishedRun(),
			}),
		});

		expect(
			screen.getByTestId("context-sync-status-line"),
		).toBeInTheDocument();
		expect(failureLine()).toHaveTextContent(
			lineWith(`${NS}.failure.CLONE_FAILED`),
		);
	});

	it.each([
		[
			"a file count over the limit, with what was measured",
			{ kind: "fileCount" as const, actual: 6_000, max: 5_000 },
			"failure.limit.fileCount",
			{ actual: "6,000", max: "5,000" },
		],
		[
			"a total size over the limit, with what was measured, in bytes words",
			{ kind: "totalSize" as const, actual: 60_000_000, max: 52_428_800 },
			"failure.limit.totalSize",
			{ actual: "57.2 MB", max: "50 MB" },
		],
		[
			"a total size with no measured value",
			{ kind: "totalSize" as const, max: 52_428_800 },
			"failure.limit.totalSizeUnknown",
			{ max: "50 MB" },
		],
		[
			"an inventory over its cap",
			{ kind: "inventory" as const, max: 200_000 },
			"failure.limit.inventory",
			{ max: "200,000" },
		],
		[
			"the repository's own size budget",
			{ kind: "repositorySize" as const, max: 164 * 1024 * 1024 },
			"failure.limit.repositorySize",
			{ max: "164 MB" },
		],
	])("names the exact limit for %s", (_name, limitDetail, key, values) => {
		renderStatus({
			state: baseState({
				configured: CONFIGURED_BASE,
				latestFinishedRun: finishedRun({
					error: "LIMITS_EXCEEDED",
					limitDetail,
				}),
			}),
		});

		expect(failureLine()).toHaveTextContent(
			lineWith(`${NS}.${key}${JSON.stringify(values)}`),
		);
	});

	it("names the line of a .contextignore rule the sync refused", () => {
		renderStatus({
			state: baseState({
				configured: CONFIGURED_BASE,
				latestFinishedRun: finishedRun({
					error: "IGNORE_RULE_REJECTED",
					limitDetail: {
						kind: "doubleStarGroups",
						max: 2,
						actual: 3,
						line: 4,
					},
				}),
			}),
		});

		expect(failureLine()).toHaveTextContent(
			lineWith(
				`${NS}.failure.limit.doubleStarGroups${JSON.stringify({
					line: 4,
					actual: 3,
					max: 2,
				})}`,
			),
		);
	});

	it("falls back to the generic limit line when the run recorded no detail", () => {
		renderStatus({
			state: baseState({
				configured: CONFIGURED_BASE,
				latestFinishedRun: finishedRun({ error: "LIMITS_EXCEEDED" }),
			}),
		});

		expect(failureLine()).toHaveTextContent(
			lineWith(`${NS}.failure.LIMITS_EXCEEDED`),
		);
	});

	it("names the branch for a REF_MISSING failure", () => {
		renderStatus({
			state: baseState({
				configured: CONFIGURED_BASE,
				latestFinishedRun: finishedRun({ error: "REF_MISSING" }),
			}),
		});

		expect(failureLine()).toHaveTextContent(
			lineWith(
				`${NS}.failure.REF_MISSING${JSON.stringify({ ref: "main" })}`,
			),
		);
	});

	it("shows nothing for a finished run that did not fail", () => {
		renderStatus({
			state: baseState({
				configured: CONFIGURED_BASE,
				latestFinishedRun: finishedRun({
					status: "SUCCEEDED",
					error: null,
				}),
			}),
		});

		expect(screen.queryByTestId("context-sync-failure")).toBeNull();
	});

	it("hides the failure while a newer run is open, so the running line stands alone", () => {
		renderStatus({
			state: baseState({
				configured: CONFIGURED_BASE,
				running: true,
				latestFinishedRun: finishedRun(),
			}),
		});

		expect(screen.getByTestId("context-sync-running")).toBeInTheDocument();
		expect(screen.queryByTestId("context-sync-failure")).toBeNull();
	});

	it("keeps the failure in the status region, which stays mounted, so its appearance is announced", () => {
		renderStatus({
			state: baseState({
				configured: CONFIGURED_BASE,
				latestFinishedRun: finishedRun(),
			}),
		});

		expect(screen.getByRole("status")).toContainElement(failureLine());
	});
});

describe("ContextRepositorySyncStatus — a failed read (Fizzy #2784)", () => {
	it("says the state could not be read, with Retry, instead of rendering nothing", async () => {
		const onRetry = vi.fn();
		const user = userEvent.setup();
		renderStatus({ state: undefined, readFailed: true, onRetry });

		expect(screen.getByRole("alert")).toHaveTextContent(
			`${NS}.loadError.message`,
		);
		expect(screen.queryByTestId("context-sync-from-repository")).toBeNull();
		await user.click(
			screen.getByRole("button", { name: `${NS}.loadError.retry` }),
		);
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("still renders nothing while the first read is simply in flight", () => {
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
});

describe("ContextRepositorySyncStatus — failed actions (Fizzy #2784)", () => {
	beforeEach(() => {
		syncNowMock.mockReset();
		disableMock.mockReset();
		vi.mocked(toast.error).mockReset();
	});

	it("tells a failed Sync now in the widget's own words, never the server's message", async () => {
		syncNowMock.mockRejectedValue(new Error("upstream said no"));
		const user = userEvent.setup();
		renderStatus({ state: baseState({ configured: CONFIGURED_BASE }) });

		await user.click(screen.getByTestId("context-sync-now"));

		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(
				`${NS}.actionErrors.syncNow`,
			),
		);
		expect(toast.error).not.toHaveBeenCalledWith("upstream said no");
	});

	it("tells a failed disconnect in the widget's own words, never the server's message", async () => {
		disableMock.mockRejectedValue(new Error("upstream said no"));
		const user = userEvent.setup();
		renderStatus({ state: baseState({ configured: CONFIGURED_BASE }) });

		await user.click(screen.getByTestId("context-sync-menu-trigger"));
		await user.click(await screen.findByTestId("context-sync-disconnect"));
		await user.click(screen.getByTestId("context-sync-disconnect-confirm"));

		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(
				`${NS}.actionErrors.disable`,
			),
		);
		expect(toast.error).not.toHaveBeenCalledWith("upstream said no");
	});

	it("maps a typed refusal to its own copy, as configure does", async () => {
		syncNowMock.mockRejectedValue({
			message: "server message",
			data: { code: "REPOSITORY_UNAVAILABLE" },
		});
		const user = userEvent.setup();
		renderStatus({ state: baseState({ configured: CONFIGURED_BASE }) });

		await user.click(screen.getByTestId("context-sync-now"));

		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(
				`${NS}.configureDialog.errors.REPOSITORY_UNAVAILABLE${JSON.stringify(
					{
						path: "",
						withPath: "",
						managedCount: 0,
					},
				)}`,
			),
		);
	});
});

describe("ContextRepositorySyncStatus — progress while a run is open", () => {
	const counts = {
		created: 0,
		updated: 0,
		adopted: 0,
		unchanged: 0,
		conflict: 0,
		pathInUse: 0,
		removed: 0,
		pruneConflicts: 0,
	};
	const plan = {
		keptCount: 10,
		excludedCount: 0,
		attentionCount: 0,
		attention: [],
		missingPaths: [],
		protectedPrefixes: [],
	};
	const openRun = (
		overrides: Partial<NonNullable<ContextSyncState["latestRun"]>> = {},
	): NonNullable<ContextSyncState["latestRun"]> => ({
		...emptyRun(),
		finishedAt: null,
		status: null,
		counts,
		...overrides,
	});
	const running = (
		overrides: Partial<ContextSyncState> = {},
	): ContextSyncState =>
		baseState({
			configured: CONFIGURED_BASE,
			running: true,
			latestRun: openRun(),
			...overrides,
		});

	it("names fetching, with no count and no bar, until the plan is written", () => {
		renderStatus({ state: running() });

		const line = screen.getByTestId("context-sync-progress");
		expect(line).toHaveTextContent(`${NS}.fetching`);
		expect(
			screen.queryByTestId("sync-progress-bar"),
		).not.toBeInTheDocument();
	});

	it("counts the files its committed batches decided, out of the files the plan keeps", () => {
		renderStatus({
			state: running({
				latestRun: openRun({
					plan,
					counts: {
						...counts,
						created: 5,
						unchanged: 2,
						conflict: 1,
					},
				}),
			}),
		});

		expect(screen.getByTestId("context-sync-progress")).toHaveTextContent(
			`${NS}.applying${JSON.stringify({ done: 8, total: 10 })}`,
		);
		expect(screen.getByTestId("sync-progress-bar")).toBeInTheDocument();
	});

	it("says 'so far' for the removals, whose total is not known", () => {
		renderStatus({
			state: running({
				latestRun: openRun({
					plan,
					counts: { ...counts, created: 10, removed: 3 },
				}),
			}),
		});

		expect(screen.getByTestId("context-sync-progress")).toHaveTextContent(
			`${NS}.pruning${JSON.stringify({ removed: 3 })}`,
		);
		expect(
			screen.queryByTestId("sync-progress-bar"),
		).not.toBeInTheDocument();
	});

	it("reports indexed out of managed while rows await indexing after the run", () => {
		renderStatus({
			state: baseState({
				configured: CONFIGURED_BASE,
				managedCount: 20,
				awaitingIndexCount: 5,
			}),
		});

		expect(
			screen.getByTestId("context-sync-awaiting-index"),
		).toHaveTextContent(
			`${NS}.indexing${JSON.stringify({ indexed: 15, managed: 20 })}`,
		);
	});

	it("keeps the plain running line when the run has reported nothing to count", () => {
		renderStatus({ state: running({ latestRun: null }) });

		expect(screen.getByTestId("context-sync-running")).toHaveTextContent(
			`${NS}.running`,
		);
	});
});
