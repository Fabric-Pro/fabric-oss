/**
 * Ownership of a repository-managed Living Memory row on the Context tab
 * (design 2026-09-23 §6, §7.3, Fizzy #2657):
 *  - a managed row (`repositorySyncId != null`) carries a "Repository" badge
 *    and no Delete action;
 *  - "Remove duplicates" excludes managed rows from its candidates and
 *    reports "N deleted, M skipped" from the final answers, treating a
 *    CONFLICT answer as skipped rather than a toast-storm failure.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

const { contextsListMock, deleteCallMock, toastSuccessMock, toastErrorMock } =
	vi.hoisted(() => ({
		contextsListMock: vi.fn(),
		deleteCallMock: vi.fn(),
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
							queryFn: async () => null,
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
