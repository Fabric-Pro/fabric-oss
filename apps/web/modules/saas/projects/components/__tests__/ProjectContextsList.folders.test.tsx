/**
 * Living Memory on the Context tab (Fizzy #2620).
 *
 * A file a connected agent pushed from a working tree carries its relative
 * path as `sourcePath` (Fizzy #2616). This pins how the tab shows those rows:
 *  - under one "Living Memory" section, one collapsible section per folder
 *    (flat by directory, not a tree), folders in path order with the project
 *    root first, files in name order;
 *  - each row labelled with its file name, the full path underneath;
 *  - rows without a `sourcePath` stay in the flat list, untouched;
 *  - a folder collapses and expands from its header;
 *  - a synced row keeps the card's menu and the duplicate marker;
 *  - no section at all when nothing is synced.
 */

import { FeatureFlagProvider } from "@saas/shared/components/FeatureFlagProvider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
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

const { contextsListMock, deleteCallMock } = vi.hoisted(() => ({
	contextsListMock: vi.fn(),
	deleteCallMock: vi.fn(),
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
	toast: { success: vi.fn(), error: vi.fn() },
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
// copy and count reached the page.
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

const NS = "projects.contexts.livingMemory";

function wrap(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<FeatureFlagProvider value={{}}>{ui}</FeatureFlagProvider>
		</QueryClientProvider>,
	);
}

/**
 * What `upsertContextBySourcePath` stores: a TEXT row keyed by its path. The
 * title deliberately differs from the file name, so a test can tell which
 * one the card shows.
 */
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

function uploadedContext(
	id: string,
	originalFilename: string,
	overrides: Record<string, unknown> = {},
) {
	return {
		id,
		type: "FILE",
		content: "Uploaded by hand",
		contentHash: `hash-${id}`,
		sourcePath: null,
		originalFilename,
		sourceUrl: null,
		sourceTitle: null,
		s3Path: `uploads/${id}.pdf`,
		extractionStatus: "COMPLETED",
		extractionError: null,
		embeddedAt: null,
		createdAt: new Date("2026-06-02T10:00:00Z"),
		metadata: { title: originalFilename },
		duplicateOfContextId: null,
		...overrides,
	};
}

function listOf(contexts: unknown[]) {
	return { contexts, total: contexts.length, hasMore: false };
}

// Deliberately out of order: the list arrives newest first, not by path.
const mixed = listOf([
	syncedContext("ctx_q10", "notes/2026/q10.md"),
	syncedContext("ctx_setup", "docs/guides/setup.md"),
	uploadedContext("ctx_scope", "Scope.pdf"),
	syncedContext("ctx_arch", "docs/architecture.md"),
	syncedContext("ctx_readme", "README.md"),
	syncedContext("ctx_q2", "notes/2026/q2.md"),
	syncedContext("ctx_api", "docs/api.md"),
]);

async function findLivingMemory() {
	return screen.findByTestId("context-living-memory");
}

function folderSections(section: HTMLElement) {
	return within(section).getAllByTestId(/^context-folder-/);
}

/** The folder's disclosure button, inside its level-4 heading. */
function folderHeader(folder: HTMLElement) {
	return within(within(folder).getByRole("heading", { level: 4 })).getByRole(
		"button",
	);
}

function cardTitles(folder: HTMLElement) {
	return within(folder)
		.getAllByRole("heading", { level: 3 })
		.map((heading) => heading.textContent);
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("ProjectContextsList — Living Memory folders (Fizzy #2620)", () => {
	beforeEach(() => {
		contextsListMock.mockReset();
		deleteCallMock.mockReset();
	});

	it("groups synced files by folder, root first, then by folder path", async () => {
		contextsListMock.mockResolvedValue(mixed);

		wrap(<ProjectContextsList projectId="proj_1" />);

		const section = await findLivingMemory();
		expect(section).toHaveTextContent(`${NS}.title`);
		expect(section).toHaveTextContent(`${NS}.description`);

		const folders = folderSections(section);
		expect(
			folders.map((folder) => folder.getAttribute("data-folder-path")),
		).toEqual(["", "docs", "docs/guides", "notes/2026"]);
		expect(folders.map((folder) => folder.dataset.testid)).toEqual([
			"context-folder-root",
			"context-folder-docs",
			"context-folder-docs-guides",
			"context-folder-notes-2026",
		]);

		// Each header names its folder (the root by its label) and counts it.
		const [root, docs, guides, notes] = folders as [
			HTMLElement,
			HTMLElement,
			HTMLElement,
			HTMLElement,
		];
		expect(folderHeader(root)).toHaveTextContent(`${NS}.rootFolder`);
		expect(folderHeader(root)).toHaveTextContent(
			`${NS}.fileCount${JSON.stringify({ count: 1 })}`,
		);
		expect(folderHeader(docs)).toHaveTextContent("docs");
		expect(folderHeader(docs)).toHaveTextContent(
			`${NS}.fileCount${JSON.stringify({ count: 2 })}`,
		);
		expect(folderHeader(guides)).toHaveTextContent("docs/guides");
		expect(folderHeader(notes)).toHaveTextContent(
			`${NS}.fileCount${JSON.stringify({ count: 2 })}`,
		);
	});

	it("labels each file by its name, in name order, with the full path underneath", async () => {
		contextsListMock.mockResolvedValue(mixed);

		wrap(<ProjectContextsList projectId="proj_1" />);

		const folders = folderSections(await findLivingMemory());
		const [root, docs, guides, notes] = folders as [
			HTMLElement,
			HTMLElement,
			HTMLElement,
			HTMLElement,
		];
		expect(cardTitles(root)).toEqual(["README.md"]);
		expect(cardTitles(docs)).toEqual(["api.md", "architecture.md"]);
		expect(cardTitles(guides)).toEqual(["setup.md"]);
		// Natural order: q2 before q10.
		expect(cardTitles(notes)).toEqual(["q2.md", "q10.md"]);

		const path = screen.getByTestId("context-source-path-ctx_setup");
		expect(path).toHaveTextContent("docs/guides/setup.md");
		expect(path).toHaveAttribute("title", "docs/guides/setup.md");
		// The stored title is not the label of a synced file.
		expect(
			screen.queryByText("Title of ctx_setup"),
		).not.toBeInTheDocument();
	});

	it("keeps rows without a sourcePath in the flat list", async () => {
		contextsListMock.mockResolvedValue(mixed);

		wrap(<ProjectContextsList projectId="proj_1" />);

		const section = await findLivingMemory();
		const upload = screen.getByRole("heading", {
			level: 3,
			name: "Scope.pdf",
		});
		expect(section).not.toContainElement(upload);
		expect(
			screen.queryByTestId("context-source-path-ctx_scope"),
		).not.toBeInTheDocument();
	});

	it("collapses and expands a folder from its header", async () => {
		contextsListMock.mockResolvedValue(mixed);
		const user = userEvent.setup();

		wrap(<ProjectContextsList projectId="proj_1" />);

		await findLivingMemory();
		const docs = screen.getByTestId("context-folder-docs");
		const header = folderHeader(docs);

		// Expanded by default, and the header names the panel it controls.
		expect(header).toHaveAttribute("aria-expanded", "true");
		const panelId = header.getAttribute("aria-controls");
		expect(panelId).toBeTruthy();
		const panel = document.getElementById(panelId as string);
		expect(docs).toContainElement(panel);
		expect(
			within(panel as HTMLElement).getByText("api.md"),
		).toBeInTheDocument();

		await user.click(header);
		expect(header).toHaveAttribute("aria-expanded", "false");
		expect(header).not.toHaveAttribute("aria-controls");
		expect(within(docs).queryByText("api.md")).not.toBeInTheDocument();
		// Only that folder collapsed.
		expect(
			within(screen.getByTestId("context-folder-docs-guides")).getByText(
				"setup.md",
			),
		).toBeInTheDocument();

		await user.click(header);
		expect(header).toHaveAttribute("aria-expanded", "true");
		expect(within(docs).getByText("api.md")).toBeInTheDocument();
	});

	it("keeps the card's menu on a synced file, deleting through the same procedure", async () => {
		contextsListMock.mockResolvedValue(
			listOf([syncedContext("ctx_api", "docs/api.md")]),
		);
		deleteCallMock.mockResolvedValue({ success: true });
		const user = userEvent.setup();

		wrap(<ProjectContextsList projectId="proj_1" />);

		const docs = await screen.findByTestId("context-folder-docs");
		await user.click(within(docs).getByLabelText("More options"));
		await user.click(await screen.findByText("Delete"));

		await waitFor(() =>
			expect(deleteCallMock).toHaveBeenCalledWith({
				id: "ctx_api",
				projectId: "proj_1",
				organizationId: "org_1",
			}),
		);
	});

	it("still marks a synced copy with the duplicate badge", async () => {
		contextsListMock.mockResolvedValue(
			listOf([
				syncedContext("ctx_copy", "docs/scope.md", {
					contentHash: "hash-scope",
					duplicateOfContextId: "ctx_original",
				}),
				uploadedContext("ctx_original", "Scope.pdf", {
					contentHash: "hash-scope",
				}),
			]),
		);

		wrap(<ProjectContextsList projectId="proj_1" />);

		const docs = await screen.findByTestId("context-folder-docs");
		const badge = within(docs).getByTestId(
			"context-duplicate-badge-ctx_copy",
		);
		expect(badge).toHaveTextContent(
			`projects.contexts.duplicates.badge${JSON.stringify({
				title: "Scope.pdf",
			})}`,
		);
	});

	it("shows no Living Memory section when nothing is synced", async () => {
		contextsListMock.mockResolvedValue(
			listOf([
				uploadedContext("ctx_a", "A.pdf"),
				// An empty path is not a synced file either.
				uploadedContext("ctx_b", "B.pdf", { sourcePath: "" }),
			]),
		);

		wrap(<ProjectContextsList projectId="proj_1" />);

		// Wait for the list itself before asserting absence.
		expect(await screen.findByText("A.pdf")).toBeInTheDocument();
		expect(screen.getByText("B.pdf")).toBeInTheDocument();
		expect(
			screen.queryByTestId("context-living-memory"),
		).not.toBeInTheDocument();
		expect(
			screen.queryByTestId(/^context-folder-/),
		).not.toBeInTheDocument();
	});
});
