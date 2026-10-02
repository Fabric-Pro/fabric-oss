/**
 * What the company context procedures do once a caller is authorized
 * (Fizzy #2719). Who may call them is `permissions.test.ts`; the notice is
 * `notice-state.test.ts`.
 *
 * Every workflow a procedure starts must name the company owner, carry no
 * project, and go to the company queue — a company job must never reach a
 * worker that would run it down the project path.
 */
import { logger } from "@repo/logs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () =>
	(await import("./support/harness")).databaseModule(),
);
vi.mock("@repo/temporal", async () =>
	(await import("./support/harness")).temporalModule(),
);
vi.mock("@repo/rag", async () =>
	(await import("./support/harness")).ragModule(),
);
vi.mock("@repo/ai", async () => (await import("./support/harness")).aiModule());
vi.mock("@repo/storage", async () =>
	(await import("./support/harness")).storageModule(),
);
vi.mock("@repo/utils", async (importOriginal) =>
	(await import("./support/harness")).utilsModule(importOriginal),
);
vi.mock("@repo/logs", async () =>
	(await import("./support/harness")).logsModule(),
);
vi.mock("@repo/config", async () =>
	(await import("./support/harness")).configModule(),
);
vi.mock("../../../../../lib/audit", async () =>
	(await import("./support/harness")).auditModule(),
);
vi.mock("../../../../../lib/realtime", () => ({
	emitContextChange: vi.fn(),
	emitActivity: vi.fn(),
}));
vi.mock("../../../../../lib/notification-service", () => ({
	createNotification: vi.fn(),
}));
vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: <T>(options: T) => options,
}));
vi.mock("../../../../../orpc/procedures", async () =>
	(await import("./support/harness")).proceduresModule(),
);

import { cancelCompanyContextUrlSourceCrawlProcedure } from "../cancel-url-source-crawl";
import { createCompanyContextDownloadUrlProcedure } from "../create-download-url";
import { createCompanyContextTextProcedure } from "../create-text";
import { createCompanyContextUploadUrlProcedure } from "../create-upload-url";
import { deleteCompanyContextSourceProcedure } from "../delete";
import { getCompanyContextSourceProcedure } from "../get";
import { listCompanyContextSourcesProcedure } from "../list";
import { listCompanyContextUrlPagesProcedure } from "../list-url-pages";
import { processCompanyContextFileProcedure } from "../process-file";
import {
	COMPANY_CONTEXT_BULK_URL_MAX,
	processCompanyContextLinkProcedure,
} from "../process-link";
import { reprocessCompanyContextProcedure } from "../reprocess";
import { resyncCompanyContextUrlSourceProcedure } from "../resync-url-source";
import { updateCompanyContextMetadataProcedure } from "../update-metadata";
import {
	CURRENT_MODEL,
	call,
	FakeAIProviderNotConfiguredError,
	FakeScheduleAlreadyRunning,
	FakeScheduleNotFoundError,
	FakeWorkflowNotFoundError,
	inputSchemaOf,
	mocks,
	ORG,
	OTHER_ORG,
	rejection,
	resetDefaults,
	sourceRow,
	storeSources,
} from "./support/harness";

const COMPANY_OWNER = { kind: "company", organizationId: ORG };

/** The options of the `n`th workflow start. */
function started(n = 0) {
	const [workflowType, options] = mocks.workflowStart.mock.calls[n] ?? [];
	return {
		workflowType,
		options: options as {
			taskQueue: string;
			workflowId: string;
			args: Record<string, unknown>[];
		},
	};
}

/**
 * The claim that records a started crawl on its source: the crawl's own slot
 * claim, granted only while the source is still queued or crawling. What
 * that claim matches is pinned by the database package's own test.
 */
function crawlStamp(sourceId: string, workflowId: string) {
	return {
		id: sourceId,
		organizationId: ORG,
		workflowId,
		onlyWhileInFlight: true,
	};
}

function expectCompanyStart(n: number, workflowType: string) {
	const start = started(n);
	expect(start.workflowType).toBe(workflowType);
	expect(start.options.taskQueue).toBe("company-context");
	expect(start.options.args[0]).toMatchObject({
		organizationId: ORG,
		owner: COMPANY_OWNER,
	});
	expect(start.options.args[0]).not.toHaveProperty("projectId");
	return start.options;
}

beforeEach(() => {
	resetDefaults();
});

