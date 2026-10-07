/**
 * `CompanyContextPanel` — organization settings → Company context
 * (Fizzy #2719).
 *
 * Pins the page body: it opens with where the material goes (client-facing
 * Proposals and Business Cases that may quote it); admins and owners get
 * add, edit, re-process and delete controls while every other member gets
 * the same list read-only with a note and a working download; each
 * source shows its processing state, failure or "needs re-processing"; the
 * list polls only while something is in flight or a deleted source has not
 * gone yet, up to the cap; and a crawling website's page list re-reads only
 * the pages it keeps live. Also pins the pure state and polling helpers the
 * list reads.
 *
 * `@tanstack/react-query` is real, so loads and mutations run through the
 * component's own hooks against a mocked `organizations.companyContext`.
 */

import {
	FEATURE_FLAG_REGISTRY,
	type FeatureFlagKey,
} from "@repo/utils/feature-flag-registry";
import { FeatureFlagProvider } from "@saas/shared/components/FeatureFlagProvider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
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
import { axe } from "vitest-axe";
import * as axeMatchers from "vitest-axe/matchers";

expect.extend(axeMatchers);

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
	if (!HTMLElement.prototype.hasPointerCapture) {
		HTMLElement.prototype.hasPointerCapture = (() => false) as never;
	}
	if (!HTMLElement.prototype.scrollIntoView) {
		HTMLElement.prototype.scrollIntoView = (() => undefined) as never;
	}
});

const state = vi.hoisted(() => ({
	role: "admin" as string | null,
	activeOrganizationId: "org-1",
	list: vi.fn(),
	remove: vi.fn(),
	resync: vi.fn(),
	cancelCrawl: vi.fn(),
	reprocess: vi.fn(),
	createDownloadUrl: vi.fn(),
	listUrlPages: vi.fn(),
	updateMetadata: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
	toastWarning: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		organizations: {
			companyContext: {
				list: (input: unknown) => state.list(input),
				delete: (input: unknown) => state.remove(input),
				resyncUrlSource: (input: unknown) => state.resync(input),
				cancelUrlSourceCrawl: (input: unknown) =>
					state.cancelCrawl(input),
				reprocess: (input: unknown) => state.reprocess(input),
				createDownloadUrl: (input: unknown) =>
					state.createDownloadUrl(input),
				listUrlPages: (input: unknown) => state.listUrlPages(input),
				updateMetadata: (input: unknown) => state.updateMetadata(input),
			},
		},
		searchProviders: {
			getOrganizationProviders: vi.fn(async () => []),
			getUserProviders: vi.fn(async () => []),
		},
	},
}));

vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => ({
		activeOrganization: {
			id: state.activeOrganizationId,
			name: "Example Org",
			members: [
				{ userId: "user-admin", user: { name: "Example Admin" } },
			],
		},
		activeOrganizationUserRole: state.role,
	}),
}));

vi.mock("sonner", () => ({
	toast: {
		success: (...args: unknown[]) => state.toastSuccess(...args),
		error: (...args: unknown[]) => state.toastError(...args),
		warning: (...args: unknown[]) => state.toastWarning(...args),
	},
}));

// Echo interpolation values so names and counts are visible to assertions.
vi.mock("next-intl", () => {
	const t = (key: string, values?: Record<string, unknown>) =>
		values ? `${key} ${JSON.stringify(values)}` : key;
	t.raw = (key: string) => key;
	return {
		useTranslations: () => t,
		useFormatter: () => ({
			dateTime: (date: Date) => date.toISOString().slice(0, 10),
		}),
	};
});

import { CompanyContextPanel } from "../CompanyContextPanel";
import {
	COMPANY_CONTEXT_CRAWL_POLL_INTERVAL_MS,
	COMPANY_CONTEXT_POLL_INTERVAL_MS,
	COMPANY_URL_PAGES_LIVE_PAGES,
	COMPANY_URL_PAGES_POLL_INTERVAL_MS,
	type CompanyContextListResult,
	companyContextPollInterval,
	companyUrlPagesPollInterval,
	MAX_COMPANY_CONTEXT_POLL_MS,
	MAX_COMPANY_CRAWL_IDLE_MS,
	resolveCompanySourceState,
	settlePendingCompanyDeletes,
	visibleCompanySources,
	withSavedCompanyMetadata,
} from "../company-context-adapter";

type Source = CompanyContextListResult["sources"][number];

const CREATED = new Date("2026-09-01T10:00:00.000Z");

function source(overrides: Partial<Source> & { id: string }): Source {
	return {
		organizationId: "org-1",
		type: "FILE",
		metadata: null,
		embeddedAt: CREATED,
		embeddingModel: "text-embedding-3-small",
		originalFilename: null,
		mimeType: null,
		fileSize: null,
		extractionStatus: "COMPLETED",
		extractionError: null,
		extractedAt: CREATED,
		sourceUrl: null,
		sourceTitle: null,
		urlScope: null,
		urlMaxPages: null,
		urlRefreshMode: null,
		urlNextRefreshAt: null,
		urlLastSyncedAt: null,
		sourceType: null,
		aiInstructions: null,
		metadataUpdatedAt: null,
		metadataUpdatedByUserId: null,
		contentHash: null,
		createdByUserId: "user-admin",
		createdAt: CREATED,
		updatedAt: CREATED,
		urlPageCount: 0,
		crawlInProgress: false,
		crawlProgress: null,
		crawlLastFetchedAt: null,
		deleting: false,
		ready: true,
		needsReprocessing: false,
		...overrides,
	} as Source;
}

