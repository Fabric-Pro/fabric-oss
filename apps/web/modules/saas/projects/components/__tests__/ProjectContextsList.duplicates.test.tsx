/**
 * Duplicate content on the Context tab (Fizzy #2619).
 *
 * The contexts list marks each copy with `duplicateOfContextId`. This pins
 * what the tab does with it:
 *  - each copy carries a "Duplicate of <title>" marker naming the kept item
 *    (resolved with the same title function the row menus use), and the kept
 *    item carries none;
 *  - a banner counts the copies and offers "Remove duplicates", which asks
 *    for confirmation and then deletes every copy — never the kept item —
 *    through the same delete procedure the row menus call;
 *  - the outcome is reported with a toast and the list is re-read;
 *  - no banner when nothing is duplicated.
 */

import de from "@repo/i18n/translations/de.json";
import en from "@repo/i18n/translations/en.json";
import { FeatureFlagProvider } from "@saas/shared/components/FeatureFlagProvider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ── jsdom polyfills ──────────────────────────────────────────────────────
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

// ── Module mocks ─────────────────────────────────────────────────────────

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

// Keys render with their interpolation values so assertions can see which
// title and count reached the copy.
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

import { ProjectContextsList } from "../ProjectContextsList";

// ── Helpers ──────────────────────────────────────────────────────────────

const NS = "projects.contexts.duplicates";

function wrap(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<FeatureFlagProvider value={{}}>{ui}</FeatureFlagProvider>
		</QueryClientProvider>,
	);
	return client;
}

function fileContext(
	id: string,
	originalFilename: string,
	duplicateOfContextId: string | null,
) {
	return {
		id,
		type: "FILE",
		content: "Quarterly scope, identical in every copy",
		contentHash: "hash-scope",
		sourcePath: null,
		originalFilename,
		sourceUrl: null,
		sourceTitle: null,
		s3Path: `uploads/${id}.pdf`,
		extractionStatus: "COMPLETED",
		extractionError: null,
		embeddedAt: null,
		createdAt: new Date("2026-06-01T10:00:00Z"),
		// What a real upload stores (create-context-upload-url).
		metadata: { title: originalFilename },
		duplicateOfContextId,
	};
}

const tripled = {
	contexts: [
		fileContext("ctx_copy_2", "Scope (2).pdf", "ctx_original"),
		fileContext("ctx_copy_1", "Scope (1).pdf", "ctx_original"),
		fileContext("ctx_original", "Scope.pdf", null),
	],
	total: 3,
	hasMore: false,
};

// ── Tests ────────────────────────────────────────────────────────────────