describe("reading sources", () => {
	it("get returns the source with its content, and nothing internal", async () => {
		storeSources([
			sourceRow({
				id: "src_1",
				type: "FILE",
				s3Path: `${ORG}/company-context/x.pdf`,
				s3Bucket: "contexts-bucket",
				qdrantId: "q_1",
			}),
		]);
		mocks.listReadyCompanyContextSourceIds.mockResolvedValue(["src_1"]);

		const { source } = await call(
			getCompanyContextSourceProcedure,
			{ organizationId: ORG, sourceId: "src_1" },
			"u_member",
		);

		expect(source).toMatchObject({
			id: "src_1",
			content: expect.stringContaining("warehouse"),
			ready: true,
			needsReprocessing: false,
			crawlInProgress: false,
		});
		for (const internal of [
			"s3Path",
			"s3Bucket",
			"qdrantId",
			"urlScheduleId",
			"urlActiveWorkflowId",
		]) {
			expect(source).not.toHaveProperty(internal);
		}
	});

	it("get and delete answer NOT_FOUND for another organization's source id", async () => {
		storeSources([sourceRow({ id: "src_b", organizationId: OTHER_ORG })]);

		expect(
			await rejection(
				call(
					getCompanyContextSourceProcedure,
					{ organizationId: ORG, sourceId: "src_b" },
					"u_admin",
				),
			),
		).toBe("NOT_FOUND");
		expect(
			await rejection(
				call(
					deleteCompanyContextSourceProcedure,
					{ organizationId: ORG, sourceId: "src_b" },
					"u_admin",
				),
			),
		).toBe("NOT_FOUND");
		expect(mocks.getCompanyContextSource).toHaveBeenCalledWith(
			"src_b",
			ORG,
		);
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("list reports each source's state, and marks sources from an older model as needing re-processing", async () => {
		storeSources([
			sourceRow({ id: "src_current" }),
			sourceRow({
				id: "src_old",
				embeddingModel: "openai:text-embedding-ada-002",
			}),
			sourceRow({
				id: "src_refused",
				extractionStatus: "FAILED",
				extractionError:
					"Unsupported embedding model: acme:large produces 3072-dimension vectors",
				embeddedAt: null,
				embeddingModel: null,
			}),
			sourceRow({
				id: "src_processing",
				extractionStatus: "EXTRACTING",
				embeddedAt: null,
				embeddingModel: null,
			}),
			sourceRow({
				id: "src_crawling",
				type: "LINK",
				extractionStatus: "EXTRACTING",
				urlActiveWorkflowId: "url-crawl-src_crawling",
			}),
		]);
		mocks.listReadyCompanyContextSourceIds.mockResolvedValue([
			"src_current",
		]);

		const result = await call(
			listCompanyContextSourcesProcedure,
			{ organizationId: ORG },
			"u_member",
		);

		const byId = Object.fromEntries(
			result.sources.map((s: { id: string }) => [s.id, s]),
		);
		expect(mocks.listReadyCompanyContextSourceIds).toHaveBeenCalledWith(
			ORG,
			CURRENT_MODEL.identity,
		);
		expect(byId.src_current).toMatchObject({
			ready: true,
			needsReprocessing: false,
		});
		expect(byId.src_old).toMatchObject({
			ready: false,
			needsReprocessing: true,
		});
		expect(byId.src_refused).toMatchObject({
			ready: false,
			needsReprocessing: true,
		});
		expect(byId.src_processing).toMatchObject({
			ready: false,
			needsReprocessing: false,
		});
		expect(byId.src_crawling).toMatchObject({ crawlInProgress: true });
		expect(byId.src_crawling).not.toHaveProperty("urlActiveWorkflowId");
		expect(result.embeddingModel).toEqual({
			identity: CURRENT_MODEL.identity,
			supported: true,
		});
	});

	it("with no embedding provider nothing is ready and nothing is offered for re-processing", async () => {
		storeSources([sourceRow({ id: "src_1" })]);
		mocks.resolveCompanyEmbeddingModel.mockRejectedValue(
			new FakeAIProviderNotConfiguredError(),
		);

		const result = await call(
			listCompanyContextSourcesProcedure,
			{ organizationId: ORG },
			"u_member",
		);

		expect(result.embeddingModel).toBeNull();
		expect(result.sources[0]).toMatchObject({
			ready: false,
			needsReprocessing: false,
		});
		expect(mocks.listReadyCompanyContextSourceIds).not.toHaveBeenCalled();
	});

	it("a website refreshing on its schedule is in progress, not in need of re-processing", async () => {
		// A scheduled refresh holds the crawl slot and leaves the status
		// COMPLETED; a page it adds keeps the source out of the ready set
		// until it is embedded. Nothing about the model changed.
		storeSources([
			sourceRow({
				id: "src_refreshing",
				type: "LINK",
				sourceUrl: "https://example.com/docs",
				urlRefreshMode: "DAILY",
				urlActiveWorkflowId:
					"url-crawl-src_refreshing-2026-09-30T00:00:00Z",
			}),
			sourceRow({
				id: "src_settling",
				type: "LINK",
				sourceUrl: "https://example.com/blog",
			}),
		]);

		const result = await call(
			listCompanyContextSourcesProcedure,
			{ organizationId: ORG },
			"u_member",
		);

		const byId = Object.fromEntries(
			result.sources.map((s: { id: string }) => [s.id, s]),
		);
		expect(byId.src_refreshing).toMatchObject({
			ready: false,
			crawlInProgress: true,
			needsReprocessing: false,
		});
		expect(byId.src_settling).toMatchObject({
			ready: false,
			crawlInProgress: false,
			needsReprocessing: false,
		});
	});

	it("a website with a crawled page from an earlier model needs re-processing, though the website itself carries the current one", async () => {
		const website = sourceRow({
			id: "src_link",
			type: "LINK",
			sourceUrl: "https://example.com/docs",
		});
		storeSources([website]);
		mocks.urlPageFindMany.mockResolvedValue([
			{ parentSourceId: "src_link" },
		]);

		const listed = await call(
			listCompanyContextSourcesProcedure,
			{ organizationId: ORG },
			"u_member",
		);
		const got = await call(
			getCompanyContextSourceProcedure,
			{ organizationId: ORG, sourceId: "src_link" },
			"u_member",
		);

		expect(listed.sources[0]).toMatchObject({ needsReprocessing: true });
		expect(got.source).toMatchObject({ needsReprocessing: true });
		// Pages of this organization holding vectors from any other model —
		// or from no recorded model — one row per website.
		expect(mocks.urlPageFindMany).toHaveBeenCalledWith({
			where: {
				organizationId: ORG,
				embeddedAt: { not: null },
				OR: [
					{ embeddingModel: null },
					{ embeddingModel: { not: CURRENT_MODEL.identity } },
				],
			},
			select: { parentSourceId: true },
			distinct: ["parentSourceId"],
		});
	});

	it("listUrlPages reads the pages of this organization's website only", async () => {
		storeSources([
			sourceRow({
				id: "src_link",
				type: "LINK",
				sourceUrl: "https://example.com/docs",
			}),
		]);
		mocks.urlPageFindMany.mockResolvedValue([
			{ id: "p1", pageUrl: "https://example.com/docs/a" },
			{ id: "p2", pageUrl: "https://example.com/docs/b" },
			{ id: "p3", pageUrl: "https://example.com/docs/c" },
		]);
		mocks.urlPageCount.mockResolvedValue(7);

		const result = await call(
			listCompanyContextUrlPagesProcedure,
			{
				organizationId: ORG,
				sourceId: "src_link",
				limit: 2,
				statusFilter: "failed",
			},
			"u_viewer",
		);

		const query = mocks.urlPageFindMany.mock.calls[0]?.[0];
		expect(query.where).toMatchObject({
			parentSourceId: "src_link",
			organizationId: ORG,
			extractionStatus: { in: ["FAILED"] },
		});
		expect(query.select).not.toHaveProperty("content");
		expect(result).toEqual({
			items: [
				{ id: "p1", pageUrl: "https://example.com/docs/a" },
				{ id: "p2", pageUrl: "https://example.com/docs/b" },
			],
			nextCursor: "p2",
			total: 7,
		});
	});
});

describe("adding sources", () => {
	it("createUploadUrl stores the file under the organization's company-context prefix", async () => {
		const result = await call(
			createCompanyContextUploadUrlProcedure,
			{
				organizationId: ORG,
				filename: "capabilities.pdf",
				mimeType: "application/pdf",
				size: 2048,
			},
			"u_admin",
		);

		const created = mocks.createCompanyFileSource.mock.calls[0]?.[0];
		expect(created).toMatchObject({
			organizationId: ORG,
			createdByUserId: "u_admin",
			s3Bucket: "contexts-bucket",
			originalFilename: "capabilities.pdf",
			mimeType: "application/pdf",
			fileSize: 2048,
		});
		expect(created.s3Path).toMatch(
			new RegExp(`^${ORG}/company-context/[0-9a-f-]{36}\\.pdf$`),
		);
		expect(mocks.getSignedUploadUrl).toHaveBeenCalledWith(created.s3Path, {
			bucket: "contexts-bucket",
			contentType: "application/pdf",
		});
		expect(result).toEqual({
			sourceId: expect.any(String),
			signedUploadUrl: "https://storage.example.com/put",
			contentType: "application/pdf",
		});
	});

	it("createUploadUrl refuses the formats and sizes the project refuses, writing nothing", async () => {
		expect(
			await rejection(
				call(
					createCompanyContextUploadUrlProcedure,
					{
						organizationId: ORG,
						filename: "tool.exe",
						mimeType: "application/x-msdownload",
						size: 10,
					},
					"u_admin",
				),
			),
		).toBe("BAD_REQUEST");
		expect(
			await rejection(
				call(
					createCompanyContextUploadUrlProcedure,
					{
						organizationId: ORG,
						filename: "huge.pdf",
						mimeType: "application/pdf",
						size: 500 * 1024 * 1024,
					},
					"u_admin",
				),
			),
		).toBe("BAD_REQUEST");
		expect(mocks.createCompanyFileSource).not.toHaveBeenCalled();
	});

	it("processFile starts extraction for the company owner on the company queue", async () => {
		storeSources([
			sourceRow({
				id: "src_file",
				type: "FILE",
				extractionStatus: "PENDING",
				s3Path: `${ORG}/company-context/f.pdf`,
			}),
		]);

		const result = await call(
			processCompanyContextFileProcedure,
			{ organizationId: ORG, sourceId: "src_file" },
			"u_admin",
		);

		expect(result).toMatchObject({
			sourceId: "src_file",
			status: "EXTRACTING",
		});
		// Claimed PENDING → EXTRACTING in one conditional write, before the start.
		expect(mocks.claimCompanyFileSourceForProcessing).toHaveBeenCalledWith({
			id: "src_file",
			organizationId: ORG,
		});
		expect(
			mocks.claimCompanyFileSourceForProcessing.mock
				.invocationCallOrder[0],
		).toBeLessThan(mocks.workflowStart.mock.invocationCallOrder[0]);
		expect(mocks.updateCompanyContextSourceStatus).not.toHaveBeenCalled();
		const options = expectCompanyStart(
			0,
			"projectContextProcessingWorkflow",
		);
		expect(options.workflowId).toBe("company-context-processing-src_file");
		expect(options.args[0]).toMatchObject({
			contextId: "src_file",
			userId: "u_admin",
		});
	});

	it("processFile reports a run already in progress without reverting the source", async () => {
		storeSources([
			sourceRow({
				id: "src_file",
				type: "FILE",
				extractionStatus: "PENDING",
				s3Path: `${ORG}/company-context/f.pdf`,
			}),
		]);
		const alreadyStarted = new Error("Workflow execution already started");
		alreadyStarted.name = "WorkflowExecutionAlreadyStartedError";
		mocks.workflowStart.mockRejectedValueOnce(alreadyStarted);

		const result = await call(
			processCompanyContextFileProcedure,
			{ organizationId: ORG, sourceId: "src_file" },
			"u_admin",
		);

		expect(result).toMatchObject({ status: "EXTRACTING" });
		expect(mocks.releaseCompanyContextSourceClaim).not.toHaveBeenCalled();
	});

	it("createText saves the text and starts embedding it without carrying the body", async () => {
		await call(
			createCompanyContextTextProcedure,
			{
				organizationId: ORG,
				title: "About us",
				content: "  We deliver warehouse software.  ",
				sourceType: "Company overview",
			},
			"u_owner",
		);

		expect(mocks.createCompanyTextSource).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: ORG,
				createdByUserId: "u_owner",
				content: "We deliver warehouse software.",
				sourceTitle: "About us",
				sourceType: "Company overview",
			}),
		);
		const options = expectCompanyStart(0, "contextEmbeddingWorkflow");
		expect(options.args[0]).not.toHaveProperty("content");
	});

	it("createText marks the source FAILED when indexing cannot start", async () => {
		mocks.workflowStart.mockRejectedValueOnce(new Error("temporal down"));

		expect(
			await rejection(
				call(
					createCompanyContextTextProcedure,
					{ organizationId: ORG, title: "About", content: "Text" },
					"u_admin",
				),
			),
		).toBe("INTERNAL_SERVER_ERROR");
		expect(mocks.updateCompanyContextSourceStatus).toHaveBeenCalledWith(
			expect.any(String),
			ORG,
			"FAILED",
			{ extractionError: "Failed to start indexing: temporal down" },
		);
	});

	it("processLink adds one website and starts its crawl for the company owner", async () => {
		const result = await call(
			processCompanyContextLinkProcedure,
			{
				organizationId: ORG,
				url: "https://example.com/docs",
				label: "Docs",
				scope: "PATH_PREFIX",
				maxPages: 50,
				refreshMode: "DAILY",
			},
			"u_admin",
		);

		expect(result.sources).toEqual([
			{
				url: "https://example.com/docs",
				sourceId: expect.any(String),
				status: "EXTRACTING",
			},
		]);
		expect(mocks.createCompanyLinkSource).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: ORG,
				sourceUrl: "https://example.com/docs",
				sourceTitle: "Docs",
				urlScope: "PATH_PREFIX",
				urlMaxPages: 50,
				urlRefreshMode: "DAILY",
			}),
		);
		const options = expectCompanyStart(0, "urlSourceCrawlWorkflow");
		expect(options.args[0]).toMatchObject({
			url: "https://example.com/docs",
			scope: "PATH_PREFIX",
			maxPages: 50,
			apiKey: "fc-test-key",
			providerName: "firecrawl",
			mode: "initial",
		});
		expect(mocks.claimCompanyLinkSourceCrawl).toHaveBeenCalledWith(
			crawlStamp(result.sources[0].sourceId, options.workflowId),
		);
		// The DAILY cadence gets its schedule, for the company owner.
		expect(mocks.createUrlSourceSchedule).toHaveBeenCalledWith(
			expect.objectContaining({
				contextId: result.sources[0].sourceId,
				organizationId: ORG,
				owner: COMPANY_OWNER,
				refreshMode: "DAILY",
			}),
			expect.anything(),
		);
		expect(
			mocks.createUrlSourceSchedule.mock.calls[0]?.[0],
		).not.toHaveProperty("projectId");
	});

	it("processLink adds a bulk paste as one source per URL", async () => {
		const urls = Array.from(
			{ length: COMPANY_CONTEXT_BULK_URL_MAX },
			(_, i) => `https://example.com/page-${i}`,
		);

		const result = await call(
			processCompanyContextLinkProcedure,
			{ organizationId: ORG, urls },
			"u_admin",
		);

		expect(result.sources).toHaveLength(50);
		expect(mocks.createCompanyLinkSource).toHaveBeenCalledTimes(50);
		expect(mocks.workflowStart).toHaveBeenCalledTimes(50);
	});

	it("processLink rejects a bulk request over 50 URLs at the input", () => {
		const schema = inputSchemaOf(processCompanyContextLinkProcedure);
		const urls = (n: number) =>
			Array.from({ length: n }, (_, i) => `https://example.com/p-${i}`);

		expect(
			schema.safeParse({ organizationId: ORG, urls: urls(50) }).success,
		).toBe(true);
		expect(
			schema.safeParse({ organizationId: ORG, urls: urls(51) }).success,
		).toBe(false);
	});

	it("processLink validates URLs as the project does, and takes exactly one of url and urls", () => {
		const schema = inputSchemaOf(processCompanyContextLinkProcedure);
		expect(
			schema.safeParse({
				organizationId: ORG,
				url: "https://user:secret@example.com/",
			}).success,
		).toBe(false);
		expect(
			schema.safeParse({ organizationId: ORG, url: "not a url" }).success,
		).toBe(false);
		expect(schema.safeParse({ organizationId: ORG }).success).toBe(false);
		expect(
			schema.safeParse({
				organizationId: ORG,
				url: "https://example.com/a",
				urls: ["https://example.com/b"],
			}).success,
		).toBe(false);
		expect(
			schema.safeParse({
				organizationId: ORG,
				urls: ["https://example.com/b"],
				label: "One label for many",
			}).success,
		).toBe(false);
	});

	it("processLink accepts only http(s) URLs, one or in bulk", () => {
		const schema = inputSchemaOf(processCompanyContextLinkProcedure) as {
			safeParse: (value: unknown) => {
				success: boolean;
				error?: { issues: { message: string }[] };
			};
		};

		for (const url of [
			"javascript:alert(1)",
			"data:text/html,<p>hello</p>",
			"file:///etc/passwd",
			"ftp://example.com/brochure.pdf",
			"mailto:dev@example.com",
		]) {
			const single = schema.safeParse({ organizationId: ORG, url });
			expect(single.success, url).toBe(false);
			expect(
				single.error?.issues.map((issue) => issue.message),
			).toContain("Only http:// and https:// website URLs can be added.");
			expect(
				schema.safeParse({
					organizationId: ORG,
					urls: ["https://example.com/a", url],
				}).success,
				url,
			).toBe(false);
		}
		for (const url of ["http://example.com/", "https://example.com/docs"]) {
			expect(schema.safeParse({ organizationId: ORG, url }).success).toBe(
				true,
			);
		}
	});

	it("processLink reports a bulk URL whose crawl cannot start and goes on with the rest", async () => {
		mocks.workflowStart
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("temporal down"))
			.mockResolvedValueOnce(undefined);

		const result = await call(
			processCompanyContextLinkProcedure,
			{
				organizationId: ORG,
				urls: [
					"https://example.com/a",
					"https://example.com/b",
					"https://example.com/c",
				],
			},
			"u_admin",
		);

		expect(result.sources.map((s: { status: string }) => s.status)).toEqual(
			["EXTRACTING", "FAILED", "EXTRACTING"],
		);
		expect(result.sources[1].sourceId).toEqual(expect.any(String));
		expect(mocks.releaseCompanyContextSourceClaim).toHaveBeenCalledWith({
			id: result.sources[1].sourceId,
			organizationId: ORG,
			status: "FAILED",
			extractionError: "Failed to start crawl: temporal down",
		});
	});

	it("processLink without a scraper answers the project's code and writes nothing", async () => {
		mocks.getEnabledOrganizationSearchProviders.mockResolvedValue([]);

		let caught: unknown;
		try {
			await call(
				processCompanyContextLinkProcedure,
				{ organizationId: ORG, url: "https://example.com" },
				"u_admin",
			);
		} catch (error) {
			caught = error;
		}
		expect(caught).toMatchObject({
			code: "BAD_REQUEST",
			data: {
				code: "SCRAPE_PROVIDER_NOT_CONFIGURED",
				settingsPath: "/app/example-org/settings/search-providers",
			},
		});
		expect(mocks.createCompanyLinkSource).not.toHaveBeenCalled();
	});

	it("processLink needs a crawl-capable scraper for a path prefix", async () => {
		mocks.getEnabledOrganizationSearchProviders.mockResolvedValue([
			{
				providerName: "jina",
				encryptedApiKey: "encrypted",
				enabled: true,
				isDefault: true,
				priority: 0,
				createdAt: new Date("2026-01-01"),
			},
		]);

		let caught: unknown;
		try {
			await call(
				processCompanyContextLinkProcedure,
				{
					organizationId: ORG,
					url: "https://example.com/docs",
					scope: "PATH_PREFIX",
				},
				"u_admin",
			);
		} catch (error) {
			caught = error;
		}
		expect(caught).toMatchObject({
			code: "BAD_REQUEST",
			data: { code: "CRAWL_PROVIDER_NOT_CONFIGURED" },
		});
	});
});