const MODEL = { identity: "text-embedding-3-small", supported: true };

const CASE_STUDY = source({
	id: "src-case-study",
	originalFilename: "warehouse-case-study.pdf",
	sourceType: "Case Study",
	aiInstructions: "Anonymize the client name",
});
const WEBSITE_CRAWLING = source({
	id: "src-website",
	type: "LINK",
	sourceUrl: "https://example.com/",
	sourceTitle: "Example website",
	extractionStatus: "EXTRACTING",
	crawlInProgress: true,
	ready: false,
	embeddedAt: null,
	urlPageCount: 3,
	urlRefreshMode: "WEEKLY",
});
const TEXT_FAILED = source({
	id: "src-positioning",
	type: "TEXT",
	sourceTitle: "Positioning",
	extractionStatus: "FAILED",
	extractionError: "Failed to start indexing: worker unavailable",
	ready: false,
	embeddedAt: null,
});
const STALE_FILE = source({
	id: "src-capabilities",
	originalFilename: "capabilities.docx",
	ready: false,
	needsReprocessing: true,
});

function listResult(
	sources: Source[],
	embeddingModel: CompanyContextListResult["embeddingModel"] = MODEL,
): CompanyContextListResult {
	return { sources, embeddingModel };
}

function flags(overrides: Partial<Record<FeatureFlagKey, boolean>>) {
	const values = Object.fromEntries(
		Object.keys(FEATURE_FLAG_REGISTRY).map((key) => [key, false]),
	) as Record<FeatureFlagKey, boolean>;
	return { ...values, ...overrides };
}

function renderPanel({ gate = true }: { gate?: boolean } = {}) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, refetchOnWindowFocus: false },
			mutations: { retry: false },
		},
	});
	return render(
		<FeatureFlagProvider value={flags({ COMPANY_CONTEXT: gate })}>
			<QueryClientProvider client={client}>
				<CompanyContextPanel
					organizationId="org-1"
					organizationSlug="example-org"
				/>
			</QueryClientProvider>
		</FeatureFlagProvider>,
	);
}

async function row(id: string) {
	return within(await screen.findByTestId(`company-source-${id}`));
}

beforeEach(() => {
	vi.clearAllMocks();
	state.role = "admin";
	state.activeOrganizationId = "org-1";
	state.list.mockResolvedValue(
		listResult([CASE_STUDY, WEBSITE_CRAWLING, TEXT_FAILED, STALE_FILE]),
	);
	state.createDownloadUrl.mockResolvedValue({
		url: "https://storage.example.com/get/warehouse-case-study.pdf",
		filename: "warehouse-case-study.pdf",
		expiresAt: "2026-09-30T10:05:00.000Z",
		contextClass: "A",
	});
	state.remove.mockResolvedValue({ success: true, sourceId: "src" });
	state.reprocess.mockResolvedValue({ reprocessed: [], skipped: [] });
	state.resync.mockResolvedValue({ sourceId: "src", status: "EXTRACTING" });
	state.listUrlPages.mockResolvedValue({
		items: [
			{
				id: "page-1",
				pageUrl: "https://example.com/about",
				pageTitle: "About us",
				lastFetchedAt: CREATED,
				chunkCount: 4,
				extractionStatus: "COMPLETED",
				extractionError: null,
			},
		],
		nextCursor: null,
		total: 1,
	});
});

describe("CompanyContextPanel — gate and explanatory copy", () => {
	it("renders nothing and loads nothing while the gate is off", () => {
		const { container } = renderPanel({ gate: false });

		expect(container).toBeEmptyDOMElement();
		expect(state.list).not.toHaveBeenCalled();
	});

	it("opens with where the material goes: client-facing Proposals and Business Cases that may quote it", async () => {
		renderPanel();

		const usage = screen.getByTestId("company-context-usage");
		expect(
			within(usage).getByRole("heading", { name: "usage.title" }),
		).toBeInTheDocument();
		expect(within(usage).getByText("usage.body")).toBeInTheDocument();
		expect(within(usage).getByText("usage.scope")).toBeInTheDocument();
		await screen.findByTestId("company-context-sources");
		expect(state.list).toHaveBeenCalledWith({ organizationId: "org-1" });
	});
});

