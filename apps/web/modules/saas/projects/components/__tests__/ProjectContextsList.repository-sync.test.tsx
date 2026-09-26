/**
 * Ownership of a repository-managed Living Memory row on the Context tab
 * (design 2026-09-23 §6, §7.3, Fizzy #2657):
 *  - a managed row (`repositorySyncId != null`) carries a "Repository" badge
 *    and no Delete action;
 *  - "Remove duplicates" excludes managed rows from its candidates and
 *    reports "N deleted, M skipped" from the final answers, treating a
 *    CONFLICT answer as skipped rather than a toast-storm failure;
 *  - the Context card's sync state is re-read every 60 s while automatic
 *    sync is on and not paused, and a newest run that changed or finished
 *    between two reads re-reads the files (Fizzy #2713).
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

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

const {
	contextsListMock,
	deleteCallMock,
	repositorySyncGetMock,
	toastSuccessMock,
	toastErrorMock,
} = vi.hoisted(() => ({
	contextsListMock: vi.fn(),
	deleteCallMock: vi.fn(),
	/** `repositorySync.get`; nothing configured unless a test says so. */
	repositorySyncGetMock: vi.fn(async (): Promise<unknown> => null),
	toastSuccessMock: vi.fn(),
	toastErrorMock: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { projects: { contexts: {} } },
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			contexts: {
				list: {
					queryOptions: ({
						input,
						refetchInterval,
					}: {
						input: unknown;
						refetchInterval?: unknown;
					}) => ({
						queryKey: ["projects.contexts.list", input] as const,
						queryFn: () => contextsListMock(input),
						refetchInterval,
					}),
					queryKey: ({ input }: { input: unknown }) => [
						"projects.contexts.list",
						input,
					],
				},
				delete: { call: deleteCallMock },
				createDownloadUrl: { call: vi.fn() },
				repositorySync: {
					get: {
						queryOptions: () => ({
							queryKey: [
								"projects.contexts.repositorySync.get",
							] as const,
							queryFn: () => repositorySyncGetMock(),
						}),
					},
					configure: { mutationOptions: () => ({}) },
					syncNow: { mutationOptions: () => ({}) },
					disable: { mutationOptions: () => ({}) },
				},
			},
		},
		integrations: {
			teams: {
				contextAccess: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: [
							"integrations.teams.contextAccess",
							input,
						] as const,
						queryFn: async () => ({
							connected: true,
							contexts: [],
						}),
					}),
				},
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: toastSuccessMock, error: toastErrorMock },
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org_1",
		organizationSlug: "example-org",
		basePath: "/app/example-org",
	}),
}));

vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent: vi.fn() }),
}));

vi.mock("next-intl", () => {
	function makeT(namespace: string) {
		const t = (key: string, values?: Record<string, unknown>) =>
			values
				? `${namespace}.${key}${JSON.stringify(values)}`
				: `${namespace}.${key}`;
		(t as unknown as { raw: (k: string) => unknown }).raw = (
			k: string,
		) => ({
			label: `${k}.label`,
			warning: `${k}.warning`,
		});
		return t;
	}
	return {
		useTranslations: (namespace: string) => makeT(namespace),
		useLocale: () => "en",
		useFormatter: () => ({
			dateTime: (d: Date) => d.toISOString(),
			number: (n: number) => String(n),
			relativeTime: (d: Date) => d.toISOString(),
		}),
		useMessages: () => ({}),
		NextIntlClientProvider: ({ children }: { children: React.ReactNode }) =>
			children,
	};
});

vi.mock("next/link", () => ({
	default: ({
		children,
		href,
		...rest
	}: {
		children: React.ReactNode;
		href: string;
	} & Record<string, unknown>) => (
		<a href={href} {...rest}>
			{children}
		</a>
	),
}));