describe("editing a source's type label and AI instructions", () => {
	const saved = sourceRow({
		id: "src_1",
		sourceType: "Case study",
		aiInstructions: "Anonymize the client name.",
		metadataUpdatedAt: new Date("2026-09-30T10:00:00Z"),
		metadataUpdatedByUserId: "u_admin",
	});

	it("enforces the project's 80- and 500-character limits at the input", () => {
		const schema = inputSchemaOf(updateCompanyContextMetadataProcedure);
		const base = { organizationId: ORG, sourceId: "src_1" };

		expect(
			schema.safeParse({ ...base, sourceType: "x".repeat(80) }).success,
		).toBe(true);
		expect(
			schema.safeParse({ ...base, sourceType: "x".repeat(81) }).success,
		).toBe(false);
		expect(
			schema.safeParse({ ...base, aiInstructions: "x".repeat(500) })
				.success,
		).toBe(true);
		expect(
			schema.safeParse({ ...base, aiInstructions: "x".repeat(501) })
				.success,
		).toBe(false);
	});

	it("a real change writes one curated audit row with both values", async () => {
		mocks.updateCompanyContextSourceMetadata.mockResolvedValue({
			status: "updated",
			source: saved,
			before: { sourceType: null, aiInstructions: null },
			after: {
				sourceType: "Case study",
				aiInstructions: "Anonymize the client name.",
			},
			changed: ["sourceType", "aiInstructions"],
		});

		const result = await call(
			updateCompanyContextMetadataProcedure,
			{
				organizationId: ORG,
				sourceId: "src_1",
				sourceType: "Case study",
				aiInstructions: "Anonymize the client name.",
				expected: { sourceType: null, aiInstructions: null },
			},
			"u_admin",
		);

		expect(mocks.updateCompanyContextSourceMetadata).toHaveBeenCalledWith(
			"src_1",
			ORG,
			"u_admin",
			{
				sourceType: "Case study",
				aiInstructions: "Anonymize the client name.",
			},
			{ expected: { sourceType: null, aiInstructions: null } },
		);
		expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
		expect(mocks.recordAudit).toHaveBeenCalledWith(expect.anything(), {
			action: "org.company_context.metadata_updated",
			category: "org",
			organizationId: ORG,
			resource: {
				type: "company_context_source",
				id: "src_1",
				name: "Case study",
			},
			metadata: {
				changed: ["sourceType", "aiInstructions"],
				before: { sourceType: null, aiInstructions: null },
				after: {
					sourceType: "Case study",
					aiInstructions: "Anonymize the client name.",
				},
				via: "web",
			},
		});
		// The content of the source never reaches the ledger.
		expect(
			JSON.stringify(mocks.recordAudit.mock.calls[0]?.[1]),
		).not.toMatch(/warehouse/);
		expect(result).toEqual({
			sourceId: "src_1",
			sourceType: "Case study",
			aiInstructions: "Anonymize the client name.",
			metadataUpdatedAt: saved.metadataUpdatedAt,
			metadataUpdatedByUserId: "u_admin",
		});
	});

	it("a save that changes nothing records nothing", async () => {
		mocks.updateCompanyContextSourceMetadata.mockResolvedValue({
			status: "unchanged",
			source: saved,
		});

		await call(
			updateCompanyContextMetadataProcedure,
			{
				organizationId: ORG,
				sourceId: "src_1",
				sourceType: "Case study",
			},
			"u_admin",
		);
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	it("a concurrent edit answers CONFLICT with the stored values and records nothing", async () => {
		mocks.updateCompanyContextSourceMetadata.mockResolvedValue({
			status: "stale",
			current: saved,
		});

		let caught: unknown;
		try {
			await call(
				updateCompanyContextMetadataProcedure,
				{
					organizationId: ORG,
					sourceId: "src_1",
					sourceType: "Brochure",
					expected: { sourceType: null, aiInstructions: null },
				},
				"u_admin",
			);
		} catch (error) {
			caught = error;
		}
		expect(caught).toMatchObject({
			code: "CONFLICT",
			data: {
				current: {
					sourceType: "Case study",
					aiInstructions: "Anonymize the client name.",
					metadataUpdatedByUserId: "u_admin",
				},
			},
		});
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	it("another organization's source is NOT_FOUND", async () => {
		mocks.updateCompanyContextSourceMetadata.mockResolvedValue({
			status: "not-found",
		});

		expect(
			await rejection(
				call(
					updateCompanyContextMetadataProcedure,
					{ organizationId: ORG, sourceId: "src_b", sourceType: "X" },
					"u_admin",
				),
			),
		).toBe("NOT_FOUND");
	});
});

describe("website crawls and deleting", () => {
	const crawling = () =>
		sourceRow({
			id: "src_link",
			type: "LINK",
			sourceUrl: "https://example.com/docs",
			urlScope: "PATH_PREFIX",
			extractionStatus: "EXTRACTING",
			urlActiveWorkflowId: "url-crawl-src_link",
			urlScheduleId: "url-source-schedule-src_link",
			qdrantId: null,
		});

	it("deleting a website mid-crawl answers CONFLICT and leaves the source, its pages and its schedule", async () => {
		storeSources([crawling()]);

		expect(
			await rejection(
				call(
					deleteCompanyContextSourceProcedure,
					{ organizationId: ORG, sourceId: "src_link" },
					"u_admin",
				),
			),
		).toBe("CONFLICT");
		expect(mocks.workflowStart).not.toHaveBeenCalled();
		expect(mocks.deleteUrlSourceSchedule).not.toHaveBeenCalled();
	});

	it("after the crawl is cancelled, the delete removes the source, its pages and its vectors", async () => {
		storeSources([crawling()]);

		const cancelled = await call(
			cancelCompanyContextUrlSourceCrawlProcedure,
			{ organizationId: ORG, sourceId: "src_link" },
			"u_admin",
		);
		expect(cancelled).toEqual({
			sourceId: "src_link",
			status: "CANCELLING",
		});
		expect(mocks.workflowCancel).toHaveBeenCalledTimes(1);

		// The crawl finalizes the source on cancellation.
		storeSources([
			sourceRow({
				...crawling(),
				extractionStatus: "COMPLETED",
				urlActiveWorkflowId: null,
			}),
		]);

		const deleted = await call(
			deleteCompanyContextSourceProcedure,
			{ organizationId: ORG, sourceId: "src_link" },
			"u_admin",
		);
		expect(deleted).toEqual({ success: true, sourceId: "src_link" });
		// One durable deletion removes the refresh schedule, the source's own
		// and every page's vectors, the stored file and the row (whose pages
		// cascade); the row is left for it, since it needs the row to find the
		// rest. Nothing is removed before it has started.
		expect(mocks.deleteUrlSourceSchedule).not.toHaveBeenCalled();
		const options = expectCompanyStart(0, "contextDeletionWorkflow");
		expect(options.args[0]).toMatchObject({
			contextId: "src_link",
			userId: "u_admin",
			metadata: { contextType: "LINK" },
		});
	});

	it.each([
		[
			"no longer knows",
			new Error("workflow not found for ID: url-crawl-src_link"),
		],
		["has already closed", new FakeWorkflowNotFoundError()],
	])(
		"cancelling a crawl Temporal %s clears its id and reports it finished",
		async (_case, error) => {
			storeSources([crawling()]);
			mocks.workflowCancel.mockRejectedValueOnce(error);

			const result = await call(
				cancelCompanyContextUrlSourceCrawlProcedure,
				{ organizationId: ORG, sourceId: "src_link" },
				"u_admin",
			);

			expect(result).toEqual({
				sourceId: "src_link",
				status: "ALREADY_FINISHED",
			});
			// Only while the slot still holds that crawl's id.
			expect(mocks.sourceUpdateMany).toHaveBeenCalledWith({
				where: {
					id: "src_link",
					organizationId: ORG,
					type: "LINK",
					urlActiveWorkflowId: "url-crawl-src_link",
				},
				data: { urlActiveWorkflowId: null },
			});
		},
	);

	it("re-sync refuses a crawl in flight, and otherwise re-crawls on the company queue", async () => {
		storeSources([crawling()]);
		expect(
			await rejection(
				call(
					resyncCompanyContextUrlSourceProcedure,
					{ organizationId: ORG, sourceId: "src_link" },
					"u_admin",
				),
			),
		).toBe("CONFLICT");

		storeSources([
			// The failed crawl finalized the source and freed its slot.
			sourceRow({
				...crawling(),
				extractionStatus: "FAILED",
				urlActiveWorkflowId: null,
			}),
		]);
		await call(
			resyncCompanyContextUrlSourceProcedure,
			{ organizationId: ORG, sourceId: "src_link" },
			"u_admin",
		);
		// PENDING with the old message cleared, through the idle-source claim.
		expect(
			mocks.claimCompanyContextSourceForReprocess,
		).toHaveBeenCalledWith({ id: "src_link", organizationId: ORG });
		expect(mocks.updateCompanyContextSourceStatus).not.toHaveBeenCalled();
		const options = expectCompanyStart(0, "urlSourceCrawlWorkflow");
		expect(options.args[0]).toMatchObject({
			contextId: "src_link",
			mode: "manual-resync",
		});
	});

	it("every crawl start follows the URL-source contract: ids, input, status first and the handle after", async () => {
		const contract = (
			n: number,
			sourceId: string,
			mode: "initial" | "manual-resync",
		) => {
			const options = expectCompanyStart(n, "urlSourceCrawlWorkflow");
			expect(options.workflowId).toMatch(
				mode === "initial"
					? new RegExp(`^url-crawl-${sourceId}$`)
					: new RegExp(`^url-crawl-${sourceId}-resync-\\d+$`),
			);
			// Exactly the workflow's input: no project, no extra flag.
			expect(Object.keys(options.args[0]).sort()).toEqual(
				[
					"apiKey",
					"contextId",
					"maxPages",
					"mode",
					"organizationId",
					"owner",
					"parentSourceTitle",
					"providerName",
					"scope",
					"url",
					"urlRefreshMode",
					"userId",
				].sort(),
			);
			expect(options.args[0]).toMatchObject({
				contextId: sourceId,
				userId: "u_admin",
				organizationId: ORG,
				apiKey: "fc-test-key",
				providerName: "firecrawl",
				mode,
				owner: COMPANY_OWNER,
			});
			// The status is set before the start (and after the previous
			// one) — by a re-sync or a re-process, through its claim — the
			// handle stamped after.
			const start = mocks.workflowStart.mock.invocationCallOrder[n];
			const previous =
				n > 0 ? mocks.workflowStart.mock.invocationCallOrder[n - 1] : 0;
			const statusWrites = [
				...mocks.updateCompanyContextSourceStatus.mock.calls
					.map((call, index) => ({
						call,
						order: mocks.updateCompanyContextSourceStatus.mock
							.invocationCallOrder[index],
					}))
					.filter(
						({ call }) =>
							call[0] === sourceId &&
							(call[2] === "PENDING" || call[2] === "EXTRACTING"),
					),
				...mocks.claimCompanyContextSourceForReprocess.mock.calls
					.map((call, index) => ({
						call,
						order: mocks.claimCompanyContextSourceForReprocess.mock
							.invocationCallOrder[index],
					}))
					.filter(({ call }) => call[0].id === sourceId),
			].filter(({ order }) => order > previous && order < start);
			expect(statusWrites.length).toBeGreaterThan(0);
			// The first write after this start is the stamp of its id.
			const stamps = mocks.claimCompanyLinkSourceCrawl.mock.calls
				.map((call, index) => ({
					call,
					order: mocks.claimCompanyLinkSourceCrawl.mock
						.invocationCallOrder[index],
				}))
				.filter(({ order }) => order > start);
			expect(stamps[0]?.call).toEqual([
				crawlStamp(sourceId, options.workflowId),
			]);
		};

		await call(
			processCompanyContextLinkProcedure,
			{
				organizationId: ORG,
				url: "https://example.com/docs",
				scope: "PATH_PREFIX",
				maxPages: 50,
				refreshMode: "ONCE",
			},
			"u_admin",
		);
		contract(0, "src_new_1", "initial");

		storeSources([
			// The failed crawl finalized the source and freed its slot.
			sourceRow({
				...crawling(),
				extractionStatus: "FAILED",
				urlActiveWorkflowId: null,
			}),
		]);
		await call(
			resyncCompanyContextUrlSourceProcedure,
			{ organizationId: ORG, sourceId: "src_link" },
			"u_admin",
		);
		contract(1, "src_link", "manual-resync");

		await call(
			reprocessCompanyContextProcedure,
			{ organizationId: ORG, sourceId: "src_link" },
			"u_admin",
		);
		contract(2, "src_link", "manual-resync");
	});

	it("recording a started crawl never overwrites another crawl's claim, nor refills the slot of a crawl that already finished", async () => {
		const stored = sourceRow({
			...crawling(),
			extractionStatus: "COMPLETED",
			urlActiveWorkflowId: null,
		});
		const row = stored as Record<string, unknown>;
		storeSources([stored]);
		// The stored row answers every write from its WHERE, as Postgres would.
		mocks.claimCompanyContextSourceForReprocess.mockImplementation(
			async () => {
				row.extractionStatus = "PENDING";
				return true;
			},
		);
		// The crawl-slot claim, as the query answers it: a slot free or
		// already this crawl's, and — when asked — a source still queued or
		// crawling.
		mocks.claimCompanyLinkSourceCrawl.mockImplementation(
			async ({
				workflowId,
				onlyWhileInFlight,
			}: {
				workflowId: string;
				onlyWhileInFlight?: boolean;
			}) => {
				const slot = row.urlActiveWorkflowId;
				const inFlight =
					row.extractionStatus === "PENDING" ||
					row.extractionStatus === "EXTRACTING";
				if (
					(slot !== null && slot !== workflowId) ||
					(onlyWhileInFlight && !inFlight)
				) {
					return false;
				}
				row.urlActiveWorkflowId = workflowId;
				return true;
			},
		);
		const resync = () =>
			call(
				resyncCompanyContextUrlSourceProcedure,
				{ organizationId: ORG, sourceId: "src_link" },
				"u_admin",
			);

		// A scheduled refresh claims the slot between this start and its stamp.
		const scheduledRun = "url-crawl-src_link-2026-09-30T00:00:00Z";
		mocks.workflowStart.mockImplementationOnce(async () => {
			row.extractionStatus = "EXTRACTING";
			row.urlActiveWorkflowId = scheduledRun;
		});
		await expect(resync()).resolves.toMatchObject({ sourceId: "src_link" });
		expect(row.urlActiveWorkflowId).toBe(scheduledRun);

		// The crawl ran to its end before the stamp could land.
		Object.assign(row, {
			extractionStatus: "COMPLETED",
			urlActiveWorkflowId: null,
		});
		mocks.workflowStart.mockImplementationOnce(async () => {
			row.extractionStatus = "COMPLETED";
		});
		await expect(resync()).resolves.toMatchObject({ sourceId: "src_link" });
		expect(row.urlActiveWorkflowId).toBeNull();

		// Neither miss is a failure: nothing is marked FAILED or logged as one.
		expect(mocks.releaseCompanyContextSourceClaim).not.toHaveBeenCalled();
		expect(logger.error).not.toHaveBeenCalled();
		const misses = () =>
			vi
				.mocked(logger.debug)
				.mock.calls.filter(([message]) =>
					String(message).includes("not recorded"),
				).length;
		expect(misses()).toBe(2);

		// A free slot on a queued source is stamped, as is one the crawl
		// already claimed for itself.
		Object.assign(row, {
			extractionStatus: "COMPLETED",
			urlActiveWorkflowId: null,
		});
		await resync();
		expect(row.urlActiveWorkflowId).toBe(started(2).options.workflowId);

		Object.assign(row, {
			extractionStatus: "COMPLETED",
			urlActiveWorkflowId: null,
		});
		mocks.workflowStart.mockImplementationOnce(
			async (_type: string, options: { workflowId: string }) => {
				row.extractionStatus = "EXTRACTING";
				row.urlActiveWorkflowId = options.workflowId;
			},
		);
		await resync();
		expect(row.urlActiveWorkflowId).toBe(started(3).options.workflowId);
		expect(misses()).toBe(2);
	});

	it("a website a scheduled refresh is crawling is in flight: delete, re-sync and re-process wait, and cancel stops that crawl", async () => {
		// A scheduled refresh holds the crawl slot and leaves the status
		// COMPLETED.
		const scheduledRun = "url-crawl-src_link-2026-09-30T00:00:00Z";
		storeSources([
			sourceRow({
				...crawling(),
				extractionStatus: "COMPLETED",
				urlRefreshMode: "DAILY",
				urlActiveWorkflowId: scheduledRun,
			}),
		]);
		const target = { organizationId: ORG, sourceId: "src_link" };

		expect(
			await rejection(
				call(deleteCompanyContextSourceProcedure, target, "u_admin"),
			),
		).toBe("CONFLICT");
		expect(
			await rejection(
				call(resyncCompanyContextUrlSourceProcedure, target, "u_admin"),
			),
		).toBe("CONFLICT");
		expect(
			await rejection(
				call(reprocessCompanyContextProcedure, target, "u_admin"),
			),
		).toBe("CONFLICT");
		expect(mocks.workflowStart).not.toHaveBeenCalled();
		expect(mocks.sourceUpdateMany).not.toHaveBeenCalled();
		expect(mocks.updateCompanyContextSourceStatus).not.toHaveBeenCalled();
		expect(
			mocks.claimCompanyContextSourceForReprocess,
		).not.toHaveBeenCalled();

		const cancelled = await call(
			cancelCompanyContextUrlSourceCrawlProcedure,
			target,
			"u_admin",
		);
		expect(cancelled).toEqual({
			sourceId: "src_link",
			status: "CANCELLING",
		});
		expect(mocks.workflowGetHandle).toHaveBeenCalledWith(scheduledRun);
		expect(mocks.workflowCancel).toHaveBeenCalledTimes(1);
	});

	it("deleting a website takes it out of retrieval before the deletion starts, and leaves its schedule to the workflow", async () => {
		storeSources([
			sourceRow({
				...crawling(),
				extractionStatus: "COMPLETED",
				urlRefreshMode: "DAILY",
				urlActiveWorkflowId: null,
			}),
		]);

		const deleted = await call(
			deleteCompanyContextSourceProcedure,
			{ organizationId: ORG, sourceId: "src_link" },
			"u_admin",
		);

		expect(deleted).toEqual({ success: true, sourceId: "src_link" });
		// Tombstoned, so the readiness predicate drops it at once — and only
		// if no other delete tombstoned it and nothing claimed it since the
		// in-flight check.
		expect(mocks.sourceUpdateMany).toHaveBeenCalledTimes(1);
		expect(mocks.sourceUpdateMany).toHaveBeenCalledWith({
			where: {
				id: "src_link",
				organizationId: ORG,
				deletingAt: null,
				extractionStatus: "COMPLETED",
				urlActiveWorkflowId: null,
			},
			data: {
				deletingAt: expect.any(Date),
				extractionStatus: "FAILED",
				extractionError: expect.stringMatching(/being deleted/),
			},
		});
		const [start] = mocks.workflowStart.mock.invocationCallOrder;
		expect(mocks.sourceUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
			start,
		);
		// The deletion workflow removes the schedule itself, durably.
		expect(mocks.deleteUrlSourceSchedule).not.toHaveBeenCalled();
		expect(mocks.workflowGetHandle).not.toHaveBeenCalled();
		expectCompanyStart(0, "contextDeletionWorkflow");
	});

	it("a deletion that cannot start keeps the source tombstoned, schedule untouched, and asks for the delete to be repeated", async () => {
		storeSources([
			sourceRow({
				...crawling(),
				extractionStatus: "COMPLETED",
				extractionError: null,
				urlRefreshMode: "DAILY",
				urlActiveWorkflowId: null,
			}),
		]);
		// A start that times out here may still have reached Temporal, so the
		// deletion may already be under way: the tombstone must stay.
		mocks.workflowStart.mockRejectedValueOnce(
			new Error("deadline exceeded"),
		);

		await expect(
			call(
				deleteCompanyContextSourceProcedure,
				{ organizationId: ORG, sourceId: "src_link" },
				"u_admin",
			),
		).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			message: expect.stringMatching(/Delete it again/),
		});

		expect(mocks.sourceUpdateMany).toHaveBeenCalledTimes(1);
		const [[mark]] = mocks.sourceUpdateMany.mock.calls;
		expect(mark.data.deletingAt).toBeInstanceOf(Date);
		expect(mocks.deleteUrlSourceSchedule).not.toHaveBeenCalled();
	});

	it("a delete that loses the source to a crawl claiming it answers CONFLICT and starts nothing", async () => {
		storeSources([
			sourceRow({
				...crawling(),
				extractionStatus: "COMPLETED",
				urlActiveWorkflowId: null,
			}),
		]);
		mocks.sourceUpdateMany.mockResolvedValueOnce({ count: 0 });

		expect(
			await rejection(
				call(
					deleteCompanyContextSourceProcedure,
					{ organizationId: ORG, sourceId: "src_link" },
					"u_admin",
				),
			),
		).toBe("CONFLICT");
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("deleting a text starts the durable deletion with no schedule to remove", async () => {
		storeSources([sourceRow({ id: "src_text", qdrantId: "q_1" })]);

		await call(
			deleteCompanyContextSourceProcedure,
			{ organizationId: ORG, sourceId: "src_text" },
			"u_owner",
		);

		expect(mocks.deleteUrlSourceSchedule).not.toHaveBeenCalled();
		expect(mocks.sourceUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ id: "src_text" }),
				data: expect.objectContaining({ extractionStatus: "FAILED" }),
			}),
		);
		const options = expectCompanyStart(0, "contextDeletionWorkflow");
		expect(options.args[0]).toMatchObject({
			contextId: "src_text",
			qdrantId: "q_1",
		});
		// One id per source, so a repeated start finds the running deletion.
		expect(options.workflowId).toBe("company-context-deletion-src_text");
	});
});