describe("CompanyContextPanel — admins and owners", () => {
	it.each(["admin", "owner"])(
		"an %s sees add, edit and delete controls and no read-only note",
		async (role) => {
			state.role = role;
			const user = userEvent.setup();
			renderPanel();

			const caseStudy = await row(CASE_STUDY.id);
			expect(screen.getByTestId("company-context-add")).toBeVisible();
			expect(
				screen.queryByTestId("company-context-read-only"),
			).not.toBeInTheDocument();

			await user.click(caseStudy.getByTestId("company-source-more"));
			expect(
				await screen.findByTestId(
					`company-source-edit-details-${CASE_STUDY.id}`,
				),
			).toBeInTheDocument();
			expect(
				screen.getByTestId("company-source-delete"),
			).toBeInTheDocument();
		},
	);

	it("edits a source's type label and AI instructions through the company procedure", async () => {
		const user = userEvent.setup();
		state.updateMetadata.mockResolvedValue({
			sourceId: CASE_STUDY.id,
			sourceType: "Case Study",
			aiInstructions: "Never name the client",
			metadataUpdatedAt: new Date("2026-09-30T09:00:00.000Z"),
			metadataUpdatedByUserId: "user-admin",
		});
		renderPanel();

		const caseStudy = await row(CASE_STUDY.id);
		await user.click(caseStudy.getByTestId("company-source-more"));
		await user.click(
			await screen.findByTestId(
				`company-source-edit-details-${CASE_STUDY.id}`,
			),
		);

		const instructions = await screen.findByLabelText("instructionsLabel");
		expect(instructions).toHaveValue("Anonymize the client name");
		await user.clear(instructions);
		await user.type(instructions, "Never name the client");
		await user.click(screen.getByRole("button", { name: "save" }));

		await waitFor(() =>
			expect(state.updateMetadata).toHaveBeenCalledWith({
				organizationId: "org-1",
				sourceId: CASE_STUDY.id,
				sourceType: "Case Study",
				aiInstructions: "Never name the client",
				expected: {
					sourceType: "Case Study",
					aiInstructions: "Anonymize the client name",
				},
			}),
		);
		expect(state.toastSuccess).toHaveBeenCalledWith("savedToast");
	});

	it("deletes a source after confirmation", async () => {
		const user = userEvent.setup();
		renderPanel();

		const caseStudy = await row(CASE_STUDY.id);
		await user.click(caseStudy.getByTestId("company-source-more"));
		await user.click(await screen.findByTestId("company-source-delete"));
		await user.click(
			await screen.findByTestId("company-context-confirm-delete"),
		);

		await waitFor(() =>
			expect(state.remove).toHaveBeenCalledWith({
				organizationId: "org-1",
				sourceId: CASE_STUDY.id,
			}),
		);
		expect(state.toastSuccess).toHaveBeenCalledWith("actions.deleted");
	});

	it("surfaces the server's CONFLICT message when a website is still crawling", async () => {
		const user = userEvent.setup();
		// The row reads as settled — a stale tab — but the server knows a
		// crawl was queued since.
		const settledWebsite = source({
			id: "src-docs",
			type: "LINK",
			sourceUrl: "https://example.com/docs/",
			sourceTitle: "Docs",
		});
		state.list.mockResolvedValue(listResult([settledWebsite]));
		state.remove.mockRejectedValue(
			Object.assign(
				new Error(
					"Processing is currently running for this website. Cancel it before deleting the source.",
				),
				{ code: "CONFLICT" },
			),
		);
		renderPanel();

		const website = await row(settledWebsite.id);
		await user.click(website.getByTestId("company-source-more"));
		await user.click(await screen.findByTestId("company-source-delete"));
		await user.click(
			await screen.findByTestId("company-context-confirm-delete"),
		);

		await waitFor(() =>
			expect(state.toastError).toHaveBeenCalledWith(
				"Processing is currently running for this website. Cancel it before deleting the source.",
			),
		);
		expect(state.toastSuccess).not.toHaveBeenCalled();
	});

	it("offers cancel instead of delete while a website crawls", async () => {
		const user = userEvent.setup();
		state.cancelCrawl.mockResolvedValue({
			sourceId: WEBSITE_CRAWLING.id,
			status: "CANCELLING",
		});
		renderPanel();

		const website = await row(WEBSITE_CRAWLING.id);
		await user.click(website.getByTestId("company-source-more"));

		const deleteItem = await screen.findByTestId("company-source-delete");
		expect(deleteItem).toHaveAttribute("data-disabled");
		expect(deleteItem).toHaveTextContent("actions.deleteBlocked");
		expect(
			screen.queryByTestId("company-source-sync"),
		).not.toBeInTheDocument();

		await user.click(screen.getByTestId("company-source-cancel-crawl"));
		await waitFor(() =>
			expect(state.cancelCrawl).toHaveBeenCalledWith({
				organizationId: "org-1",
				sourceId: WEBSITE_CRAWLING.id,
			}),
		);
	});

	it("offers only deleting again for a source being deleted: no sync or re-process", async () => {
		const user = userEvent.setup();
		// An earlier delete tombstoned it; the server refuses new work on it.
		const leavingWebsite = source({
			id: "src-leaving",
			type: "LINK",
			sourceUrl: "https://example.com/old/",
			sourceTitle: "Old site",
			extractionStatus: "FAILED",
			extractionError:
				"This source is being deleted. If it is still listed, delete it again.",
			ready: false,
			deleting: true,
		});
		state.list.mockResolvedValue(listResult([leavingWebsite]));
		renderPanel();

		const website = await row(leavingWebsite.id);
		await user.click(website.getByTestId("company-source-more"));

		const deleteItem = await screen.findByTestId("company-source-delete");
		expect(deleteItem).not.toHaveAttribute("data-disabled");
		expect(deleteItem).toHaveTextContent("actions.delete");
		expect(
			screen.queryByTestId("company-source-sync"),
		).not.toBeInTheDocument();
		expect(
			screen.queryByTestId("company-source-reprocess"),
		).not.toBeInTheDocument();

		await user.click(deleteItem);
		await user.click(
			await screen.findByTestId("company-context-confirm-delete"),
		);
		await waitFor(() =>
			expect(state.remove).toHaveBeenCalledWith({
				organizationId: "org-1",
				sourceId: leavingWebsite.id,
			}),
		);
	});

	it("re-syncs a settled website", async () => {
		const user = userEvent.setup();
		const settledWebsite = source({
			id: "src-docs",
			type: "LINK",
			sourceUrl: "https://example.com/docs/",
			sourceTitle: "Docs",
		});
		state.list.mockResolvedValue(listResult([settledWebsite]));
		renderPanel();

		const website = await row(settledWebsite.id);
		await user.click(website.getByTestId("company-source-more"));
		await user.click(await screen.findByTestId("company-source-sync"));

		await waitFor(() =>
			expect(state.resync).toHaveBeenCalledWith({
				organizationId: "org-1",
				sourceId: settledWebsite.id,
			}),
		);
		expect(state.toastSuccess).toHaveBeenCalledWith("actions.syncStarted");
		expect(state.toastWarning).not.toHaveBeenCalled();
	});

	it("warns when a re-sync starts but the refresh schedule still cannot be created", async () => {
		const user = userEvent.setup();
		const settledWebsite = source({
			id: "src-docs",
			type: "LINK",
			sourceUrl: "https://example.com/docs/",
			sourceTitle: "Docs",
			urlRefreshMode: "WEEKLY",
		});
		state.list.mockResolvedValue(listResult([settledWebsite]));
		state.resync.mockResolvedValue({
			sourceId: settledWebsite.id,
			status: "EXTRACTING",
			scheduleWarning: {
				code: "REFRESH_SCHEDULE_NOT_CREATED",
				message:
					"The website is being crawled, but its automatic refresh could not be scheduled. Re-sync the website to try again.",
			},
		});
		renderPanel();

		const website = await row(settledWebsite.id);
		await user.click(website.getByTestId("company-source-more"));
		await user.click(await screen.findByTestId("company-source-sync"));

		await waitFor(() =>
			expect(state.toastWarning).toHaveBeenCalledWith(
				"The website is being crawled, but its automatic refresh could not be scheduled. Re-sync the website to try again.",
			),
		);
		expect(state.toastSuccess).toHaveBeenCalledWith("actions.syncStarted");
	});

	it("re-processes one stale source, or every stale source at once", async () => {
		const user = userEvent.setup();
		state.reprocess.mockResolvedValueOnce({
			reprocessed: [STALE_FILE.id],
			skipped: [],
		});
		renderPanel();

		const stale = await row(STALE_FILE.id);
		await user.click(stale.getByTestId("company-source-more"));
		await user.click(await screen.findByTestId("company-source-reprocess"));
		await waitFor(() =>
			expect(state.reprocess).toHaveBeenCalledWith({
				organizationId: "org-1",
				sourceId: STALE_FILE.id,
			}),
		);

		state.reprocess.mockResolvedValueOnce({
			reprocessed: [STALE_FILE.id],
			skipped: [
				{ sourceId: "src-other", reason: "No scraper is configured" },
			],
		});
		await user.click(
			await screen.findByTestId("company-context-reprocess-all"),
		);
		await waitFor(() =>
			expect(state.reprocess).toHaveBeenLastCalledWith({
				organizationId: "org-1",
			}),
		);
		expect(state.toastSuccess).toHaveBeenCalledWith(
			'actions.reprocessAllStarted {"count":1}',
		);
		expect(state.toastWarning).toHaveBeenCalledWith(
			'actions.reprocessAllSkipped {"count":1}',
			{ description: "No scraper is configured" },
		);
	});

	it("does not treat an admin of ANOTHER organization as an editor here", async () => {
		state.activeOrganizationId = "org-2";
		renderPanel();

		await screen.findByTestId("company-context-sources");
		expect(
			screen.getByTestId("company-context-read-only"),
		).toBeInTheDocument();
		expect(
			screen.queryByTestId("company-context-add"),
		).not.toBeInTheDocument();
	});
});