describe("ProjectContextsList — duplicate content (Fizzy #2619)", () => {
	beforeEach(() => {
		contextsListMock.mockReset();
		deleteCallMock.mockReset();
		toastSuccessMock.mockReset();
		toastErrorMock.mockReset();
	});

	it("marks each copy with the kept item's title and leaves the kept item unmarked", async () => {
		contextsListMock.mockResolvedValue(tripled);

		wrap(<ProjectContextsList projectId="proj_1" />);

		const copy1 = await screen.findByTestId(
			"context-duplicate-badge-ctx_copy_1",
		);
		const copy2 = screen.getByTestId("context-duplicate-badge-ctx_copy_2");
		const expected = `${NS}.badge${JSON.stringify({ title: "Scope.pdf" })}`;
		expect(copy1).toHaveTextContent(expected);
		expect(copy2).toHaveTextContent(expected);
		expect(
			screen.queryByTestId("context-duplicate-badge-ctx_original"),
		).not.toBeInTheDocument();
	});

	it("marks a link card that copies a pasted note", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [
				{
					id: "ctx_link",
					type: "LINK",
					content: "Release notes body",
					contentHash: "hash-notes",
					sourcePath: null,
					sourceUrl: "https://example.com/release-notes",
					sourceTitle: "Release notes page",
					extractionStatus: "COMPLETED",
					extractionError: null,
					urlScope: "SINGLE_PAGE",
					urlMaxPages: null,
					urlRefreshMode: "MANUAL",
					urlLastSyncedAt: null,
					embeddedAt: null,
					createdAt: new Date("2026-06-02T10:00:00Z"),
					metadata: {},
					duplicateOfContextId: "ctx_note",
				},
				{
					id: "ctx_note",
					type: "TEXT",
					content: "Release notes body",
					contentHash: "hash-notes",
					sourcePath: null,
					sourceTitle: null,
					extractionStatus: "COMPLETED",
					extractionError: null,
					embeddedAt: null,
					createdAt: new Date("2026-06-01T10:00:00Z"),
					metadata: { title: "Release notes" },
					duplicateOfContextId: null,
				},
			],
			total: 2,
			hasMore: false,
		});

		wrap(<ProjectContextsList projectId="proj_1" />);

		const badge = await screen.findByTestId(
			"context-duplicate-badge-ctx_link",
		);
		expect(badge).toHaveTextContent(
			`${NS}.badge${JSON.stringify({ title: "Release notes" })}`,
		);
		expect(screen.getByTestId("link-card-ctx_link")).toContainElement(
			badge,
		);
	});

	it("shows a banner counting the copies", async () => {
		contextsListMock.mockResolvedValue(tripled);

		wrap(<ProjectContextsList projectId="proj_1" />);

		const banner = await screen.findByTestId("context-duplicates-banner");
		expect(banner).toHaveTextContent(
			`${NS}.bannerMessage${JSON.stringify({ count: 2 })}`,
		);
		expect(
			screen.getByTestId("context-duplicates-remove"),
		).toHaveTextContent(`${NS}.removeAction`);
	});

	it("names both titles for each copy in the confirm dialog, and never lists the kept item", async () => {
		contextsListMock.mockResolvedValue(tripled);
		const user = userEvent.setup();

		wrap(<ProjectContextsList projectId="proj_1" />);

		await user.click(
			await screen.findByTestId("context-duplicates-remove"),
		);

		const list = await screen.findByTestId("context-duplicates-list");
		const item1 = screen.getByTestId(
			"context-duplicates-list-item-ctx_copy_1",
		);
		const item2 = screen.getByTestId(
			"context-duplicates-list-item-ctx_copy_2",
		);
		expect(list).toContainElement(item1);
		expect(list).toContainElement(item2);
		expect(item1).toHaveTextContent(
			`${NS}.confirmItem${JSON.stringify({
				copyTitle: "Scope (1).pdf",
				keptTitle: "Scope.pdf",
			})}`,
		);
		expect(item2).toHaveTextContent(
			`${NS}.confirmItem${JSON.stringify({
				copyTitle: "Scope (2).pdf",
				keptTitle: "Scope.pdf",
			})}`,
		);
		expect(
			screen.queryByTestId("context-duplicates-list-item-ctx_original"),
		).not.toBeInTheDocument();
	});

	it("keeps the banner's item list collapsed by default and expands it via the toggle", async () => {
		contextsListMock.mockResolvedValue(tripled);
		const user = userEvent.setup();

		wrap(<ProjectContextsList projectId="proj_1" />);

		const toggle = await screen.findByTestId("context-duplicates-toggle");
		expect(toggle).toHaveAttribute("aria-expanded", "false");
		expect(
			screen.queryByTestId("context-duplicates-list"),
		).not.toBeInTheDocument();

		await user.click(toggle);

		expect(toggle).toHaveAttribute("aria-expanded", "true");
		const list = await screen.findByTestId("context-duplicates-list");
		// The disclosure names the list it reveals.
		expect(list.id).not.toBe("");
		expect(toggle).toHaveAttribute("aria-controls", list.id);
		expect(
			within(list).getByTestId("context-duplicates-list-item-ctx_copy_1"),
		).toHaveTextContent(
			`${NS}.confirmItem${JSON.stringify({
				copyTitle: "Scope (1).pdf",
				keptTitle: "Scope.pdf",
			})}`,
		);
		expect(
			within(list).getByTestId("context-duplicates-list-item-ctx_copy_2"),
		).toBeInTheDocument();

		// Collapses again on a second click.
		await user.click(toggle);
		expect(toggle).toHaveAttribute("aria-expanded", "false");
		expect(
			screen.queryByTestId("context-duplicates-list"),
		).not.toBeInTheDocument();
	});

	it("collapses the banner's item list again when the duplicates go away and come back", async () => {
		const undoubled = {
			contexts: [fileContext("ctx_original", "Scope.pdf", null)],
			total: 1,
			hasMore: false,
		};
		contextsListMock.mockResolvedValue(tripled);
		const user = userEvent.setup();

		const client = wrap(<ProjectContextsList projectId="proj_1" />);

		await user.click(
			await screen.findByTestId("context-duplicates-toggle"),
		);
		expect(
			await screen.findByTestId("context-duplicates-list"),
		).toBeInTheDocument();

		// The copies disappear on the next read (e.g. someone else removed
		// them), then a later read brings a new set back.
		contextsListMock.mockResolvedValue(undoubled);
		await act(() => client.invalidateQueries());
		await waitFor(() =>
			expect(
				screen.queryByTestId("context-duplicates-banner"),
			).not.toBeInTheDocument(),
		);

		contextsListMock.mockResolvedValue(tripled);
		await act(() => client.invalidateQueries());
		const toggle = await screen.findByTestId("context-duplicates-toggle");
		expect(toggle).toHaveAttribute("aria-expanded", "false");
		expect(
			screen.queryByTestId("context-duplicates-list"),
		).not.toBeInTheDocument();
	});

	it("shows no banner and no markers when nothing is duplicated", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [
				fileContext("ctx_a", "A.pdf", null),
				fileContext("ctx_b", "B.pdf", null),
			],
			total: 2,
			hasMore: false,
		});

		wrap(<ProjectContextsList projectId="proj_1" />);

		// Wait for the list itself before asserting absence.
		expect(await screen.findByText("A.pdf")).toBeInTheDocument();
		expect(
			screen.queryByTestId("context-duplicates-banner"),
		).not.toBeInTheDocument();
		expect(
			screen.queryByTestId(/^context-duplicate-badge-/),
		).not.toBeInTheDocument();
	});

	it("asks first, then deletes every copy and never the kept item", async () => {
		contextsListMock.mockResolvedValue(tripled);
		deleteCallMock.mockResolvedValue({ success: true });
		const user = userEvent.setup();

		wrap(<ProjectContextsList projectId="proj_1" />);

		await user.click(
			await screen.findByTestId("context-duplicates-remove"),
		);

		// Nothing is deleted until the confirmation is accepted.
		expect(deleteCallMock).not.toHaveBeenCalled();
		expect(
			await screen.findByText(
				`${NS}.confirmTitle${JSON.stringify({ count: 2 })}`,
			),
		).toBeInTheDocument();

		const listReadsBefore = contextsListMock.mock.calls.length;
		await user.click(screen.getByTestId("context-duplicates-confirm"));

		await waitFor(() => expect(deleteCallMock).toHaveBeenCalledTimes(2));
		const deletedIds = deleteCallMock.mock.calls.map(
			([args]) => (args as { id: string }).id,
		);
		expect(deletedIds.sort()).toEqual(["ctx_copy_1", "ctx_copy_2"]);
		expect(deletedIds).not.toContain("ctx_original");
		// Each delete names the item the copy was matched against, so the
		// server can refuse it if the list it came from has gone stale.
		expect(deleteCallMock).toHaveBeenCalledWith({
			id: "ctx_copy_1",
			projectId: "proj_1",
			organizationId: "org_1",
			expectedDuplicateOfContextId: "ctx_original",
		});
		expect(deleteCallMock).toHaveBeenCalledWith({
			id: "ctx_copy_2",
			projectId: "proj_1",
			organizationId: "org_1",
			expectedDuplicateOfContextId: "ctx_original",
		});

		await waitFor(() =>
			expect(toastSuccessMock).toHaveBeenCalledWith(
				`${NS}.removed${JSON.stringify({ count: 2 })}`,
			),
		);
		// The list is re-read once the deletes settle.
		await waitFor(() =>
			expect(contextsListMock.mock.calls.length).toBeGreaterThan(
				listReadsBefore,
			),
		);
	});

	it("does nothing when the confirmation is cancelled", async () => {
		contextsListMock.mockResolvedValue(tripled);
		const user = userEvent.setup();

		wrap(<ProjectContextsList projectId="proj_1" />);

		await user.click(
			await screen.findByTestId("context-duplicates-remove"),
		);
		await user.click(await screen.findByText(`${NS}.cancel`));

		expect(deleteCallMock).not.toHaveBeenCalled();
		expect(toastSuccessMock).not.toHaveBeenCalled();
	});

	it("reports a partial failure with the removed and failed counts", async () => {
		contextsListMock.mockResolvedValue(tripled);
		deleteCallMock
			.mockResolvedValueOnce({ success: true })
			.mockRejectedValueOnce(new Error("forbidden"));
		const user = userEvent.setup();

		wrap(<ProjectContextsList projectId="proj_1" />);

		await user.click(
			await screen.findByTestId("context-duplicates-remove"),
		);
		await user.click(
			await screen.findByTestId("context-duplicates-confirm"),
		);

		await waitFor(() =>
			expect(toastErrorMock).toHaveBeenCalledWith(
				`${NS}.removedPartial${JSON.stringify({
					removed: 1,
					failed: 1,
					total: 2,
				})}`,
			),
		);
		expect(toastSuccessMock).not.toHaveBeenCalled();
	});

	// The delete only STARTS a durable cleanup workflow, so the toast must not
	// claim the copies are already gone.
	it("words the result as started, not finished, in both locales", () => {
		const copy = [
			en.projects.contexts.duplicates,
			de.projects.contexts.duplicates,
		];
		for (const duplicates of copy) {
			expect(Object.keys(duplicates).sort()).toEqual(
				Object.keys(en.projects.contexts.duplicates).sort(),
			);
		}
		expect(en.projects.contexts.duplicates.removed).toContain("Removing #");
		expect(en.projects.contexts.duplicates.removed).toContain(
			"once cleanup finishes",
		);
		expect(en.projects.contexts.duplicates.removedPartial).toContain(
			"Removal started",
		);
		expect(de.projects.contexts.duplicates.removed).toContain(
			"wird entfernt",
		);
		expect(de.projects.contexts.duplicates.removedPartial).toContain(
			"gestartet",
		);
	});
});