describe("a source being deleted", () => {
	const DELETING_AT = new Date("2026-09-30T12:00:00.000Z");
	const DELETING_MESSAGE =
		"This source is being deleted. If it is still listed, delete it again.";

	/** A source an earlier delete tombstoned. */
	const tombstoned = (overrides: Record<string, unknown> = {}) =>
		sourceRow({
			deletingAt: DELETING_AT,
			extractionStatus: "FAILED",
			extractionError: DELETING_MESSAGE,
			...overrides,
		});

	/** A conditional write applied to `row` as the database would apply it. */
	function applyUpdateMany(row: Record<string, unknown>) {
		mocks.sourceUpdateMany.mockImplementation(
			async ({
				where,
				data,
			}: {
				where: Record<string, unknown>;
				data: Record<string, unknown>;
			}) => {
				const matches = Object.entries(where).every(([key, value]) =>
					value instanceof Date
						? row[key] instanceof Date &&
							(row[key] as Date).getTime() === value.getTime()
						: row[key] === value,
				);
				if (!matches) {
					return { count: 0 };
				}
				Object.assign(row, data);
				return { count: 1 };
			},
		);
	}

	it("of two deletes racing for one source, one tombstones it, and both start the same deterministic deletion before answering success", async () => {
		const row = sourceRow({ id: "src_text" });
		storeSources([row]);
		applyUpdateMany(row);
		// Both deletes read the source before either writes.
		let loads = 0;
		let bothLoaded!: () => void;
		const loaded = new Promise<void>((resolve) => {
			bothLoaded = resolve;
		});
		mocks.getCompanyContextSourceMeta.mockImplementation(async () => {
			const { content: _content, ...meta } = row;
			const seen = { ...meta };
			loads += 1;
			if (loads === 2) {
				bothLoaded();
			}
			if (loads <= 2) {
				await loaded;
			}
			return seen;
		});
		const target = { organizationId: ORG, sourceId: "src_text" };

		const results = await Promise.all([
			call(deleteCompanyContextSourceProcedure, target, "u_admin"),
			call(deleteCompanyContextSourceProcedure, target, "u_owner"),
		]);

		expect(results).toEqual([
			{ success: true, sourceId: "src_text" },
			{ success: true, sourceId: "src_text" },
		]);
		// Both tried to tombstone it; the second found the first's tombstone.
		expect(
			await Promise.all(
				mocks.sourceUpdateMany.mock.results.map(
					(result) => result.value,
				),
			),
		).toEqual([{ count: 1 }, { count: 0 }]);
		expect(row.deletingAt).toBeInstanceOf(Date);
		// The loser does not trust the tombstone alone — its writer may have
		// failed before starting — so it starts the same id; Temporal keeps
		// one execution.
		expect(mocks.workflowStart).toHaveBeenCalledTimes(2);
		expect(
			expectCompanyStart(0, "contextDeletionWorkflow").workflowId,
		).toBe("company-context-deletion-src_text");
		expect(
			expectCompanyStart(1, "contextDeletionWorkflow").workflowId,
		).toBe("company-context-deletion-src_text");
	});

	it("deleting it again starts its deletion under the same id without writing, and a deletion still running is success", async () => {
		storeSources([
			tombstoned({ id: "src_text" }),
			// A late status write can leave a tombstoned website reading as
			// queued; nothing can claim it, so that is no running crawl.
			tombstoned({
				id: "src_link",
				type: "LINK",
				sourceUrl: "https://example.com/docs",
				extractionStatus: "PENDING",
			}),
		]);

		await expect(
			call(
				deleteCompanyContextSourceProcedure,
				{ organizationId: ORG, sourceId: "src_text" },
				"u_admin",
			),
		).resolves.toEqual({ success: true, sourceId: "src_text" });
		expect(
			expectCompanyStart(0, "contextDeletionWorkflow").workflowId,
		).toBe("company-context-deletion-src_text");

		mocks.workflowStart.mockRejectedValueOnce(
			Object.assign(new Error("Workflow execution already started"), {
				name: "WorkflowExecutionAlreadyStartedError",
			}),
		);
		await expect(
			call(
				deleteCompanyContextSourceProcedure,
				{ organizationId: ORG, sourceId: "src_link" },
				"u_admin",
			),
		).resolves.toEqual({ success: true, sourceId: "src_link" });
		expect(
			expectCompanyStart(1, "contextDeletionWorkflow").workflowId,
		).toBe("company-context-deletion-src_link");

		// The tombstone and status are left as the first delete wrote them.
		expect(mocks.sourceUpdateMany).not.toHaveBeenCalled();
	});

	it("a delete whose tombstone another delete wrote first starts that same deletion before answering success", async () => {
		storeSources([sourceRow({ id: "src_text" })]);
		mocks.sourceUpdateMany.mockResolvedValueOnce({ count: 0 });
		// Loaded before the other delete's write, re-read after it.
		mocks.getCompanyContextSourceMeta
			.mockResolvedValueOnce(sourceRow({ id: "src_text" }))
			.mockResolvedValueOnce(tombstoned({ id: "src_text" }));

		await expect(
			call(
				deleteCompanyContextSourceProcedure,
				{ organizationId: ORG, sourceId: "src_text" },
				"u_admin",
			),
		).resolves.toEqual({ success: true, sourceId: "src_text" });
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
		expect(
			expectCompanyStart(0, "contextDeletionWorkflow").workflowId,
		).toBe("company-context-deletion-src_text");
	});

	it("a delete that finds another delete's tombstone but cannot start the deletion answers an error, not success", async () => {
		storeSources([sourceRow({ id: "src_text" })]);
		mocks.sourceUpdateMany.mockResolvedValueOnce({ count: 0 });
		mocks.getCompanyContextSourceMeta
			.mockResolvedValueOnce(sourceRow({ id: "src_text" }))
			.mockResolvedValueOnce(tombstoned({ id: "src_text" }));
		mocks.workflowStart.mockRejectedValueOnce(new Error("temporal down"));

		expect(
			await rejection(
				call(
					deleteCompanyContextSourceProcedure,
					{ organizationId: ORG, sourceId: "src_text" },
					"u_admin",
				),
			),
		).toBe("INTERNAL_SERVER_ERROR");
		// Only the lost tombstone write; nothing clears the tombstone.
		expect(mocks.sourceUpdateMany).toHaveBeenCalledTimes(1);
	});

	it("is not re-processed: one source answers CONFLICT, and every stale source leaves it out", async () => {
		const staleModel = "openai:text-embedding-ada-002";
		storeSources([
			tombstoned({ id: "src_deleting", embeddingModel: staleModel }),
			sourceRow({ id: "src_old_text", embeddingModel: staleModel }),
		]);

		await expect(
			call(
				reprocessCompanyContextProcedure,
				{ organizationId: ORG, sourceId: "src_deleting" },
				"u_admin",
			),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringMatching(/being deleted/),
		});
		expect(
			mocks.claimCompanyContextSourceForReprocess,
		).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();

		const result = await call(
			reprocessCompanyContextProcedure,
			{ organizationId: ORG },
			"u_admin",
		);
		expect(result).toEqual({ reprocessed: ["src_old_text"], skipped: [] });
		expect(
			mocks.claimCompanyContextSourceForReprocess,
		).not.toHaveBeenCalledWith(
			expect.objectContaining({ id: "src_deleting" }),
		);
	});

	it("a stale source a delete tombstones before its claim is skipped as being deleted", async () => {
		const staleModel = "openai:text-embedding-ada-002";
		const racing = sourceRow({
			id: "src_old_file",
			type: "FILE",
			contentHash: null,
			embeddingModel: staleModel,
		});
		storeSources([
			sourceRow({ id: "src_old_text", embeddingModel: staleModel }),
			racing,
		]);
		// The delete lands between the list and the claim, which it refuses.
		mocks.claimCompanyContextSourceForReprocess.mockImplementation(
			async ({ id }: { id: string }) => {
				if (id !== "src_old_file") {
					return true;
				}
				Object.assign(racing, { deletingAt: DELETING_AT });
				return false;
			},
		);

		const result = await call(
			reprocessCompanyContextProcedure,
			{ organizationId: ORG },
			"u_admin",
		);

		expect(result).toEqual({
			reprocessed: ["src_old_text"],
			skipped: [
				{
					sourceId: "src_old_file",
					reason: expect.stringMatching(/being deleted/),
				},
			],
		});
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
	});

	it("is not re-synced or processed, and nothing is written", async () => {
		storeSources([
			tombstoned({
				id: "src_link",
				type: "LINK",
				sourceUrl: "https://example.com/docs",
			}),
			tombstoned({
				id: "src_file",
				type: "FILE",
				s3Path: `${ORG}/company-context/deck.pdf`,
				// A late status write, which processing alone would accept.
				extractionStatus: "PENDING",
			}),
		]);

		await expect(
			call(
				resyncCompanyContextUrlSourceProcedure,
				{ organizationId: ORG, sourceId: "src_link" },
				"u_admin",
			),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringMatching(/being deleted/),
		});
		await expect(
			call(
				processCompanyContextFileProcedure,
				{ organizationId: ORG, sourceId: "src_file" },
				"u_admin",
			),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringMatching(/being deleted/),
		});
		expect(mocks.updateCompanyContextSourceStatus).not.toHaveBeenCalled();
		expect(
			mocks.claimCompanyContextSourceForReprocess,
		).not.toHaveBeenCalled();
		expect(
			mocks.claimCompanyFileSourceForProcessing,
		).not.toHaveBeenCalled();
		expect(mocks.claimCompanyLinkSourceCrawl).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	describe("when the delete lands after the procedure read the source", () => {
		/**
		 * The status writes the procedures make, answered from `row` by their
		 * WHERE as the query layer answers them: the claims and the release
		 * refuse a tombstoned source, a plain status write spares it only
		 * COMPLETED.
		 */
		function writesLikeTheDatabase(row: Record<string, unknown>) {
			mocks.claimCompanyFileSourceForProcessing.mockImplementation(
				async () => {
					if (
						row.type !== "FILE" ||
						row.extractionStatus !== "PENDING" ||
						row.deletingAt !== null
					) {
						return false;
					}
					row.extractionStatus = "EXTRACTING";
					return true;
				},
			);
			mocks.claimCompanyContextSourceForReprocess.mockImplementation(
				async () => {
					if (
						row.extractionStatus === "PENDING" ||
						row.extractionStatus === "EXTRACTING" ||
						row.urlActiveWorkflowId !== null ||
						row.deletingAt !== null
					) {
						return false;
					}
					Object.assign(row, {
						extractionStatus: "PENDING",
						extractionError: null,
					});
					return true;
				},
			);
			mocks.releaseCompanyContextSourceClaim.mockImplementation(
				async ({
					status,
					extractionError,
				}: {
					status: string;
					extractionError?: string | null;
				}) => {
					if (row.deletingAt !== null) {
						return false;
					}
					row.extractionStatus = status;
					if (extractionError !== undefined) {
						row.extractionError = extractionError;
					}
					return true;
				},
			);
			mocks.updateCompanyContextSourceStatus.mockImplementation(
				async (
					_id: string,
					_org: string,
					status: string,
					data?: { extractionError?: string | null },
				) => {
					if (status === "COMPLETED" && row.deletingAt !== null) {
						return false;
					}
					row.extractionStatus = status;
					if (data?.extractionError !== undefined) {
						row.extractionError = data.extractionError;
					}
					return true;
				},
			);
		}

		/** What the delete writes when it tombstones a source. */
		function tombstone(row: Record<string, unknown>) {
			Object.assign(row, {
				deletingAt: DELETING_AT,
				extractionStatus: "FAILED",
				extractionError: DELETING_MESSAGE,
			});
		}

		/** The procedure's read sees `row` as it was; the delete lands right after. */
		function tombstoneAfterRead(row: Record<string, unknown>) {
			mocks.getCompanyContextSourceMeta.mockImplementationOnce(
				async () => {
					const { content: _content, ...meta } = row;
					tombstone(row);
					return meta;
				},
			);
		}

		function expectStillTombstoned(row: Record<string, unknown>) {
			expect(row).toMatchObject({
				deletingAt: DELETING_AT,
				extractionStatus: "FAILED",
				extractionError: DELETING_MESSAGE,
			});
		}

		it("processFile loses its claim to the tombstone: CONFLICT, nothing starts, the delete's status stays", async () => {
			const row = sourceRow({
				id: "src_file",
				type: "FILE",
				extractionStatus: "PENDING",
				s3Path: `${ORG}/company-context/deck.pdf`,
				embeddedAt: null,
				embeddingModel: null,
			});
			storeSources([row]);
			writesLikeTheDatabase(row);
			tombstoneAfterRead(row);

			await expect(
				call(
					processCompanyContextFileProcedure,
					{ organizationId: ORG, sourceId: "src_file" },
					"u_admin",
				),
			).rejects.toMatchObject({
				code: "CONFLICT",
				message: expect.stringMatching(/being deleted/),
			});

			expect(
				mocks.claimCompanyFileSourceForProcessing,
			).toHaveBeenCalledWith({ id: "src_file", organizationId: ORG });
			expect(mocks.workflowStart).not.toHaveBeenCalled();
			expectStillTombstoned(row);
		});

		it("processFile that loses its claim to another request answers CONFLICT and starts nothing", async () => {
			const row = sourceRow({
				id: "src_file",
				type: "FILE",
				extractionStatus: "PENDING",
				s3Path: `${ORG}/company-context/deck.pdf`,
			});
			storeSources([row]);
			writesLikeTheDatabase(row);
			mocks.getCompanyContextSourceMeta.mockImplementationOnce(
				async () => {
					const { content: _content, ...meta } = row;
					row.extractionStatus = "EXTRACTING";
					return meta;
				},
			);

			await expect(
				call(
					processCompanyContextFileProcedure,
					{ organizationId: ORG, sourceId: "src_file" },
					"u_admin",
				),
			).rejects.toMatchObject({
				code: "CONFLICT",
				message: expect.stringMatching(/EXTRACTING/),
			});
			expect(mocks.workflowStart).not.toHaveBeenCalled();
			expect(row.extractionStatus).toBe("EXTRACTING");
		});

		it("re-sync loses its claim to the tombstone: CONFLICT, no crawl, the delete's status stays", async () => {
			const row = sourceRow({
				id: "src_link",
				type: "LINK",
				sourceUrl: "https://example.com/docs",
				urlScope: "PATH_PREFIX",
				extractionStatus: "COMPLETED",
				urlActiveWorkflowId: null,
			});
			storeSources([row]);
			writesLikeTheDatabase(row);
			tombstoneAfterRead(row);

			await expect(
				call(
					resyncCompanyContextUrlSourceProcedure,
					{ organizationId: ORG, sourceId: "src_link" },
					"u_admin",
				),
			).rejects.toMatchObject({
				code: "CONFLICT",
				message: expect.stringMatching(/being deleted/),
			});

			expect(
				mocks.claimCompanyContextSourceForReprocess,
			).toHaveBeenCalledWith({ id: "src_link", organizationId: ORG });
			expect(mocks.workflowStart).not.toHaveBeenCalled();
			expect(mocks.claimCompanyLinkSourceCrawl).not.toHaveBeenCalled();
			expect(mocks.createUrlSourceSchedule).not.toHaveBeenCalled();
			expectStillTombstoned(row);
		});

		it("re-sync that loses its claim to a crawl answers CONFLICT as for a crawl in flight", async () => {
			const row = sourceRow({
				id: "src_link",
				type: "LINK",
				sourceUrl: "https://example.com/docs",
				urlScope: "PATH_PREFIX",
				extractionStatus: "COMPLETED",
				urlActiveWorkflowId: null,
			});
			storeSources([row]);
			writesLikeTheDatabase(row);
			// A scheduled refresh claims the slot after the read.
			mocks.getCompanyContextSourceMeta.mockImplementationOnce(
				async () => {
					const { content: _content, ...meta } = row;
					row.urlActiveWorkflowId = "url-crawl-src_link-scheduled";
					return meta;
				},
			);

			await expect(
				call(
					resyncCompanyContextUrlSourceProcedure,
					{ organizationId: ORG, sourceId: "src_link" },
					"u_admin",
				),
			).rejects.toMatchObject({
				code: "CONFLICT",
				message: expect.stringMatching(/already in progress/),
			});
			expect(mocks.workflowStart).not.toHaveBeenCalled();
			expect(row).toMatchObject({
				extractionStatus: "COMPLETED",
				urlActiveWorkflowId: "url-crawl-src_link-scheduled",
			});
		});

		it("a file whose processing cannot start keeps the delete's status when the delete landed meanwhile", async () => {
			const row = sourceRow({
				id: "src_file",
				type: "FILE",
				extractionStatus: "PENDING",
				s3Path: `${ORG}/company-context/deck.pdf`,
			});
			storeSources([row]);
			writesLikeTheDatabase(row);
			// The delete tombstones the claimed file; then the start fails.
			mocks.workflowStart.mockImplementationOnce(async () => {
				tombstone(row);
				throw new Error("temporal down");
			});

			expect(
				await rejection(
					call(
						processCompanyContextFileProcedure,
						{ organizationId: ORG, sourceId: "src_file" },
						"u_admin",
					),
				),
			).toBe("INTERNAL_SERVER_ERROR");

			expect(mocks.releaseCompanyContextSourceClaim).toHaveBeenCalledWith(
				{
					id: "src_file",
					organizationId: ORG,
					status: "PENDING",
				},
			);
			expectStillTombstoned(row);
		});

		it("a file whose processing cannot start goes back to PENDING when nothing deleted it", async () => {
			const row = sourceRow({
				id: "src_file",
				type: "FILE",
				extractionStatus: "PENDING",
				s3Path: `${ORG}/company-context/deck.pdf`,
			});
			storeSources([row]);
			writesLikeTheDatabase(row);
			mocks.workflowStart.mockRejectedValueOnce(
				new Error("temporal down"),
			);

			expect(
				await rejection(
					call(
						processCompanyContextFileProcedure,
						{ organizationId: ORG, sourceId: "src_file" },
						"u_admin",
					),
				),
			).toBe("INTERNAL_SERVER_ERROR");
			expect(row).toMatchObject({
				extractionStatus: "PENDING",
				deletingAt: null,
			});
		});

		it("a re-process that cannot start keeps the delete's status when the delete landed meanwhile", async () => {
			const row = sourceRow({
				id: "src_old_text",
				embeddingModel: "openai:text-embedding-ada-002",
			});
			storeSources([row]);
			writesLikeTheDatabase(row);
			// The delete tombstones the claimed (PENDING) text; then the start
			// fails.
			mocks.workflowStart.mockImplementationOnce(async () => {
				tombstone(row);
				throw new Error("temporal down");
			});

			expect(
				await rejection(
					call(
						reprocessCompanyContextProcedure,
						{ organizationId: ORG, sourceId: "src_old_text" },
						"u_admin",
					),
				),
			).toBe("INTERNAL_SERVER_ERROR");

			expect(mocks.releaseCompanyContextSourceClaim).toHaveBeenCalledWith(
				{
					id: "src_old_text",
					organizationId: ORG,
					status: "FAILED",
					extractionError: expect.stringMatching(/temporal down/),
				},
			);
			expectStillTombstoned(row);
		});
	});

	it("list and get show it as deleting, never ready or offered for re-processing, without the tombstone itself", async () => {
		storeSources([
			tombstoned({
				id: "src_deleting",
				embeddingModel: "openai:text-embedding-ada-002",
			}),
			sourceRow({ id: "src_live" }),
		]);

		const { sources } = await call(
			listCompanyContextSourcesProcedure,
			{ organizationId: ORG },
			"u_member",
		);
		const byId = new Map(
			sources.map((source: { id: string }) => [source.id, source]),
		);
		expect(byId.get("src_deleting")).toMatchObject({
			deleting: true,
			ready: false,
			needsReprocessing: false,
		});
		expect(byId.get("src_live")).toMatchObject({ deleting: false });
		for (const source of sources) {
			expect(source).not.toHaveProperty("deletingAt");
		}

		const { source } = await call(
			getCompanyContextSourceProcedure,
			{ organizationId: ORG, sourceId: "src_deleting" },
			"u_member",
		);
		expect(source).toMatchObject({
			deleting: true,
			needsReprocessing: false,
		});
		expect(source).not.toHaveProperty("deletingAt");
	});
});