describe("CompanyContextPanel — members", () => {
	beforeEach(() => {
		state.role = "member";
	});

	it("shows the sources read-only with the note that an admin manages them", async () => {
		renderPanel();

		const caseStudy = await row(CASE_STUDY.id);
		expect(
			screen.getByTestId("company-context-read-only"),
		).toHaveTextContent("readOnly");
		expect(
			screen.queryByTestId("company-context-add"),
		).not.toBeInTheDocument();
		expect(
			screen.queryByTestId("company-context-reprocess-all"),
		).not.toBeInTheDocument();
		expect(screen.queryAllByTestId("company-source-more")).toHaveLength(0);
		// The details are still visible, just not editable.
		expect(caseStudy.getByText("Case Study")).toBeInTheDocument();
		expect(
			caseStudy.getByText("Anonymize the client name"),
		).toBeInTheDocument();
	});

	it("downloads a single file", async () => {
		const user = userEvent.setup();
		const click = vi
			.spyOn(HTMLAnchorElement.prototype, "click")
			.mockImplementation(() => undefined);
		renderPanel();

		const caseStudy = await row(CASE_STUDY.id);
		await user.click(caseStudy.getByTestId("company-source-download"));

		await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
		expect(state.createDownloadUrl).toHaveBeenCalledWith({
			organizationId: "org-1",
			sourceId: CASE_STUDY.id,
		});
		const anchor = click.mock.contexts[0] as HTMLAnchorElement;
		expect(anchor.href).toBe(
			"https://storage.example.com/get/warehouse-case-study.pdf",
		);
		expect(anchor.download).toBe("warehouse-case-study.pdf");
		click.mockRestore();
	});

	it("says so when a download cannot be created", async () => {
		const user = userEvent.setup();
		state.createDownloadUrl.mockRejectedValue(new Error("boom"));
		renderPanel();

		const caseStudy = await row(CASE_STUDY.id);
		await user.click(caseStudy.getByTestId("company-source-download"));

		await waitFor(() =>
			expect(state.toastError).toHaveBeenCalledWith(
				"actions.downloadFailed",
			),
		);
	});

	it("opens a website's crawled pages", async () => {
		const user = userEvent.setup();
		renderPanel();

		const website = await row(WEBSITE_CRAWLING.id);
		const toggle = website.getByTestId("company-source-toggle-pages");
		expect(toggle).toHaveAttribute("aria-expanded", "false");
		await user.click(toggle);

		expect(toggle).toHaveAttribute("aria-expanded", "true");
		expect(await website.findByText("About us")).toBeInTheDocument();
		expect(state.listUrlPages).toHaveBeenCalledWith({
			organizationId: "org-1",
			sourceId: WEBSITE_CRAWLING.id,
			limit: 50,
			statusFilter: "all",
		});
	});

	it("has no detectable accessibility violations", async () => {
		const { container } = renderPanel();
		await screen.findByTestId("company-context-sources");

		expect(await axe(container)).toHaveNoViolations();
	});
});

