/**
 * @vitest-environment jsdom
 */

/**
 * Contexts imported from a OneDrive or SharePoint document folder in
 * ProjectContextsList (Fizzy #2808).
 *
 * Pinned: such a row says where it came from, and while its folder is still
 * connected its delete warning adds that the file is not imported again until
 * it changes at the source, since the folder's sync leaves a removed file out.
 * A row from a disconnected folder, and every other row, keeps the plain
 * warning. The Document folders section the page passes in renders above the
 * list.
 */

import en from "@repo/i18n/translations/en.json";
import { FeatureFlagProvider } from "@saas/shared/components/FeatureFlagProvider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
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

const { contextsListMock } = vi.hoisted(() => ({
	contextsListMock: vi.fn(),
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
				delete: { call: vi.fn() },
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
	toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: null,
		organizationSlug: null,
		basePath: "/app",
	}),
}));

vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent: vi.fn() }),
}));

/**
 * Translations read from the English messages, so the assertions below see
 * the copy people read. A key with no message reads as itself.
 */
vi.mock("next-intl", () => {
	function lookup(path: string): unknown {
		return path
			.split(".")
			.reduce<unknown>(
				(node, key) =>
					node && typeof node === "object"
						? (node as Record<string, unknown>)[key]
						: undefined,
				en,
			);
	}
	function makeT(namespace?: string) {
		const full = (key: string) => (namespace ? `${namespace}.${key}` : key);
		const t = (key: string) => {
			const value = lookup(full(key));
			return typeof value === "string" ? value : full(key);
		};
		(t as unknown as { raw: (k: string) => unknown }).raw = (k: string) =>
			lookup(full(k)) ?? full(k);
		return t;
	}
	return {
		useTranslations: (namespace?: string) => makeT(namespace),
		useLocale: () => "en",
		useFormatter: () => ({
			dateTime: (d: Date) => d.toISOString(),
			number: (n: number) => String(n),
			relativeTime: (d: Date) => d.toISOString(),
		}),
		useMessages: () => ({}),
		NextIntlClientProvider: ({ children }: { children: ReactNode }) =>
			children,
	};
});

vi.mock("next/link", () => ({
	default: ({
		children,
		href,
		...rest
	}: {
		children: ReactNode;
		href: string;
	} & Record<string, unknown>) => (
		<a href={href} {...rest}>
			{children}
		</a>
	),
}));

// The warning shows on hover or focus; rendered in place here so the copy
// can be read straight off the row's menu.
vi.mock("@ui/components/destructive-tooltip", () => ({
	DestructiveTooltip: ({
		copy,
		children,
	}: {
		copy: { label: string; warning: string };
		children: ReactNode;
	}) => (
		<>
			{children}
			<p data-testid="delete-warning">{copy.warning}</p>
		</>
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

function fileContext(id: string, metadata: Record<string, unknown>) {
	return {
		id,
		type: "DOCUMENT",
		content: "Body",
		sourceUrl: null,
		sourceTitle: null,
		originalFilename: `${id}.docx`,
		extractionStatus: "COMPLETED",
		extractionError: null,
		embeddedAt: new Date("2026-11-01T10:00:00Z"),
		createdAt: new Date("2026-11-01T10:00:00Z"),
		updatedAt: new Date("2026-11-01T10:00:00Z"),
		contentPreview: "Body",
		contentLength: 4,
		fileSize: 1024,
		metadata: { title: id, ...metadata },
		sourceType: null,
		aiInstructions: null,
	};
}

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

async function row(title: string) {
	const heading = await screen.findByRole("heading", { name: title });
	const card = heading.closest("[data-context-id]");
	if (!card) {
		throw new Error(`No row for ${title}`);
	}
	return card as HTMLElement;
}

async function deleteWarning(title: string) {
	const card = await row(title);
	await userEvent.click(
		within(card).getByRole("button", { name: "More options" }),
	);
	return (await screen.findByTestId("delete-warning")).textContent;
}

beforeEach(() => {
	vi.clearAllMocks();
	contextsListMock.mockResolvedValue({
		contexts: [
			fileContext("Plan", {
				provider: "onedrive-documents",
				folderId: "folder-1",
				relativePath: "Plans/Plan.docx",
			}),
			fileContext("Brief", {
				provider: "sharepoint-documents",
				folderId: "folder-2",
				relativePath: "Brief.docx",
			}),
			fileContext("Upload", {}),
		],
	});
});

describe("ProjectContextsList — document-folder rows", () => {
	it("says which drive a row was imported from", async () => {
		wrap(<ProjectContextsList projectId="proj_1" />);
		expect(
			within(await row("Plan")).getByText("OneDrive · folder"),
		).toBeInTheDocument();
		expect(
			within(await row("Brief")).getByText("SharePoint · folder"),
		).toBeInTheDocument();
		expect(within(await row("Upload")).queryByText(/· folder/)).toBeNull();
	});

	it("warns before delete that the file returns only when it changes in OneDrive", async () => {
		wrap(
			<ProjectContextsList
				projectId="proj_1"
				connectedDocumentFolderIds={["folder-1", "folder-2"]}
			/>,
		);
		expect(await deleteWarning("Plan")).toBe(
			`${en.tooltips.contextSources.deleteContext.warning} It won't be imported again until the file changes in OneDrive.`,
		);
	});

	it("names SharePoint for a SharePoint row", async () => {
		wrap(
			<ProjectContextsList
				projectId="proj_1"
				connectedDocumentFolderIds={["folder-1", "folder-2"]}
			/>,
		);
		expect(await deleteWarning("Brief")).toContain(
			"until the file changes in SharePoint.",
		);
	});

	it("leaves the note out for a row whose folder is no longer connected", async () => {
		wrap(
			<ProjectContextsList
				projectId="proj_1"
				connectedDocumentFolderIds={["folder-2"]}
			/>,
		);
		expect(await deleteWarning("Plan")).toBe(
			en.tooltips.contextSources.deleteContext.warning,
		);
	});

	it("leaves the note out while no connected folder is known", async () => {
		wrap(<ProjectContextsList projectId="proj_1" />);
		expect(await deleteWarning("Plan")).toBe(
			en.tooltips.contextSources.deleteContext.warning,
		);
	});

	it("leaves other rows' delete warning unchanged", async () => {
		wrap(<ProjectContextsList projectId="proj_1" />);
		expect(await deleteWarning("Upload")).toBe(
			en.tooltips.contextSources.deleteContext.warning,
		);
	});

	it("renders the Document folders section it is given above the list", async () => {
		wrap(
			<ProjectContextsList
				projectId="proj_1"
				documentFolders={<section aria-label="Document folders" />}
			/>,
		);
		const plan = await row("Plan");
		const section = screen.getByRole("region", {
			name: "Document folders",
		});
		expect(
			section.compareDocumentPosition(plan) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});
});