describe("refresh schedules", () => {
	const SCHEDULE_WARNING = {
		code: "REFRESH_SCHEDULE_NOT_CREATED",
		message: expect.stringMatching(/Re-sync/),
	};

	/** Every write of a schedule id, in call order. */
	function scheduleIdWrites() {
		return mocks.updateCompanyLinkSourceCrawlState.mock.calls
			.map((call, index) => ({
				patch: call[2] as Record<string, unknown>,
				order: mocks.updateCompanyLinkSourceCrawlState.mock
					.invocationCallOrder[index],
			}))
			.filter(({ patch }) => "urlScheduleId" in patch);
	}

	const dailyWebsite = (overrides: Record<string, unknown> = {}) =>
		sourceRow({
			id: "src_link",
			type: "LINK",
			sourceUrl: "https://example.com/docs",
			urlScope: "SINGLE_PAGE",
			urlRefreshMode: "DAILY",
			extractionStatus: "COMPLETED",
			urlScheduleId: null,
			...overrides,
		});

	it("processLink records the schedule id before creating the schedule, so the reconciliation sweep never finds it unrecorded", async () => {
		const result = await call(
			processCompanyContextLinkProcedure,
			{
				organizationId: ORG,
				url: "https://example.com/docs",
				refreshMode: "WEEKLY",
			},
			"u_admin",
		);

		const { sourceId } = result.sources[0];
		expect(result.sources[0]).not.toHaveProperty("scheduleWarning");
		const writes = scheduleIdWrites();
		expect(writes.map(({ patch }) => patch)).toEqual([
			{ urlScheduleId: `url-source-schedule-${sourceId}` },
		]);
		expect(writes[0].order).toBeLessThan(
			mocks.createUrlSourceSchedule.mock.invocationCallOrder[0],
		);
		expect(mocks.createUrlSourceSchedule).toHaveBeenCalledWith(
			expect.objectContaining({
				contextId: sourceId,
				refreshMode: "WEEKLY",
				owner: COMPANY_OWNER,
			}),
			expect.anything(),
		);
	});

	it("processLink reports a schedule that cannot be created, clears its id, and keeps the crawl", async () => {
		mocks.createUrlSourceSchedule.mockRejectedValueOnce(
			new Error("schedule service unavailable"),
		);

		const result = await call(
			processCompanyContextLinkProcedure,
			{
				organizationId: ORG,
				url: "https://example.com/docs",
				refreshMode: "DAILY",
			},
			"u_admin",
		);

		const { sourceId } = result.sources[0];
		expect(result.sources).toEqual([
			{
				url: "https://example.com/docs",
				sourceId,
				status: "EXTRACTING",
				scheduleWarning: SCHEDULE_WARNING,
			},
		]);
		expect(scheduleIdWrites().map(({ patch }) => patch)).toEqual([
			{ urlScheduleId: `url-source-schedule-${sourceId}` },
			{ urlScheduleId: null },
		]);
		// The crawl is running and keeps its handle.
		expectCompanyStart(0, "urlSourceCrawlWorkflow");
		expect(mocks.releaseCompanyContextSourceClaim).not.toHaveBeenCalled();
	});

	it("processLink keeps a schedule that already exists under the source's id", async () => {
		mocks.createUrlSourceSchedule.mockRejectedValueOnce(
			new FakeScheduleAlreadyRunning(),
		);

		const result = await call(
			processCompanyContextLinkProcedure,
			{
				organizationId: ORG,
				url: "https://example.com/docs",
				refreshMode: "MONTHLY",
			},
			"u_admin",
		);

		expect(result.sources[0]).not.toHaveProperty("scheduleWarning");
		expect(scheduleIdWrites()).toHaveLength(1);
	});

	it("a bulk paste reports a schedule that cannot be created on its own URL", async () => {
		mocks.createUrlSourceSchedule
			.mockImplementationOnce(async (args: { contextId: string }) => ({
				scheduleId: `url-source-schedule-${args.contextId}`,
			}))
			.mockRejectedValueOnce(new Error("schedule service unavailable"));

		const result = await call(
			processCompanyContextLinkProcedure,
			{
				organizationId: ORG,
				urls: ["https://example.com/a", "https://example.com/b"],
				refreshMode: "DAILY",
			},
			"u_admin",
		);

		expect(result.sources[0]).not.toHaveProperty("scheduleWarning");
		expect(result.sources[1]).toMatchObject({
			url: "https://example.com/b",
			status: "EXTRACTING",
			scheduleWarning: SCHEDULE_WARNING,
		});
	});

	it("processLink with no scheduled cadence creates no schedule and records none", async () => {
		await call(
			processCompanyContextLinkProcedure,
			{ organizationId: ORG, url: "https://example.com/docs" },
			"u_admin",
		);

		expect(mocks.createUrlSourceSchedule).not.toHaveBeenCalled();
		expect(scheduleIdWrites()).toEqual([]);
	});

	it("re-sync creates the missing schedule of a scheduled website, recording its id first", async () => {
		storeSources([dailyWebsite()]);

		const result = await call(
			resyncCompanyContextUrlSourceProcedure,
			{ organizationId: ORG, sourceId: "src_link" },
			"u_admin",
		);

		expect(result).toEqual({ sourceId: "src_link", status: "EXTRACTING" });
		const writes = scheduleIdWrites();
		expect(writes.map(({ patch }) => patch)).toEqual([
			{ urlScheduleId: "url-source-schedule-src_link" },
		]);
		expect(writes[0].order).toBeLessThan(
			mocks.createUrlSourceSchedule.mock.invocationCallOrder[0],
		);
		expect(mocks.createUrlSourceSchedule).toHaveBeenCalledWith(
			expect.objectContaining({
				contextId: "src_link",
				refreshMode: "DAILY",
				organizationId: ORG,
				owner: COMPANY_OWNER,
				apiKey: "fc-test-key",
			}),
			expect.anything(),
		);
		// After the crawl start: the schedule never holds up the re-sync.
		expect(mocks.workflowStart.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.createUrlSourceSchedule.mock.invocationCallOrder[0],
		);
	});

	it("re-sync recreates a recorded schedule Temporal no longer knows", async () => {
		storeSources([
			dailyWebsite({ urlScheduleId: "url-source-schedule-src_link" }),
		]);
		mocks.scheduleDescribe.mockRejectedValueOnce(
			new FakeScheduleNotFoundError(),
		);

		await call(
			resyncCompanyContextUrlSourceProcedure,
			{ organizationId: ORG, sourceId: "src_link" },
			"u_admin",
		);

		expect(mocks.scheduleGetHandle).toHaveBeenCalledWith(
			"url-source-schedule-src_link",
		);
		expect(mocks.createUrlSourceSchedule).toHaveBeenCalledTimes(1);
	});

	it("re-sync leaves a schedule Temporal still knows alone", async () => {
		storeSources([
			dailyWebsite({ urlScheduleId: "url-source-schedule-src_link" }),
		]);

		const result = await call(
			resyncCompanyContextUrlSourceProcedure,
			{ organizationId: ORG, sourceId: "src_link" },
			"u_admin",
		);

		expect(result).not.toHaveProperty("scheduleWarning");
		expect(mocks.scheduleDescribe).toHaveBeenCalledTimes(1);
		expect(mocks.createUrlSourceSchedule).not.toHaveBeenCalled();
		expect(scheduleIdWrites()).toEqual([]);
	});

	it("re-sync reports a schedule that still cannot be created, beside the started crawl", async () => {
		storeSources([dailyWebsite()]);
		mocks.createUrlSourceSchedule.mockRejectedValueOnce(
			new Error("schedule service unavailable"),
		);

		const result = await call(
			resyncCompanyContextUrlSourceProcedure,
			{ organizationId: ORG, sourceId: "src_link" },
			"u_admin",
		);

		expect(result).toEqual({
			sourceId: "src_link",
			status: "EXTRACTING",
			scheduleWarning: SCHEDULE_WARNING,
		});
		expect(scheduleIdWrites().map(({ patch }) => patch)).toEqual([
			{ urlScheduleId: "url-source-schedule-src_link" },
			{ urlScheduleId: null },
		]);
		expectCompanyStart(0, "urlSourceCrawlWorkflow");
	});

	it("re-sync of a website without a scheduled cadence touches no schedule", async () => {
		storeSources([dailyWebsite({ urlRefreshMode: "ONCE" })]);

		await call(
			resyncCompanyContextUrlSourceProcedure,
			{ organizationId: ORG, sourceId: "src_link" },
			"u_admin",
		);

		expect(mocks.scheduleGetHandle).not.toHaveBeenCalled();
		expect(mocks.createUrlSourceSchedule).not.toHaveBeenCalled();
	});
});