describe("CompanyContextPanel — source states", () => {
	it("shows ready, processing, failed and needs-re-processing states", async () => {
		renderPanel();

		expect(
			(await row(CASE_STUDY.id)).getByTestId("company-source-status"),
		).toHaveTextContent("status.ready");
		expect(
			(await row(WEBSITE_CRAWLING.id)).getByTestId(
				"company-source-status",
			),
		).toHaveTextContent("status.processing");
		const failed = await row(TEXT_FAILED.id);
		expect(failed.getByTestId("company-source-status")).toHaveTextContent(
			"status.failed",
		);
		expect(failed.getByTestId("company-source-error")).toHaveTextContent(
			"Failed to start indexing: worker unavailable",
		);
		expect(
			(await row(STALE_FILE.id)).getByTestId("company-source-status"),
		).toHaveTextContent("status.needsReprocessing");
		expect(
			screen.getByTestId("company-context-stale-notice"),
		).toBeInTheDocument();
		expect(
			screen.getByText('list.summary {"ready":1,"total":4}'),
		).toBeInTheDocument();
	});

	it("shows a website saved with Live refresh as not refreshing automatically, which is what it does", async () => {
		const legacyLive = source({
			id: "src-legacy-live",
			type: "LINK",
			sourceUrl: "https://example.com/",
			sourceTitle: "Example website",
			urlRefreshMode: "LIVE",
		});
		state.list.mockResolvedValue(
			listResult([legacyLive, WEBSITE_CRAWLING]),
		);
		renderPanel();

		const legacy = await row(legacyLive.id);
		expect(legacy.getByText("row.refresh.ONCE")).toBeInTheDocument();
		expect(legacy.queryByText("row.refresh.LIVE")).not.toBeInTheDocument();
		expect(
			(await row(WEBSITE_CRAWLING.id)).getByText("row.refresh.WEEKLY"),
		).toBeInTheDocument();
	});

	it("shows how far a website's first crawl has got, and that a website is not used until its crawl finishes", async () => {
		const firstCrawl = source({
			id: "src-first-crawl",
			type: "LINK",
			sourceUrl: "https://example.com/",
			extractionStatus: "PENDING",
			crawlInProgress: true,
			ready: false,
			embeddedAt: null,
			urlPageCount: 200,
			crawlProgress: { processedPages: 47, totalPages: 200 },
		});
		// Still mapping the site: no pages to count yet.
		const mapping = source({
			id: "src-mapping",
			type: "LINK",
			sourceUrl: "https://example.net/",
			extractionStatus: "PENDING",
			crawlInProgress: true,
			ready: false,
			embeddedAt: null,
		});
		// A refresh of a website that is ready: it stays in use, and the
		// server reports no progress for it.
		const refresh = source({
			id: "src-refresh",
			type: "LINK",
			sourceUrl: "https://example.org/",
			crawlInProgress: true,
			urlPageCount: 200,
		});
		state.list.mockResolvedValue(
			listResult([firstCrawl, mapping, refresh]),
		);
		renderPanel();

		const first = await row(firstCrawl.id);
		expect(first.getByTestId("company-source-status")).toHaveTextContent(
			"status.processing",
		);
		expect(
			first.getByTestId("company-source-crawl-progress"),
		).toHaveTextContent('row.crawlProgress {"processed":47,"total":200}');
		expect(first.queryByText(/row\.pageCount/)).not.toBeInTheDocument();
		expect(
			first.getByTestId("company-source-crawl-hint"),
		).toHaveTextContent("row.crawlHint");

		const mapped = await row(mapping.id);
		expect(
			mapped.queryByTestId("company-source-crawl-progress"),
		).not.toBeInTheDocument();
		expect(
			mapped.getByTestId("company-source-crawl-hint"),
		).toBeInTheDocument();

		const refreshing = await row(refresh.id);
		expect(
			refreshing.queryByTestId("company-source-crawl-progress"),
		).not.toBeInTheDocument();
		expect(
			refreshing.getByText('row.pageCount {"count":200}'),
		).toBeInTheDocument();
		expect(
			refreshing.queryByTestId("company-source-crawl-hint"),
		).not.toBeInTheDocument();
	});

	it("explains that nothing is usable when no embedding provider is configured", async () => {
		state.list.mockResolvedValue(listResult([CASE_STUDY], null));
		renderPanel();

		const notice = await screen.findByTestId(
			"company-context-model-notice",
		);
		expect(notice).toHaveTextContent("missing");
		expect(
			within(notice).getByRole("link", { name: "openProviders" }),
		).toHaveAttribute("href", "/app/example-org/settings/ai-providers");
	});

	it("shows an empty state that fits the viewer", async () => {
		state.list.mockResolvedValue(listResult([]));
		state.role = "member";
		renderPanel();

		expect(
			await screen.findByTestId("company-context-empty"),
		).toHaveTextContent("list.emptyMember");
	});
});