vi.mock("../ContextUploaderDialog", () => ({
	ContextUploaderDialog: () => null,
}));
vi.mock("../DownloadAllContextsButton", () => ({
	DownloadAllContextsButton: () => null,
}));
vi.mock("../ProjectSectionHero", () => ({
	ProjectSectionHero: () => null,
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	CONTEXT_SYNC_IDLE_POLL_MS,
	type ContextSyncState,
} from "../../lib/context-repository-sync";
import { ProjectContextsList } from "../ProjectContextsList";

function wrap(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

function syncedContext(
	id: string,
	sourcePath: string,
	overrides: Record<string, unknown> = {},
) {
	return {
		id,
		type: "TEXT",
		content: `Body of ${sourcePath}`,
		contentHash: `hash-${id}`,
		sourcePath,
		repositorySyncId: null,
		originalFilename: null,
		sourceUrl: null,
		sourceTitle: null,
		s3Path: null,
		extractionStatus: "COMPLETED",
		extractionError: null,
		embeddedAt: null,
		createdAt: new Date("2026-06-01T10:00:00Z"),
		metadata: { title: `Title of ${id}`, sourcePath },
		duplicateOfContextId: null,
		...overrides,
	};
}

function listOf(contexts: unknown[]) {
	return { contexts, total: contexts.length, hasMore: false };
}

describe("ProjectContextsList — repository-managed rows (Fizzy #2657)", () => {
	beforeEach(() => {
		contextsListMock.mockReset();
		deleteCallMock.mockReset();
		toastSuccessMock.mockReset();
		toastErrorMock.mockReset();
	});

	it("shows a Repository badge and no Delete action on a managed row", async () => {
		contextsListMock.mockResolvedValue(
			listOf([
				syncedContext("ctx_managed", "docs/api.md", {
					repositorySyncId: "sync_1",
				}),
			]),
		);
		const user = userEvent.setup();

		wrap(<ProjectContextsList projectId="proj_1" />);

		const badge = await screen.findByTestId(
			"context-repository-badge-ctx_managed",
		);
		expect(badge).toHaveTextContent(
			"projects.contexts.livingMemory.repositorySync.repositoryBadge",
		);

		const docs = screen.getByTestId("context-folder-docs");
		await user.click(within(docs).getByLabelText("More options"));
		expect(screen.queryByText("Delete")).not.toBeInTheDocument();
	});

	it("still shows Delete and no badge on an unmanaged synced row", async () => {
		contextsListMock.mockResolvedValue(
			listOf([syncedContext("ctx_plain", "docs/api.md")]),
		);
		const user = userEvent.setup();

		wrap(<ProjectContextsList projectId="proj_1" />);

		expect(
			screen.queryByTestId("context-repository-badge-ctx_plain"),
		).not.toBeInTheDocument();
		const docs = await screen.findByTestId("context-folder-docs");
		await user.click(within(docs).getByLabelText("More options"));
		expect(await screen.findByText("Delete")).toBeInTheDocument();
	});
});

describe("ProjectContextsList — Remove duplicates excludes managed rows (Fizzy #2657)", () => {
	beforeEach(() => {
		contextsListMock.mockReset();
		deleteCallMock.mockReset();
		toastSuccessMock.mockReset();
		toastErrorMock.mockReset();
	});

	it("never offers a managed row as a duplicate candidate", async () => {
		contextsListMock.mockResolvedValue(
			listOf([
				// The managed row is marked as a copy of the plain one by a
				// stale/racy annotation; the tab must still never offer it.
				syncedContext("ctx_managed_copy", "docs/copy.md", {
					contentHash: "hash-shared",
					repositorySyncId: "sync_1",
					duplicateOfContextId: "ctx_original",
				}),
				syncedContext("ctx_original", "docs/original.md", {
					contentHash: "hash-shared",
				}),
			]),
		);

		wrap(<ProjectContextsList projectId="proj_1" />);

		await screen.findByTestId("context-folder-docs");
		expect(
			screen.queryByTestId("context-duplicates-banner"),
		).not.toBeInTheDocument();
	});

	it("reports N deleted, M skipped, counting a CONFLICT answer as skipped", async () => {
		contextsListMock.mockResolvedValue(
			listOf([
				syncedContext("ctx_copy_ok", "docs/copy1.md", {
					contentHash: "hash-shared",
					duplicateOfContextId: "ctx_original",
				}),
				syncedContext("ctx_copy_conflict", "docs/copy2.md", {
					contentHash: "hash-shared",
					duplicateOfContextId: "ctx_original",
				}),
				syncedContext("ctx_original", "docs/original.md", {
					contentHash: "hash-shared",
				}),
			]),
		);
		deleteCallMock.mockImplementation(
			(input: { id: string; expectedContentHash?: string }) => {
				if (input.id === "ctx_copy_ok") {
					return Promise.resolve({
						success: true,
						status: "deleted",
					});
				}
				// The tab's stale-content refusal, and a synced-row hash
				// conflict, both throw a CONFLICT-coded ORPCError.
				return Promise.reject({
					code: "CONFLICT",
					message: "conflict",
				});
			},
		);
		const user = userEvent.setup();

		wrap(<ProjectContextsList projectId="proj_1" />);

		const banner = await screen.findByTestId("context-duplicates-banner");
		expect(banner).toBeInTheDocument();
		await user.click(screen.getByTestId("context-duplicates-remove"));
		await user.click(screen.getByTestId("context-duplicates-confirm"));

		await waitFor(() => expect(deleteCallMock).toHaveBeenCalledTimes(2));
		expect(deleteCallMock).toHaveBeenCalledWith({
			id: "ctx_copy_ok",
			projectId: "proj_1",
			organizationId: "org_1",
			expectedDuplicateOfContextId: "ctx_original",
			// The row's displayed contentHash, not a recomputed value.
			expectedContentHash: "hash-shared",
		});

		await waitFor(() =>
			expect(toastSuccessMock).toHaveBeenCalledWith(
				expect.stringContaining(
					"projects.contexts.duplicates.removedWithSkipped",
				),
			),
		);
		const [message] = toastSuccessMock.mock.calls.at(-1) as [string];
		expect(message).toContain('"deleted":1');
		expect(message).toContain('"skipped":1');
		expect(message).toContain('"failed":0');
		// Never surfaced as a generic error toast-storm.
		expect(toastErrorMock).not.toHaveBeenCalled();
	});
});

describe("ProjectContextsList — the Context card's idle poll (Fizzy #2713)", () => {
	function syncRun(
		id: string,
	): NonNullable<ContextSyncState["lastAppliedRun"]> {
		return {
			id,
			trigger: "POLL",
			startedAt: "2026-09-23T10:00:00.000Z",
			finishedAt: "2026-09-23T10:01:00.000Z",
			status: "SUCCEEDED",
			error: null,
			commitSha: "abc1234def5678901234567890123456789abcd",
			userName: "Example Member",
			counts: {
				created: 1,
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

	/** A configured sync, idle, with `latestRun` as the newest receipt. */
	function syncState(
		latestRunId: string,
		configured: Partial<NonNullable<ContextSyncState["configured"]>> = {},
	): ContextSyncState {
		const run = syncRun(latestRunId);
		return {
			canConfigure: true,
			running: false,
			configured: {
				syncId: "sync_1",
				repositoryIntegrationId: "int_1",
				ref: "main",
				paths: ["docs"],
				automatic: true,
				automaticPausedReason: null,
				automaticPausedAt: null,
				nextCheckAt: "2026-09-23T09:00:00.000Z",
				failureCount: 0,
				lastAppliedCommitSha: run.commitSha,
				configuredByName: "Example Member",
				createdAt: "2026-09-23T09:00:00.000Z",
				updatedAt: "2026-09-23T09:00:00.000Z",
				integration: {
					provider: "GITHUB",
					repositoryOwner: "example-org",
					repositoryName: "memory",
					status: "ACTIVE",
				},
				...configured,
			},
			latestRun: run,
			lastAppliedRun: run,
			managedCount: 1,
			awaitingIndexCount: 0,
			cleanupPending: 0,
			availableIntegrations: [],
		};
	}

	beforeEach(() => {
		contextsListMock.mockReset();
		contextsListMock.mockResolvedValue(
			listOf([
				syncedContext("ctx_managed", "docs/api.md", {
					repositorySyncId: "sync_1",
				}),
			]),
		);
		repositorySyncGetMock.mockReset();
		// Only the poll's own timer is faked: React Query schedules
		// `refetchInterval` with `setInterval`. `vi.waitFor` waits on the
		// real timers, but advances the fake ones by its own interval on
		// every check, so the tests below never assert an exact tick.
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	});

	afterEach(() => {
		vi.useRealTimers();
		repositorySyncGetMock.mockReset();
		repositorySyncGetMock.mockImplementation(async () => null);
	});

	it("re-reads the sync state every 60 s while automatic sync is on, and re-reads the files when a run finished unseen", async () => {
		repositorySyncGetMock.mockResolvedValue(syncState("sync_1:run_a"));

		wrap(<ProjectContextsList projectId="proj_1" />);

		await screen.findByTestId("context-repository-sync-status");
		await vi.waitFor(() =>
			expect(contextsListMock).toHaveBeenCalledTimes(1),
		);
		expect(repositorySyncGetMock).toHaveBeenCalledTimes(1);

		// A scheduled check started a run that finished between two reads.
		repositorySyncGetMock.mockResolvedValue(syncState("sync_1:run_b"));
		// Not the 3 s or 15 s poll: idle, nothing awaiting indexing.
		await vi.advanceTimersByTimeAsync(CONTEXT_SYNC_IDLE_POLL_MS / 2);
		expect(repositorySyncGetMock).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(CONTEXT_SYNC_IDLE_POLL_MS / 2);

		await vi.waitFor(() =>
			expect(repositorySyncGetMock).toHaveBeenCalledTimes(2),
		);
		// What it applied is readable now: the files are re-read too.
		await vi.waitFor(() =>
			expect(contextsListMock).toHaveBeenCalledTimes(2),
		);
	});

	it("re-reads the files when the newest run finishes between two reads, even with the tab never seeing it running", async () => {
		// `running` reads false whenever Temporal could not be asked, so the
		// newest receipt can be open while the tab sees nothing running.
		const open = syncState("sync_1:run_a");
		open.latestRun = {
			...(open.latestRun as NonNullable<ContextSyncState["latestRun"]>),
			id: "sync_1:run_b",
			finishedAt: null,
			status: null,
		};
		repositorySyncGetMock.mockResolvedValue(open);

		wrap(<ProjectContextsList projectId="proj_1" />);

		await screen.findByTestId("context-repository-sync-status");
		await vi.waitFor(() =>
			expect(contextsListMock).toHaveBeenCalledTimes(1),
		);

		// The same receipt, now finished; still nothing seen running.
		const finished = syncState("sync_1:run_a");
		finished.latestRun = {
			...(finished.latestRun as NonNullable<
				ContextSyncState["latestRun"]
			>),
			id: "sync_1:run_b",
		};
		repositorySyncGetMock.mockResolvedValue(finished);
		await vi.advanceTimersByTimeAsync(CONTEXT_SYNC_IDLE_POLL_MS);

		await vi.waitFor(() =>
			expect(repositorySyncGetMock).toHaveBeenCalledTimes(2),
		);
		await vi.waitFor(() =>
			expect(contextsListMock).toHaveBeenCalledTimes(2),
		);
	});

	it.each([
		["off", { automatic: false }],
		["paused", { automaticPausedReason: "REF_MISSING" as const }],
	])(
		"does not re-read an idle sync whose automatic sync is %s",
		async (_label, configured) => {
			repositorySyncGetMock.mockResolvedValue(
				syncState("sync_1:run_a", configured),
			);

			wrap(<ProjectContextsList projectId="proj_1" />);

			await screen.findByTestId("context-repository-sync-status");
			await vi.advanceTimersByTimeAsync(CONTEXT_SYNC_IDLE_POLL_MS * 2);
			expect(repositorySyncGetMock).toHaveBeenCalledTimes(1);
		},
	);
});