describe("downloading", () => {
	it("presigns a file only from under the organization's prefix", async () => {
		storeSources([
			sourceRow({
				id: "src_file",
				type: "FILE",
				s3Path: `${ORG}/company-context/deck.pdf`,
				s3Bucket: "contexts-bucket",
				originalFilename: "deck.pdf",
				mimeType: "application/pdf",
			}),
			sourceRow({
				id: "src_stray",
				type: "FILE",
				s3Path: `${OTHER_ORG}/company-context/deck.pdf`,
				s3Bucket: "contexts-bucket",
			}),
		]);

		const result = await call(
			createCompanyContextDownloadUrlProcedure,
			{ organizationId: ORG, sourceId: "src_file" },
			"u_member",
		);
		expect(result).toMatchObject({
			url: "https://storage.example.com/get",
			filename: "deck.pdf",
			contextClass: "A",
		});
		expect(mocks.getSignedUrl).toHaveBeenCalledWith(
			`${ORG}/company-context/deck.pdf`,
			expect.objectContaining({ bucket: "contexts-bucket" }),
		);

		expect(
			await rejection(
				call(
					createCompanyContextDownloadUrlProcedure,
					{ organizationId: ORG, sourceId: "src_stray" },
					"u_member",
				),
			),
		).toBe("BAD_REQUEST");
	});

	it("exports a website's crawled pages as one Markdown file under the organization's prefix", async () => {
		storeSources([
			sourceRow({
				id: "src_link",
				type: "LINK",
				content: "",
				sourceTitle: "Docs",
			}),
		]);
		mocks.urlPageFindMany.mockResolvedValue([
			{
				pageUrl: "https://example.com/docs/a",
				pageTitle: "Alpha",
				content: "Alpha body",
			},
		]);

		const result = await call(
			createCompanyContextDownloadUrlProcedure,
			{ organizationId: ORG, sourceId: "src_link" },
			"u_member",
		);

		expect(mocks.urlPageFindMany.mock.calls[0]?.[0].where).toEqual({
			parentSourceId: "src_link",
			organizationId: ORG,
		});
		const [key, body] = mocks.uploadFile.mock.calls[0] ?? [];
		expect(key).toMatch(new RegExp(`^${ORG}/company-context/downloads/`));
		expect(String(body)).toContain("## Alpha\nhttps://example.com/docs/a");
		expect(result.contextClass).toBe("B");
	});
});