/**
 * Polling, driven by the clock. `shouldAdvanceTime` keeps Radix menus and
 * `findBy*` working; each assertion is about what one or more explicit ticks
 * produced.
 */
describe("CompanyContextPanel — polling after a delete and during a crawl", () => {
	const NOW = new Date("2026-09-30T10:00:00.000Z");

	async function tick(ms: number) {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(ms);
		});
	}

	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		vi.setSystemTime(NOW);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("hides a deleted source at once and polls the list until the server stops returning it", async () => {
		// The deletion workflow has not removed the row yet.
		state.list.mockResolvedValue(listResult([CASE_STUDY, TEXT_FAILED]));
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		renderPanel();

		const caseStudy = await row(CASE_STUDY.id);
		// Nothing in flight: the list is not polling.
		await tick(10_000);
		expect(state.list).toHaveBeenCalledTimes(1);

		await user.click(caseStudy.getByTestId("company-source-more"));
		await user.click(await screen.findByTestId("company-source-delete"));
		await user.click(
			await screen.findByTestId("company-context-confirm-delete"),
		);
		await waitFor(() =>
			expect(state.toastSuccess).toHaveBeenCalledWith("actions.deleted"),
		);

		expect(
			screen.queryByTestId(`company-source-${CASE_STUDY.id}`),
		).not.toBeInTheDocument();
		expect(
			screen.getByText('list.summary {"ready":0,"total":1}'),
		).toBeInTheDocument();

		// Still returned: it stays hidden and the list keeps polling.
		const callsAfterDelete = state.list.mock.calls.length;
		await tick(COMPANY_CONTEXT_POLL_INTERVAL_MS);
		await waitFor(() =>
			expect(state.list.mock.calls.length).toBeGreaterThan(
				callsAfterDelete,
			),
		);
		expect(
			screen.queryByTestId(`company-source-${CASE_STUDY.id}`),
		).not.toBeInTheDocument();

		// Gone on the server: polling stops.
		state.list.mockResolvedValue(listResult([TEXT_FAILED]));
		await tick(COMPANY_CONTEXT_POLL_INTERVAL_MS);
		const callsOnceGone = state.list.mock.calls.length;
		await tick(10 * COMPANY_CONTEXT_POLL_INTERVAL_MS);
		expect(state.list).toHaveBeenCalledTimes(callsOnceGone);
		expect(
			screen.getByText('list.summary {"ready":0,"total":1}'),
		).toBeInTheDocument();
	});

	it("re-reads only the pages it keeps live while a website crawls, and every loaded page once the crawl ends", async () => {
		// Written just now, so the list follows the crawl.
		const crawling = source({ ...WEBSITE_CRAWLING, updatedAt: NOW });
		state.list.mockResolvedValue(listResult([crawling]));
		const urlPage = (n: number, nextCursor: string | null) => ({
			items: [
				{
					id: `page-${n}`,
					pageUrl: `https://example.com/page-${n}`,
					pageTitle: `Page ${n}`,
					lastFetchedAt: CREATED,
					chunkCount: 1,
					extractionStatus: "COMPLETED",
					extractionError: null,
				},
			],
			nextCursor,
			total: 4,
		});
		const byCursor: Record<string, ReturnType<typeof urlPage>> = {
			first: urlPage(1, "c1"),
			c1: urlPage(2, "c2"),
			c2: urlPage(3, "c3"),
			c3: urlPage(4, null),
		};
		state.listUrlPages.mockImplementation(
			async (input: { cursor?: string }) =>
				byCursor[input.cursor ?? "first"],
		);
		const cursors = () =>
			state.listUrlPages.mock.calls.map(
				([input]) => (input as { cursor?: string }).cursor,
			);
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		renderPanel();

		const website = await row(crawling.id);
		await user.click(website.getByTestId("company-source-toggle-pages"));
		await website.findByText("Page 1");
		await user.click(website.getByRole("button", { name: "loadMore" }));
		await website.findByText("Page 2");

		// Two pages loaded, within the live cap: a tick re-reads both.
		expect(COMPANY_URL_PAGES_LIVE_PAGES).toBeGreaterThanOrEqual(2);
		state.listUrlPages.mockClear();
		await tick(COMPANY_URL_PAGES_POLL_INTERVAL_MS);
		await waitFor(() =>
			expect(state.listUrlPages).toHaveBeenCalledTimes(2),
		);
		expect(cursors()).toEqual([undefined, "c1"]);

		// Paged past the cap: the list holds still while the crawl runs.
		await user.click(website.getByRole("button", { name: "loadMore" }));
		await website.findByText("Page 3");
		await user.click(website.getByRole("button", { name: "loadMore" }));
		await website.findByText("Page 4");
		state.listUrlPages.mockClear();
		await tick(3 * COMPANY_URL_PAGES_POLL_INTERVAL_MS);
		expect(state.listUrlPages).not.toHaveBeenCalled();

		// The crawl ends: every loaded page is re-read once, then no more.
		state.list.mockResolvedValue(
			listResult([
				source({
					...crawling,
					extractionStatus: "COMPLETED",
					crawlInProgress: false,
					ready: true,
					embeddedAt: NOW,
				}),
			]),
		);
		await tick(COMPANY_CONTEXT_POLL_INTERVAL_MS);
		await waitFor(() =>
			expect(state.listUrlPages).toHaveBeenCalledTimes(4),
		);
		expect(cursors()).toEqual([undefined, "c1", "c2", "c3"]);
		await tick(3 * COMPANY_URL_PAGES_POLL_INTERVAL_MS);
		expect(state.listUrlPages).toHaveBeenCalledTimes(4);
		expect(website.getByText("Page 4")).toBeInTheDocument();
	});
});