describe("re-processing after an embedding model change", () => {
	beforeEach(() => {
		storeSources([
			sourceRow({ id: "src_ready" }),
			sourceRow({
				id: "src_old_text",
				embeddingModel: "openai:text-embedding-ada-002",
			}),
			sourceRow({
				id: "src_old_file",
				type: "FILE",
				contentHash: null,
				embeddingModel: "openai:text-embedding-ada-002",
			}),
			sourceRow({
				id: "src_old_link",
				type: "LINK",
				sourceUrl: "https://example.com/docs",
				embeddingModel: "openai:text-embedding-ada-002",
			}),
		]);
		mocks.listReadyCompanyContextSourceIds.mockResolvedValue(["src_ready"]);
	});

	it("an admin re-embeds every stale source with the current model, leaving ready ones alone", async () => {
		const result = await call(
			reprocessCompanyContextProcedure,
			{ organizationId: ORG },
			"u_admin",
		);

		expect(result).toEqual({
			reprocessed: ["src_old_text", "src_old_file", "src_old_link"],
			skipped: [],
		});
		expect(mocks.workflowStart).toHaveBeenCalledTimes(3);
		// A text re-embeds its stored body.
		expect(
			expectCompanyStart(0, "contextEmbeddingWorkflow").args[0],
		).toMatchObject({ contextId: "src_old_text" });
		// A file with nothing extracted is extracted again.
		expect(
			expectCompanyStart(1, "projectContextProcessingWorkflow").args[0],
		).toMatchObject({ contextId: "src_old_file", isRetry: true });
		// A website is crawled again: `manual-resync` re-embeds every page,
		// unchanged ones included, and the workflow takes no other flag.
		const recrawl = expectCompanyStart(2, "urlSourceCrawlWorkflow");
		expect(recrawl.args[0]).toMatchObject({
			contextId: "src_old_link",
			mode: "manual-resync",
		});
		expect(recrawl.args[0]).not.toHaveProperty("forceReembed");
		expect(recrawl.workflowId).toMatch(
			/^url-crawl-src_old_link-resync-\d+$/,
		);
		expect(mocks.updateCompanyContextSourceStatus).not.toHaveBeenCalledWith(
			"src_ready",
			expect.anything(),
			expect.anything(),
			expect.anything(),
		);
	});

	it("a member gets FORBIDDEN and nothing is started", async () => {
		expect(
			await rejection(
				call(
					reprocessCompanyContextProcedure,
					{ organizationId: ORG },
					"u_member",
				),
			),
		).toBe("FORBIDDEN");
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("is refused up front without an embedding provider, or with a model that cannot be stored", async () => {
		mocks.resolveCompanyEmbeddingModel.mockRejectedValueOnce(
			new FakeAIProviderNotConfiguredError(),
		);
		expect(
			await rejection(
				call(
					reprocessCompanyContextProcedure,
					{ organizationId: ORG },
					"u_admin",
				),
			),
		).toBe("BAD_REQUEST");

		mocks.resolveCompanyEmbeddingModel.mockResolvedValueOnce({
			identity: "acme:large",
			dimensions: 3072,
			supported: false,
		});
		expect(
			await rejection(
				call(
					reprocessCompanyContextProcedure,
					{ organizationId: ORG },
					"u_admin",
				),
			),
		).toBe("BAD_REQUEST");
		expect(mocks.workflowStart).not.toHaveBeenCalled();
		expect(mocks.updateCompanyContextSourceStatus).not.toHaveBeenCalled();
	});

	it("one source at a time, but not while it is still processing", async () => {
		await call(
			reprocessCompanyContextProcedure,
			{ organizationId: ORG, sourceId: "src_old_text" },
			"u_owner",
		);
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);

		storeSources([
			sourceRow({ id: "src_busy", extractionStatus: "EXTRACTING" }),
		]);
		expect(
			await rejection(
				call(
					reprocessCompanyContextProcedure,
					{ organizationId: ORG, sourceId: "src_busy" },
					"u_owner",
				),
			),
		).toBe("CONFLICT");
	});

	it("re-processing every stale source leaves a website being refreshed, or merely not ready, alone", async () => {
		storeSources([
			// Embedded with the earlier model, but a scheduled refresh is
			// crawling it: a second crawl would race that one.
			sourceRow({
				id: "src_refreshing",
				type: "LINK",
				sourceUrl: "https://example.com/docs",
				embeddingModel: "openai:text-embedding-ada-002",
				urlActiveWorkflowId:
					"url-crawl-src_refreshing-2026-09-30T00:00:00Z",
			}),
			// Not ready — a page still to settle — but on the current model.
			sourceRow({
				id: "src_settling",
				type: "LINK",
				sourceUrl: "https://example.com/blog",
			}),
			sourceRow({
				id: "src_old_text",
				embeddingModel: "openai:text-embedding-ada-002",
			}),
		]);
		mocks.listReadyCompanyContextSourceIds.mockResolvedValue([]);

		const result = await call(
			reprocessCompanyContextProcedure,
			{ organizationId: ORG },
			"u_admin",
		);

		expect(result).toEqual({ reprocessed: ["src_old_text"], skipped: [] });
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
	});

	it("a website that cannot be crawled is skipped, and the rest go ahead", async () => {
		mocks.getEnabledOrganizationSearchProviders.mockResolvedValue([]);

		const result = await call(
			reprocessCompanyContextProcedure,
			{ organizationId: ORG },
			"u_admin",
		);

		expect(result.reprocessed).toEqual(["src_old_text", "src_old_file"]);
		expect(result.skipped).toEqual([
			{
				sourceId: "src_old_link",
				reason: expect.stringMatching(/scraping/),
			},
		]);
	});

	/**
	 * Both requests read the source idle, so the in-flight check lets both
	 * through; the claim is what decides. Two runs on one source would each
	 * delete its points before writing, and the loser's delete could erase
	 * the winner's index.
	 */
	it.each([
		["a text", "src_old_text", "contextEmbeddingWorkflow"],
		["a website", "src_old_link", "urlSourceCrawlWorkflow"],
	])(
		"of two requests racing to re-process %s, exactly one starts a run and the other answers CONFLICT",
		async (_kind, sourceId, workflowType) => {
			const claimed = new Set<string>();
			mocks.claimCompanyContextSourceForReprocess.mockImplementation(
				async ({ id }: { id: string }) => {
					if (claimed.has(id)) {
						return false;
					}
					claimed.add(id);
					return true;
				},
			);
			const reprocess = () =>
				call(
					reprocessCompanyContextProcedure,
					{ organizationId: ORG, sourceId },
					"u_admin",
				);

			const results = await Promise.allSettled([
				reprocess(),
				reprocess(),
			]);

			expect(results.map((result) => result.status).sort()).toEqual([
				"fulfilled",
				"rejected",
			]);
			const lost = results.find(
				(result): result is PromiseRejectedResult =>
					result.status === "rejected",
			);
			expect(lost?.reason).toMatchObject({ code: "CONFLICT" });
			expect(
				mocks.claimCompanyContextSourceForReprocess,
			).toHaveBeenCalledTimes(2);
			expect(
				mocks.claimCompanyContextSourceForReprocess,
			).toHaveBeenCalledWith({ id: sourceId, organizationId: ORG });
			expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
			expectCompanyStart(0, workflowType);
			// The claim set the source PENDING; nothing else did.
			expect(
				mocks.updateCompanyContextSourceStatus,
			).not.toHaveBeenCalled();
		},
	);

	it("re-processing every stale source skips one another request claimed first, and goes on with the rest", async () => {
		mocks.claimCompanyContextSourceForReprocess.mockImplementation(
			async ({ id }: { id: string }) => id !== "src_old_file",
		);

		const result = await call(
			reprocessCompanyContextProcedure,
			{ organizationId: ORG },
			"u_admin",
		);

		expect(result).toEqual({
			reprocessed: ["src_old_text", "src_old_link"],
			skipped: [
				{
					sourceId: "src_old_file",
					reason: expect.stringMatching(/already being processed/),
				},
			],
		});
		expect(mocks.workflowStart).toHaveBeenCalledTimes(2);
		expect(
			mocks.workflowStart.mock.calls.map(
				([, options]) => options.args[0].contextId,
			),
		).toEqual(["src_old_text", "src_old_link"]);
	});

	it("a claimed source whose run cannot start is marked FAILED, not left PENDING", async () => {
		mocks.workflowStart.mockRejectedValueOnce(new Error("temporal down"));

		expect(
			await rejection(
				call(
					reprocessCompanyContextProcedure,
					{ organizationId: ORG, sourceId: "src_old_text" },
					"u_admin",
				),
			),
		).toBe("INTERNAL_SERVER_ERROR");

		expect(
			mocks.claimCompanyContextSourceForReprocess,
		).toHaveBeenCalledWith({ id: "src_old_text", organizationId: ORG });
		expect(mocks.releaseCompanyContextSourceClaim).toHaveBeenCalledWith({
			id: "src_old_text",
			organizationId: ORG,
			status: "FAILED",
			extractionError: expect.stringMatching(/temporal down/),
		});
	});
});