describe("company context state helpers", () => {
	it("reads a completed source that is not ready yet as indexing, and one with no usable model as not searchable", () => {
		const indexing = source({
			id: "a",
			ready: false,
			embeddedAt: null,
		});
		expect(resolveCompanySourceState(indexing, MODEL)).toBe("indexing");
		expect(resolveCompanySourceState(indexing, null)).toBe("notSearchable");
		expect(
			resolveCompanySourceState(
				{ ...indexing, extractionError: "Embedding failed" },
				MODEL,
			),
		).toBe("notSearchable");
	});

	it("puts re-processing ahead of whatever the source last recorded", () => {
		expect(
			resolveCompanySourceState(
				source({
					id: "a",
					extractionStatus: "FAILED",
					ready: false,
					needsReprocessing: true,
				}),
				MODEL,
			),
		).toBe("needsReprocessing");
	});

	it("polls while a source is in flight, and stops at the cap", () => {
		const now = CREATED.getTime();
		const pending = source({
			id: "a",
			extractionStatus: "PENDING",
			ready: false,
			embeddedAt: null,
		});

		expect(companyContextPollInterval(listResult([pending]), now)).toBe(
			COMPANY_CONTEXT_POLL_INTERVAL_MS,
		);
		expect(
			companyContextPollInterval(
				listResult([pending]),
				now + MAX_COMPANY_CONTEXT_POLL_MS - 1,
			),
		).toBe(COMPANY_CONTEXT_POLL_INTERVAL_MS);
		expect(
			companyContextPollInterval(
				listResult([pending]),
				now + MAX_COMPANY_CONTEXT_POLL_MS,
			),
		).toBe(false);
		expect(companyContextPollInterval(listResult([CASE_STUDY]), now)).toBe(
			false,
		);
		expect(companyContextPollInterval(undefined, now)).toBe(false);
	});

	it("keeps following a working website crawl past the cap, at a slower pace", () => {
		const now = CREATED.getTime();
		const threeHours = 3 * 60 * 60 * 1000;
		// A crawl writes its pages, not its source, so the source's last
		// write is when the crawl started.
		const crawling = source({
			id: "a",
			type: "LINK",
			extractionStatus: "PENDING",
			crawlInProgress: true,
			ready: false,
			embeddedAt: null,
		});
		const pending = source({
			id: "b",
			extractionStatus: "PENDING",
			ready: false,
			embeddedAt: null,
		});
		const fetchedAt = (ms: number) => ({
			...crawling,
			crawlLastFetchedAt: new Date(ms),
		});

		expect(
			companyContextPollInterval(
				listResult([crawling]),
				now + MAX_COMPANY_CONTEXT_POLL_MS - 1,
			),
		).toBe(COMPANY_CONTEXT_POLL_INTERVAL_MS);
		// Past the cap, before its first page: it started recently.
		expect(
			companyContextPollInterval(
				listResult([crawling]),
				now + MAX_COMPANY_CONTEXT_POLL_MS,
			),
		).toBe(COMPANY_CONTEXT_CRAWL_POLL_INTERVAL_MS);
		// Hours in, still fetching pages.
		expect(
			companyContextPollInterval(
				listResult([fetchedAt(now + threeHours - 60_000)]),
				now + threeHours,
			),
		).toBe(COMPANY_CONTEXT_CRAWL_POLL_INTERVAL_MS);
		// A slot that was never released: nothing fetched for the idle limit.
		expect(
			companyContextPollInterval(
				listResult([
					fetchedAt(now + threeHours - MAX_COMPANY_CRAWL_IDLE_MS),
				]),
				now + threeHours,
			),
		).toBe(false);
		expect(
			companyContextPollInterval(
				listResult([crawling]),
				now + threeHours,
			),
		).toBe(false);
		// A fresh in-flight source still sets the faster pace.
		expect(
			companyContextPollInterval(
				listResult([
					crawling,
					{
						...pending,
						updatedAt: new Date(now + MAX_COMPANY_CONTEXT_POLL_MS),
					},
				]),
				now + MAX_COMPANY_CONTEXT_POLL_MS,
			),
		).toBe(COMPANY_CONTEXT_POLL_INTERVAL_MS);
		// A scheduled refresh of a ready website is followed the same way.
		const refreshing = source({
			id: "c",
			type: "LINK",
			crawlInProgress: true,
			crawlLastFetchedAt: new Date(now + threeHours - 60_000),
		});
		expect(
			companyContextPollInterval(
				listResult([refreshing]),
				now + threeHours,
			),
		).toBe(COMPANY_CONTEXT_CRAWL_POLL_INTERVAL_MS);
		// Once the crawl lets go of its slot, polling stops.
		expect(
			companyContextPollInterval(
				listResult([{ ...refreshing, crawlInProgress: false }]),
				now + threeHours,
			),
		).toBe(false);
		// A source stuck pending with no crawl still stops at the cap.
		expect(
			companyContextPollInterval(
				listResult([pending]),
				now + MAX_COMPANY_CONTEXT_POLL_MS,
			),
		).toBe(false);
	});

	it("follows an old source again once a re-sync writes it", () => {
		const longAgo = new Date(
			CREATED.getTime() - 10 * MAX_COMPANY_CONTEXT_POLL_MS,
		);
		const resynced = source({
			id: "a",
			type: "LINK",
			extractionStatus: "PENDING",
			crawlInProgress: true,
			createdAt: longAgo,
			updatedAt: CREATED,
		});

		expect(
			companyContextPollInterval(
				listResult([resynced]),
				CREATED.getTime() + 1000,
			),
		).toBe(COMPANY_CONTEXT_POLL_INTERVAL_MS);
	});

	it("polls while a deleted source is still returned, up to the cap from its delete", () => {
		const now = CREATED.getTime();
		// Settled, so only the pending delete keeps the list polling.
		const deleting = new Map([[CASE_STUDY.id, now]]);

		expect(
			companyContextPollInterval(listResult([CASE_STUDY]), now, deleting),
		).toBe(COMPANY_CONTEXT_POLL_INTERVAL_MS);
		expect(
			companyContextPollInterval(
				listResult([CASE_STUDY]),
				now + MAX_COMPANY_CONTEXT_POLL_MS,
				deleting,
			),
		).toBe(false);
		// Once the server no longer returns it, there is nothing to wait for.
		expect(
			companyContextPollInterval(listResult([STALE_FILE]), now, deleting),
		).toBe(false);
	});

	it("hides pending deletes and forgets each once the server stops returning it", () => {
		const deleting = new Map([
			[CASE_STUDY.id, 1],
			[TEXT_FAILED.id, 2],
		]);
		const result = listResult([CASE_STUDY, STALE_FILE]);

		expect(
			visibleCompanySources(result.sources, deleting).map(
				(visible) => visible.id,
			),
		).toEqual([STALE_FILE.id]);
		expect([...settlePendingCompanyDeletes(deleting, result)]).toEqual([
			[CASE_STUDY.id, 1],
		]);

		// Nothing to forget: the same map, so a state update bails out.
		const stillThere = new Map([[CASE_STUDY.id, 1]]);
		expect(settlePendingCompanyDeletes(stillThere, result)).toBe(
			stillThere,
		);
	});

	it("keeps a crawling website's page list live only up to the page cap", () => {
		expect(companyUrlPagesPollInterval(true, 1)).toBe(
			COMPANY_URL_PAGES_POLL_INTERVAL_MS,
		);
		expect(
			companyUrlPagesPollInterval(true, COMPANY_URL_PAGES_LIVE_PAGES),
		).toBe(COMPANY_URL_PAGES_POLL_INTERVAL_MS);
		expect(
			companyUrlPagesPollInterval(true, COMPANY_URL_PAGES_LIVE_PAGES + 1),
		).toBe(false);
		expect(companyUrlPagesPollInterval(false, 1)).toBe(false);
	});

	it("writes a metadata save into the company list", () => {
		const updated = withSavedCompanyMetadata(listResult([CASE_STUDY]), {
			contextId: CASE_STUDY.id,
			sourceType: "Capability",
			aiInstructions: null,
			metadataUpdatedAt: "2026-09-30T09:00:00.000Z",
			metadataUpdatedByUserId: "user-admin",
		});

		expect(updated?.sources[0]).toMatchObject({
			id: CASE_STUDY.id,
			sourceType: "Capability",
			aiInstructions: null,
			metadataUpdatedByUserId: "user-admin",
		});
	});
});
