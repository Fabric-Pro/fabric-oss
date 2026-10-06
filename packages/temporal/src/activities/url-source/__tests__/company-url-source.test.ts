/**
 * Company website sources through the URL-source crawl (Fizzy #2719).
 *
 * The REAL `urlSourceCrawlWorkflow`, bundled on its own, drives the REAL
 * URL-source activities (and the shared embed activity for a single page) in
 * the Temporal test environment. Only what sits underneath is faked: the
 * company tables live in memory with the query layer's semantics, the vector
 * store records which rows hold points with which model, and the crawler is a
 * scripted site. Readiness is judged by the query layer's own predicate,
 * `companyContextReadyWhere`, evaluated against those in-memory rows.
 *
 * A company owner on the input must:
 *  - check the gate first, before any map or scrape, and stop there when
 *    COMPANY_CONTEXT is off, the source is gone, or the embedding model
 *    cannot index it;
 *  - write crawled pages to the company table under the parent's
 *    organization, embed them into the company collection, prune orphans with
 *    their points, and finalize the company row without a notification;
 *  - re-embed unchanged pages after an embedding-model switch, the parent
 *    staying not-ready until every page carries the new model;
 *  - run one crawl of a source at a time: every crawl, scheduled ones
 *    included, claims the source's crawl slot at the gate, a crawl that finds
 *    it held by a running crawl exits without a crawler call or a write, and
 *    a finalize never touches a source another crawl holds;
 *  - keep a ready website ready through a scheduled refresh — while it runs,
 *    and after it fails — and after a cancel that indexed some pages, with no
 *    page left PENDING without vectors;
 *  - leave a source whose delete has started alone: no crawl claims it, and
 *    an embed that finishes late removes its points and never makes it ready.
 * And a schedule's arguments without an owner must still run a project crawl
 * with exactly the project inputs.
 *
 * Offline note: `TestWorkflowEnvironment.createTimeSkipping()` downloads a
 * Temporal test-server binary on first use.
 *
 * Run with:
 *   pnpm --filter @repo/temporal exec vitest run src/activities/url-source/__tests__/company-url-source.test.ts
 */

import { resolve } from "node:path";
import { type ScheduleClient, WorkflowFailedError } from "@temporalio/client";
import {
	ApplicationFailure,
	defaultPayloadConverter,
} from "@temporalio/common";
import {
	MockActivityEnvironment,
	TestWorkflowEnvironment,
} from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { PROJECT_OPERATIONS_ACTIVITY_TASK_QUEUE } from "../../../task-queues";

const ORG = "org-1";
const OTHER_ORG = "org-2";
const USER = "user-1";
const SOURCE = "src-1";
const SITE = "https://example.com/docs";
const PAGE_A = `${SITE}/a`;
const PAGE_B = `${SITE}/b`;
const PAGE_C = `${SITE}/c`;
const MODEL_A = "OPENAI_DIRECT:text-embedding-3-small";
const MODEL_B = "OPENAI_COMPATIBLE:embed-1536";
const OWNER = { kind: "company", organizationId: ORG } as const;

const h = vi.hoisted(() => {
	type Status =
		| "PENDING"
		| "EXTRACTING"
		| "COMPLETED"
		| "FAILED"
		| "CANCELLED";
	interface SourceRow {
		id: string;
		organizationId: string;
		type: string;
		content: string;
		contentHash: string | null;
		metadata: unknown;
		s3Path: string | null;
		s3Bucket: string | null;
		originalFilename: string | null;
		mimeType: string | null;
		sourceUrl: string | null;
		sourceTitle: string | null;
		extractionStatus: Status;
		extractionError: string | null;
		qdrantId: string | null;
		embeddedAt: Date | null;
		embeddingModel: string | null;
		urlActiveWorkflowId: string | null;
		urlRefreshMode: string | null;
		urlLastSyncedAt: Date | null;
		urlNextRefreshAt: Date | null;
		deletingAt: Date | null;
	}
	interface PageRow {
		id: string;
		parentSourceId: string;
		organizationId: string;
		pageUrl: string;
		pageTitle: string | null;
		content: string;
		contentHash: string;
		extractionStatus: Status;
		extractionError: string | null;
		embeddedAt: Date | null;
		embeddingModel: string | null;
		qdrantId: string | null;
		chunkCount: number;
	}
	interface Point {
		organizationId: string;
		sourceId: string;
		parentContextId: string | null;
		embeddingModel: string;
	}

	const sources = new Map<string, SourceRow>();
	const pages = new Map<string, PageRow>();
	/** contextId → the points written from that row. */
	const points = new Map<string, Point>();
	const state = {
		flagOn: true,
		model: {
			identity: "OPENAI_DIRECT:text-embedding-3-small",
			dimensions: 1536,
			supported: true,
		} as { identity: string; dimensions: number; supported: boolean },
		modelError: null as Error | null,
		pageSeq: 0,
		/** Page URLs whose upsert fails on every attempt. */
		failUpsert: new Set<string>(),
	};
	/** The Temporal client the gate asks whether a slot's crawl still runs. */
	const temporal = { client: null as unknown };

	class AIProviderNotConfiguredError extends Error {}

	const hash = (content: string) => `hash:${content}`;
	const sourceOf = (id: string, organizationId: string) => {
		const row = sources.get(id);
		return row && row.organizationId === organizationId ? row : undefined;
	};
	const pageOf = (id: string, organizationId: string) => {
		const row = pages.get(id);
		return row && row.organizationId === organizationId ? row : undefined;
	};
	const pagesUnder = (sourceId: string, organizationId: string) =>
		[...pages.values()].filter(
			(page) =>
				page.parentSourceId === sourceId &&
				page.organizationId === organizationId,
		);

	/**
	 * The query layer's company functions, with its semantics, in memory. A
	 * source whose delete has started (`deletingAt` set) takes no crawl claim
	 * or finalize, no embedded mark and no COMPLETED status, as there.
	 */
	const queries = {
		getCompanyContextSource: vi.fn(async (id: string, org: string) => {
			const row = sourceOf(id, org);
			return row ? { ...row } : null;
		}),
		updateCompanyContextSourceStatus: vi.fn(
			async (
				id: string,
				org: string,
				status: Status,
				data?: { content?: string; extractionError?: string | null },
			) => {
				const row = sourceOf(id, org);
				if (
					!row ||
					(status === "COMPLETED" && row.deletingAt !== null)
				) {
					return false;
				}
				row.extractionStatus = status;
				if (data?.content !== undefined) {
					row.content = data.content;
					row.contentHash = hash(data.content);
				}
				if (data?.extractionError !== undefined) {
					row.extractionError = data.extractionError;
				}
				return true;
			},
		),
		updateCompanyLinkSourceCrawlState: vi.fn(
			async (id: string, org: string, patch: Partial<SourceRow>) => {
				const row = sourceOf(id, org);
				if (!row || row.type !== "LINK") {
					return false;
				}
				Object.assign(row, patch);
				return true;
			},
		),
		getCompanyLinkSourceCrawlState: vi.fn(
			async (id: string, org: string) => {
				const row = sourceOf(id, org);
				return row && row.type === "LINK"
					? {
							extractionStatus: row.extractionStatus,
							embeddedAt: row.embeddedAt,
							urlRefreshMode: row.urlRefreshMode,
							urlActiveWorkflowId: row.urlActiveWorkflowId,
						}
					: null;
			},
		),
		claimCompanyLinkSourceCrawl: vi.fn(
			async (input: {
				id: string;
				organizationId: string;
				workflowId: string;
				replacing?: string;
			}) => {
				const row = sourceOf(input.id, input.organizationId);
				const slot = row?.urlActiveWorkflowId ?? null;
				if (
					!row ||
					row.type !== "LINK" ||
					row.deletingAt !== null ||
					(slot !== null &&
						slot !== input.workflowId &&
						slot !== input.replacing)
				) {
					return false;
				}
				row.urlActiveWorkflowId = input.workflowId;
				return true;
			},
		),
		finalizeCompanyLinkSourceCrawl: vi.fn(
			async (input: {
				id: string;
				organizationId: string;
				workflowId: string;
				outcome: {
					status?: Status;
					extractionError?: string | null;
					content?: string;
					urlLastSyncedAt?: Date | null;
					urlNextRefreshAt?: Date | null;
					embeddingModel?: string;
				};
			}) => {
				const row = sourceOf(input.id, input.organizationId);
				if (
					!row ||
					row.type !== "LINK" ||
					row.deletingAt !== null ||
					(row.urlActiveWorkflowId !== null &&
						row.urlActiveWorkflowId !== input.workflowId)
				) {
					return false;
				}
				const { outcome } = input;
				row.urlActiveWorkflowId = null;
				if (outcome.status !== undefined) {
					row.extractionStatus = outcome.status;
				}
				if (outcome.extractionError !== undefined) {
					row.extractionError = outcome.extractionError;
				}
				if (outcome.content !== undefined) {
					row.content = outcome.content;
					row.contentHash = hash(outcome.content);
				}
				if (outcome.urlLastSyncedAt !== undefined) {
					row.urlLastSyncedAt = outcome.urlLastSyncedAt;
				}
				if (outcome.urlNextRefreshAt !== undefined) {
					row.urlNextRefreshAt = outcome.urlNextRefreshAt;
				}
				if (outcome.embeddingModel) {
					row.embeddedAt = new Date();
					row.embeddingModel = outcome.embeddingModel;
				}
				return true;
			},
		),
		cancelUnfinishedCompanyContextUrlPages: vi.fn(
			async (sourceId: string, org: string) => {
				let count = 0;
				for (const page of pagesUnder(sourceId, org)) {
					if (
						page.extractionStatus === "PENDING" &&
						page.embeddedAt === null
					) {
						page.extractionStatus = "CANCELLED";
						count++;
					}
				}
				return count;
			},
		),
		markCompanyContextSourceEmbedded: vi.fn(
			async (
				id: string,
				org: string,
				embedding: { embeddingModel: string; qdrantId?: string | null },
			) => {
				const row = sourceOf(id, org);
				if (!row || row.deletingAt !== null) {
					return false;
				}
				row.embeddedAt = new Date();
				row.embeddingModel = embedding.embeddingModel;
				if (embedding.qdrantId !== undefined) {
					row.qdrantId = embedding.qdrantId;
				}
				return true;
			},
		),
		// The query layer's rule: a COMPLETED source keeps its status, any
		// other is FAILED; the points-removed option clears the markers.
		recordCompanyContextSourceIndexingFailure: vi.fn(
			async (
				id: string,
				org: string,
				message: string,
				options?: { pointsRemoved?: boolean },
			) => {
				const row = sourceOf(id, org);
				if (!row) {
					return false;
				}
				if (row.extractionStatus !== "COMPLETED") {
					row.extractionStatus = "FAILED";
				}
				row.extractionError = message;
				if (options?.pointsRemoved) {
					row.embeddedAt = null;
					row.embeddingModel = null;
				}
				return true;
			},
		),
		clearCompanyContextSourceEmbedding: vi.fn(
			async (id: string, org: string) => {
				const row = sourceOf(id, org);
				if (!row) {
					return false;
				}
				row.embeddedAt = null;
				row.embeddingModel = null;
				row.qdrantId = null;
				return true;
			},
		),
		countCompanyContextUrlPagesEmbeddedWith: vi.fn(
			async (input: {
				parentSourceId: string;
				organizationId: string;
				embeddingModel: string;
			}) =>
				pagesUnder(input.parentSourceId, input.organizationId).filter(
					(page) =>
						page.embeddedAt !== null &&
						page.embeddingModel === input.embeddingModel,
				).length,
		),
		deleteCompanyContextSource: vi.fn(async () => null),
		createCompanyContextUrlPages: vi.fn(
			async (input: {
				parentSourceId: string;
				organizationId: string;
				pageUrls: readonly string[];
			}) => {
				const present = new Set(
					pagesUnder(input.parentSourceId, input.organizationId).map(
						(page) => page.pageUrl,
					),
				);
				let createdCount = 0;
				for (const pageUrl of new Set(input.pageUrls)) {
					if (present.has(pageUrl)) {
						continue;
					}
					const id = `page-${++state.pageSeq}`;
					pages.set(id, {
						id,
						parentSourceId: input.parentSourceId,
						organizationId: input.organizationId,
						pageUrl,
						pageTitle: null,
						content: "",
						contentHash: "",
						extractionStatus: "PENDING",
						extractionError: null,
						embeddedAt: null,
						embeddingModel: null,
						qdrantId: null,
						chunkCount: 0,
					});
					createdCount++;
				}
				return { createdCount, existingCount: present.size };
			},
		),
		upsertCompanyContextUrlPage: vi.fn(
			async (input: {
				parentSourceId: string;
				organizationId: string;
				pageUrl: string;
				pageTitle?: string | null;
				content: string;
				force?: boolean;
			}) => {
				if (state.failUpsert.has(input.pageUrl)) {
					throw new Error("database unavailable");
				}
				const contentHash = hash(input.content);
				let page = pagesUnder(
					input.parentSourceId,
					input.organizationId,
				).find((row) => row.pageUrl === input.pageUrl);
				if (!page) {
					const id = `page-${++state.pageSeq}`;
					page = {
						id,
						parentSourceId: input.parentSourceId,
						organizationId: input.organizationId,
						pageUrl: input.pageUrl,
						pageTitle: null,
						content: "",
						contentHash: "",
						extractionStatus: "PENDING",
						extractionError: null,
						embeddedAt: null,
						embeddingModel: null,
						qdrantId: null,
						chunkCount: 0,
					};
					pages.set(id, page);
				}
				const unchanged =
					page.contentHash === contentHash && !input.force;
				page.pageTitle = input.pageTitle ?? null;
				if (!unchanged) {
					page.content = input.content;
					page.contentHash = contentHash;
					page.extractionStatus = "PENDING";
					page.extractionError = null;
				}
				return { pageId: page.id, contentHash, unchanged };
			},
		),
		markCompanyContextUrlPageEmbedded: vi.fn(
			async (
				pageId: string,
				org: string,
				embedding: {
					embeddingModel: string;
					qdrantId?: string | null;
					chunkCount: number;
				},
			) => {
				const page = pageOf(pageId, org);
				if (!page) {
					return false;
				}
				page.embeddedAt = new Date();
				page.embeddingModel = embedding.embeddingModel;
				page.qdrantId = embedding.qdrantId ?? null;
				page.chunkCount = embedding.chunkCount;
				page.extractionStatus = "COMPLETED";
				page.extractionError = null;
				return true;
			},
		),
		listCompanyContextUrlPages: vi.fn(
			async (sourceId: string, org: string) =>
				pagesUnder(sourceId, org).map(
					({ content: _content, ...page }) => page,
				),
		),
		pruneCompanyContextUrlPages: vi.fn(
			async (input: {
				parentSourceId: string;
				organizationId: string;
				keptUrls: readonly string[];
			}) => {
				if (input.keptUrls.length === 0) {
					return { deletedPageIds: [] };
				}
				const kept = new Set(input.keptUrls);
				const deletedPageIds = pagesUnder(
					input.parentSourceId,
					input.organizationId,
				)
					.filter((page) => !kept.has(page.pageUrl))
					.map((page) => page.id);
				for (const id of deletedPageIds) {
					pages.delete(id);
				}
				return { deletedPageIds };
			},
		),
		isFeatureEnabled: vi.fn(async () => state.flagOn),
	};

	/** The Prisma calls the company crawl store makes directly. */
	const companyDb = {
		companyContextUrlPage: {
			findFirst: vi.fn(
				async (args: {
					where: { id: string; organizationId: string };
				}) => {
					const page = pageOf(
						args.where.id,
						args.where.organizationId,
					);
					return page
						? {
								extractionStatus: page.extractionStatus,
								embeddedAt: page.embeddedAt,
								embeddingModel: page.embeddingModel,
							}
						: null;
				},
			),
			updateMany: vi.fn(
				async (args: {
					where: { id: string; organizationId: string };
					data: Partial<PageRow>;
				}) => {
					const page = pageOf(
						args.where.id,
						args.where.organizationId,
					);
					if (!page) {
						return { count: 0 };
					}
					Object.assign(page, args.data);
					return { count: 1 };
				},
			),
		},
		companyContextSource: {
			updateMany: vi.fn(
				async (args: {
					where: {
						id: string;
						organizationId: string;
						type: string;
						extractionStatus: { in: Status[] };
						OR: Array<{ urlActiveWorkflowId: string | null }>;
					};
					data: Partial<SourceRow>;
				}) => {
					const { where } = args;
					const row = sourceOf(where.id, where.organizationId);
					const matches =
						row &&
						row.type === where.type &&
						where.extractionStatus.in.includes(
							row.extractionStatus,
						) &&
						where.OR.some(
							(arm) =>
								arm.urlActiveWorkflowId ===
								row.urlActiveWorkflowId,
						);
					if (!row || !matches) {
						return { count: 0 };
					}
					Object.assign(row, args.data);
					return { count: 1 };
				},
			),
		},
	};

	/** Project tables and project-path calls: a company run reaches none. */
	const projectOnly = {
		projectContextFindFirst: vi.fn(),
		projectContextFindUnique: vi.fn(),
		projectContextUpdate: vi.fn(),
		urlPageFindFirst: vi.fn(),
		urlPageFindMany: vi.fn(),
		urlPageCreate: vi.fn(),
		urlPageCreateMany: vi.fn(),
		urlPageUpdate: vi.fn(),
		urlPageDeleteMany: vi.fn(),
		updateContextExtractionStatus: vi.fn(),
		markContextAsEmbedded: vi.fn(),
		recordContextIndexingFailure: vi.fn(),
		embedProjectContext: vi.fn(),
		deleteProjectContext: vi.fn(),
		emitCompletionNotification: vi.fn(),
	};

	const rag = {
		resolveCompanyEmbeddingModel: vi.fn(async () => {
			if (state.modelError) {
				throw state.modelError;
			}
			return { ...state.model };
		}),
		// Embeds with the organization's current model, as the real call
		// resolves it, and reports that model back.
		embedCompanyContext: vi.fn(
			async (options: {
				contextId: string;
				company: {
					organizationId: string;
					sourceId: string;
					parentContextId?: string | null;
				};
			}): Promise<{
				success: boolean;
				qdrantId?: string;
				error?: string;
				chunksCreated: number;
				embeddingModel?: string;
			}> => {
				const embeddingModel = state.model.identity;
				points.set(options.contextId, {
					organizationId: options.company.organizationId,
					sourceId: options.company.sourceId,
					parentContextId: options.company.parentContextId ?? null,
					embeddingModel,
				});
				return {
					success: true,
					qdrantId: `point:${options.contextId}`,
					chunksCreated: 2,
					embeddingModel,
				};
			},
		),
		deleteCompanyContextRowPoints: vi.fn(
			async (params: {
				organizationId: string;
				contextIds: readonly string[];
			}) => {
				for (const id of params.contextIds) {
					if (
						points.get(id)?.organizationId === params.organizationId
					) {
						points.delete(id);
					}
				}
				return { collectionExists: true };
			},
		),
		// The store's filter: the organization's points whose parent is the
		// source and whose row is none of the live pages.
		deleteCompanyPagePointsNotIn: vi.fn(
			async (params: {
				organizationId: string;
				sourceId: string;
				livePageIds: readonly string[];
			}) => {
				const live = new Set(params.livePageIds);
				for (const [contextId, point] of points) {
					if (
						point.organizationId === params.organizationId &&
						point.parentContextId === params.sourceId &&
						!live.has(contextId)
					) {
						points.delete(contextId);
					}
				}
				return { collectionExists: true };
			},
		),
	};

	const firecrawl = {
		map: vi.fn(),
		scrape: vi.fn(),
	};

	function reset(): void {
		sources.clear();
		pages.clear();
		points.clear();
		state.flagOn = true;
		state.model = {
			identity: "OPENAI_DIRECT:text-embedding-3-small",
			dimensions: 1536,
			supported: true,
		};
		state.modelError = null;
		state.pageSeq = 0;
		state.failUpsert.clear();
	}

	return {
		sources,
		pages,
		points,
		state,
		temporal,
		queries,
		companyDb,
		projectOnly,
		rag,
		firecrawl,
		reset,
		AIProviderNotConfiguredError,
	};
});

vi.mock("@repo/database", () => ({
	...h.queries,
	db: {
		...h.companyDb,
		projectContext: {
			findFirst: h.projectOnly.projectContextFindFirst,
			findUnique: h.projectOnly.projectContextFindUnique,
			update: h.projectOnly.projectContextUpdate,
		},
	},
	updateContextExtractionStatus: h.projectOnly.updateContextExtractionStatus,
	markContextAsEmbedded: h.projectOnly.markContextAsEmbedded,
	recordContextIndexingFailure: h.projectOnly.recordContextIndexingFailure,
}));

vi.mock("@repo/database/prisma/client", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	db: {
		projectContext: { update: h.projectOnly.projectContextUpdate },
		projectContextUrlPage: {
			findFirst: h.projectOnly.urlPageFindFirst,
			findMany: h.projectOnly.urlPageFindMany,
			create: h.projectOnly.urlPageCreate,
			createMany: h.projectOnly.urlPageCreateMany,
			update: h.projectOnly.urlPageUpdate,
			deleteMany: h.projectOnly.urlPageDeleteMany,
		},
	},
}));

vi.mock("@repo/ai", () => ({
	AIProviderNotConfiguredError: h.AIProviderNotConfiguredError,
	getSystemRAGProviderConfig: vi.fn(async () => ({
		apiKey: "test-key",
		provider: "OPENAI_DIRECT",
		baseUrl: null,
	})),
}));

vi.mock("@repo/rag", () => ({
	...h.rag,
	unsupportedEmbeddingModelMessage: (model: { identity: string }) =>
		`Unsupported embedding model: ${model.identity}`,
	embedProjectContext: h.projectOnly.embedProjectContext,
	deleteProjectContext: h.projectOnly.deleteProjectContext,
}));

vi.mock("../../../client", () => ({
	getTemporalClient: async () => h.temporal.client,
}));

vi.mock("../lib/emit-completion-notification", () => ({
	emitCompletionNotification: h.projectOnly.emitCompletionNotification,
}));

vi.mock("../../lib/activity-logger", () => ({
	activityLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
	CONTEXT_OWNER_INVALID,
	type ContextOwner,
	contextOwnerTaskQueue,
} from "../../../lib/context-owner";
import { createUrlSourceSchedule } from "../../../schedules/url-source-schedule";
import {
	COMPANY_CONTEXT_TASK_QUEUE,
	PROJECT_EMBEDDING_TASK_QUEUE,
} from "../../../task-queues";
import { embedSingleContextActivity } from "../../context-embedding";
import { bulkInitUrlPagesActivity } from "../bulk-init-url-pages-activity";
import {
	COMPANY_CONTEXT_DISABLED_CRAWL_MESSAGE,
	companyUrlCrawlGateActivity,
} from "../company-gate-activity";
import { embedUrlPageActivity } from "../embed-url-page-activity";
import { pruneOrphanUrlPagesActivity } from "../prune-orphan-url-pages-activity";
import { updateParentStatusActivity } from "../update-parent-status-activity";
import { upsertUrlPageActivity } from "../upsert-url-page-activity";

const WORKFLOW_PATH = resolve(
	__dirname,
	"..",
	"..",
	"..",
	"workflows",
	"url-source-crawl.ts",
);

/** The crawler: a scripted site. */
async function firecrawlMapActivity(input: unknown) {
	return h.firecrawl.map(input);
}
async function firecrawlScrapeActivity(input: unknown) {
	return h.firecrawl.scrape(input);
}

/** The URL-source activities, as the worker registers them. */
const ACTIVITIES = {
	companyUrlCrawlGateActivity,
	bulkInitUrlPagesActivity,
	upsertUrlPageActivity,
	embedUrlPageActivity,
	updateParentStatusActivity,
	pruneOrphanUrlPagesActivity,
	embedSingleContextActivity,
	firecrawlMapActivity,
	firecrawlScrapeActivity,
};

// ---------------------------------------------------------------------------
// Readiness, judged by the query layer's own predicate
// ---------------------------------------------------------------------------

type Where = Record<string, unknown>;

/**
 * Evaluate a Prisma where-object against in-memory rows — only the operators
 * `companyContextReadyWhere` uses. Anything else throws, so a change to the
 * predicate's shape fails here loudly instead of being judged wrongly.
 */
function matchesWhere(
	row: Record<string, unknown>,
	where: Where,
	relations: Record<string, Record<string, unknown>[]>,
): boolean {
	for (const [key, condition] of Object.entries(where)) {
		if (key === "OR") {
			if (
				!(condition as Where[]).some((arm) =>
					matchesWhere(row, arm, relations),
				)
			) {
				return false;
			}
			continue;
		}
		if (key === "AND") {
			if (
				!(condition as Where[]).every((arm) =>
					matchesWhere(row, arm, relations),
				)
			) {
				return false;
			}
			continue;
		}
		if (key in relations) {
			const entries = Object.entries(condition as Where);
			if (entries.length !== 1) {
				throw new Error(`Unsupported relation filter on ${key}`);
			}
			const [[quantifier, filter]] = entries;
			const children = relations[key];
			const matching = (child: Record<string, unknown>) =>
				matchesWhere(child, filter as Where, {});
			const passes =
				quantifier === "every"
					? children.every(matching)
					: quantifier === "some"
						? children.some(matching)
						: quantifier === "none"
							? !children.some(matching)
							: null;
			if (passes === null) {
				throw new Error(
					`Unsupported relation filter ${quantifier} on ${key}`,
				);
			}
			if (!passes) {
				return false;
			}
			continue;
		}
		const value = row[key];
		if (condition !== null && typeof condition === "object") {
			for (const [operator, operand] of Object.entries(condition)) {
				if (operator === "not" && operand === null) {
					if (value === null || value === undefined) {
						return false;
					}
				} else if (operator === "in") {
					if (!(operand as unknown[]).includes(value)) {
						return false;
					}
				} else {
					throw new Error(
						`Unsupported operator ${operator} on ${key}`,
					);
				}
			}
		} else if (value !== condition) {
			return false;
		}
	}
	return true;
}

let readyWhere: (embeddingModel: string) => Where;

function isReady(sourceId: string, embeddingModel: string): boolean {
	const source = h.sources.get(sourceId);
	if (!source) {
		return false;
	}
	return matchesWhere(
		source as unknown as Record<string, unknown>,
		readyWhere(embeddingModel),
		{
			urlPages: [...h.pages.values()].filter(
				(page) => page.parentSourceId === sourceId,
			) as unknown as Record<string, unknown>[],
		},
	);
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let env: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundleWithSourceMap;
let runSeq = 0;

beforeAll(async () => {
	const queries = await vi.importActual<{
		companyContextReadyWhere: (embeddingModel: string) => Where;
	}>("@repo/database/prisma/queries/company-context");
	readyWhere = queries.companyContextReadyWhere;
	env = await TestWorkflowEnvironment.createTimeSkipping();
	h.temporal.client = env.client;
	workflowBundle = await bundleWorkflowCode({ workflowsPath: WORKFLOW_PATH });
}, 120_000);

afterAll(async () => {
	await env?.teardown();
});

/** The crawler serves these pages; a URL listed in `failing` will not scrape. */
function serveSite(
	pageContent: Record<string, string>,
	failing: ReadonlySet<string> = new Set(),
): void {
	h.firecrawl.map.mockImplementation(async () => ({
		urls: Object.keys(pageContent),
	}));
	h.firecrawl.scrape.mockImplementation(async ({ url }: { url: string }) => {
		if (failing.has(url)) {
			throw ApplicationFailure.nonRetryable(
				"scrape failed",
				"FIRECRAWL_TIMEOUT",
			);
		}
		return {
			pageUrl: url,
			pageTitle: `Page ${url}`,
			markdown: pageContent[url] ?? `# ${url}`,
		};
	});
}

function seedLinkSource(over: Partial<ReturnType<typeof linkSource>> = {}) {
	const row = { ...linkSource(), ...over };
	h.sources.set(row.id, row);
	return row;
}

function linkSource() {
	return {
		id: SOURCE,
		organizationId: ORG,
		type: "LINK",
		content: "",
		contentHash: null as string | null,
		metadata: {},
		s3Path: null,
		s3Bucket: null,
		originalFilename: null,
		mimeType: null,
		sourceUrl: SITE,
		sourceTitle: "Example docs",
		extractionStatus: "EXTRACTING" as
			| "PENDING"
			| "EXTRACTING"
			| "COMPLETED"
			| "FAILED"
			| "CANCELLED",
		extractionError: null as string | null,
		qdrantId: null as string | null,
		embeddedAt: null as Date | null,
		embeddingModel: null as string | null,
		urlActiveWorkflowId: null as string | null,
		urlRefreshMode: "WEEKLY" as string | null,
		urlLastSyncedAt: null as Date | null,
		urlNextRefreshAt: null as Date | null,
		deletingAt: null as Date | null,
	};
}

function companyCrawl(over: Record<string, unknown> = {}) {
	return {
		contextId: SOURCE,
		url: SITE,
		scope: "PATH_PREFIX",
		maxPages: 10,
		userId: USER,
		organizationId: ORG,
		apiKey: "fc-test-key",
		providerName: "firecrawl",
		urlRefreshMode: "WEEKLY",
		parentSourceTitle: "Example docs",
		mode: "initial",
		owner: OWNER,
		...over,
	};
}

interface Run {
	result?: { success: boolean; error?: string; pagesIndexed: number };
	error?: unknown;
	workflowId: string;
}

async function crawl(
	input: Record<string, unknown>,
	options: {
		activities?: Record<string, unknown>;
		taskQueue?: string;
		workflowId?: string;
	} = {},
): Promise<Run> {
	const taskQueue =
		options.taskQueue ??
		contextOwnerTaskQueue(
			input.owner as ContextOwner | undefined,
			"project-documents",
		);
	const workflowId = options.workflowId ?? `url-crawl-test-${runSeq++}`;
	const activities = options.activities ?? ACTIVITIES;
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle,
		activities,
	});
	const run = async () => {
		const handle = await env.client.workflow.start(
			"urlSourceCrawlWorkflow",
			{
				args: [input],
				taskQueue,
				workflowId,
			},
		);
		try {
			return { result: await handle.result(), workflowId };
		} catch (error) {
			return { error, workflowId };
		}
	};
	if ((input.owner as ContextOwner | undefined)?.kind === "company") {
		return worker.runUntil(run);
	}
	const embeddingWorker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue: PROJECT_EMBEDDING_TASK_QUEUE,
		activities,
	});
	const operationsWorker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue: PROJECT_OPERATIONS_ACTIVITY_TASK_QUEUE,
		activities,
	});
	return worker.runUntil(() =>
		embeddingWorker.runUntil(() => operationsWorker.runUntil(run)),
	);
}

/** Every activity the run scheduled, with its decoded input and queue. */
async function scheduled(
	workflowId: string,
): Promise<
	Array<{ name: string; input: Record<string, unknown>; taskQueue?: string }>
> {
	const history = await env.client.workflow
		.getHandle(workflowId)
		.fetchHistory();
	return (history.events ?? []).flatMap((event) => {
		const attributes = event.activityTaskScheduledEventAttributes;
		if (!attributes) {
			return [];
		}
		const [input] = (attributes.input?.payloads ?? []).map((payload) =>
			defaultPayloadConverter.fromPayload(payload),
		) as Record<string, unknown>[];
		return [
			{
				name: attributes.activityType?.name ?? "",
				input,
				taskQueue: attributes.taskQueue?.name ?? undefined,
			},
		];
	});
}

function expectNoProjectCalls(): void {
	for (const [name, fn] of Object.entries(h.projectOnly)) {
		expect(fn, name).not.toHaveBeenCalled();
	}
}

const pageByUrl = (url: string) =>
	[...h.pages.values()].find((page) => page.pageUrl === url);

beforeEach(() => {
	vi.clearAllMocks();
	h.reset();
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

describe("urlSourceCrawlWorkflow with a company owner", () => {
	it("crawls a multi-page site into the company tables and the company collection", async () => {
		seedLinkSource();
		serveSite({ [PAGE_A]: "# A", [PAGE_B]: "# B" });

		const run = await crawl(companyCrawl());

		expect(run.error).toBeUndefined();
		expect(run.result).toMatchObject({ success: true, pagesIndexed: 2 });

		const activities = await scheduled(run.workflowId);
		expect(activities[0].name).toBe("companyUrlCrawlGateActivity");
		for (const activity of activities) {
			expect(activity.taskQueue, activity.name).toBe(
				COMPANY_CONTEXT_TASK_QUEUE,
			);
			if (!activity.name.startsWith("firecrawl")) {
				expect(activity.input.owner, activity.name).toEqual(OWNER);
			}
		}

		// Pages carry the parent's organization.
		const crawled = [...h.pages.values()];
		expect(crawled.map((page) => page.pageUrl).sort()).toEqual([
			PAGE_A,
			PAGE_B,
		]);
		for (const page of crawled) {
			expect(page.organizationId).toBe(ORG);
			expect(page.parentSourceId).toBe(SOURCE);
			expect(page.embeddingModel).toBe(MODEL_A);
			// Each page's points: source as originalContextId, page as contextId.
			expect(h.points.get(page.id)).toEqual({
				organizationId: ORG,
				sourceId: SOURCE,
				parentContextId: SOURCE,
				embeddingModel: MODEL_A,
			});
		}

		// The parent is finalized on the company row and marked with the model.
		const source = h.sources.get(SOURCE);
		expect(source?.extractionStatus).toBe("COMPLETED");
		expect(source?.extractionError).toBeNull();
		expect(source?.urlActiveWorkflowId).toBeNull();
		// Dates cross Temporal's JSON payloads as ISO strings.
		expect(source?.urlLastSyncedAt).toBeTruthy();
		expect(source?.urlNextRefreshAt).toBeTruthy();
		expect(source?.embeddingModel).toBe(MODEL_A);
		expect(isReady(SOURCE, MODEL_A)).toBe(true);

		expectNoProjectCalls();
	}, 60_000);

	it("prunes pages the site no longer returns, with their points, and only this source's", async () => {
		seedLinkSource();
		seedLinkSource({ id: "src-other", organizationId: OTHER_ORG });
		serveSite({ [PAGE_A]: "# A", [PAGE_B]: "# B", [PAGE_C]: "# C" });
		await crawl(companyCrawl());
		// Another organization's page under the same URL is never touched.
		await h.queries.createCompanyContextUrlPages({
			parentSourceId: "src-other",
			organizationId: OTHER_ORG,
			pageUrls: [PAGE_C],
		});
		const otherPage = [...h.pages.values()].find(
			(page) => page.organizationId === OTHER_ORG,
		);
		const prunedPage = [...h.pages.values()].find(
			(page) => page.organizationId === ORG && page.pageUrl === PAGE_C,
		);
		expect(prunedPage && h.points.has(prunedPage.id)).toBe(true);

		serveSite({ [PAGE_A]: "# A", [PAGE_B]: "# B" });
		const run = await crawl(companyCrawl({ mode: "scheduled" }));

		expect(run.result?.success).toBe(true);
		const remaining = [...h.pages.values()].filter(
			(page) => page.organizationId === ORG,
		);
		expect(remaining.map((page) => page.pageUrl).sort()).toEqual([
			PAGE_A,
			PAGE_B,
		]);
		expect(prunedPage && h.pages.has(prunedPage.id)).toBe(false);
		expect(prunedPage && h.points.has(prunedPage.id)).toBe(false);
		expect(otherPage && h.pages.has(otherPage.id)).toBe(true);
		expect(isReady(SOURCE, MODEL_A)).toBe(true);
		expectNoProjectCalls();
	}, 60_000);

	it("skips unchanged pages on a scheduled refresh while the model is the same", async () => {
		seedLinkSource();
		serveSite({ [PAGE_A]: "# A", [PAGE_B]: "# B" });
		await crawl(companyCrawl());
		h.rag.embedCompanyContext.mockClear();

		serveSite({ [PAGE_A]: "# A", [PAGE_B]: "# B changed" });
		const run = await crawl(companyCrawl({ mode: "scheduled" }));

		expect(run.result?.success).toBe(true);
		const embedded = h.rag.embedCompanyContext.mock.calls.map(
			([options]) => options.contextId,
		);
		expect(embedded).toEqual([pageByUrl(PAGE_B)?.id]);
		expect(isReady(SOURCE, MODEL_A)).toBe(true);
	}, 60_000);

	/**
	 * A scheduled refresh after a model switch re-embeds even pages whose
	 * content did not change, and the source stays out of retrieval until
	 * every page carries the new model: here page B's upsert fails, so it keeps
	 * its old vectors until the next refresh re-embeds it.
	 */
	it("re-embeds unchanged pages after an embedding-model switch; ready only once every page has the new model", async () => {
		seedLinkSource();
		serveSite({ [PAGE_A]: "# A", [PAGE_B]: "# B" });
		await crawl(companyCrawl());
		expect(isReady(SOURCE, MODEL_A)).toBe(true);

		h.state.model = {
			identity: MODEL_B,
			dimensions: 1536,
			supported: true,
		};
		expect(isReady(SOURCE, MODEL_B)).toBe(false);

		h.state.failUpsert.add(PAGE_B);
		h.rag.embedCompanyContext.mockClear();
		const partial = await crawl(companyCrawl({ mode: "scheduled" }));

		expect(partial.result?.success).toBe(true);
		expect(
			h.rag.embedCompanyContext.mock.calls.map(
				([options]) => options.contextId,
			),
		).toEqual([pageByUrl(PAGE_A)?.id]);
		expect(pageByUrl(PAGE_A)?.embeddingModel).toBe(MODEL_B);
		expect(h.points.get(pageByUrl(PAGE_A)?.id ?? "")?.embeddingModel).toBe(
			MODEL_B,
		);
		expect(pageByUrl(PAGE_B)?.embeddingModel).toBe(MODEL_A);
		expect(h.sources.get(SOURCE)?.embeddingModel).toBe(MODEL_B);
		expect(isReady(SOURCE, MODEL_B)).toBe(false);

		h.state.failUpsert.clear();
		h.rag.embedCompanyContext.mockClear();
		const full = await crawl(companyCrawl({ mode: "scheduled" }));

		expect(full.result?.success).toBe(true);
		// Page A already carries model B and is unchanged: skipped this time.
		expect(
			h.rag.embedCompanyContext.mock.calls.map(
				([options]) => options.contextId,
			),
		).toEqual([pageByUrl(PAGE_B)?.id]);
		expect(pageByUrl(PAGE_B)?.embeddingModel).toBe(MODEL_B);
		expect(isReady(SOURCE, MODEL_B)).toBe(true);
	}, 90_000);

	it("re-embeds every page on a manual re-sync (the re-process path)", async () => {
		seedLinkSource();
		serveSite({ [PAGE_A]: "# A", [PAGE_B]: "# B" });
		await crawl(companyCrawl());
		h.rag.embedCompanyContext.mockClear();

		const run = await crawl(companyCrawl({ mode: "manual-resync" }));

		expect(run.result?.success).toBe(true);
		expect(h.rag.embedCompanyContext).toHaveBeenCalledTimes(2);
		// Each page's old points go before its new ones are written.
		for (const pageId of [pageByUrl(PAGE_A)?.id, pageByUrl(PAGE_B)?.id]) {
			expect(h.rag.deleteCompanyContextRowPoints).toHaveBeenCalledWith({
				organizationId: ORG,
				contextIds: [pageId],
			});
		}
		expect(isReady(SOURCE, MODEL_A)).toBe(true);
	}, 60_000);

	it("stores a single page on the source itself and embeds it as the source", async () => {
		seedLinkSource();
		serveSite({ [SITE]: "# Overview" });

		const run = await crawl(companyCrawl({ scope: "SINGLE_PAGE" }));

		expect(run.error).toBeUndefined();
		expect(run.result?.success).toBe(true);
		const source = h.sources.get(SOURCE);
		expect(source?.content).toBe("# Overview");
		expect(source?.extractionStatus).toBe("COMPLETED");
		expect(source?.embeddingModel).toBe(MODEL_A);
		expect(h.points.get(SOURCE)).toEqual({
			organizationId: ORG,
			sourceId: SOURCE,
			parentContextId: null,
			embeddingModel: MODEL_A,
		});
		expect(h.pages.size).toBe(0);
		expect(isReady(SOURCE, MODEL_A)).toBe(true);
		expectNoProjectCalls();
	}, 60_000);

	it("forgets a single page's vectors when a re-sync finds it empty, and says why it is not searchable", async () => {
		seedLinkSource();
		serveSite({ [SITE]: "# Overview" });
		await crawl(companyCrawl({ scope: "SINGLE_PAGE" }));
		expect(h.points.has(SOURCE)).toBe(true);
		expect(isReady(SOURCE, MODEL_A)).toBe(true);

		// The page now renders as no text at all.
		serveSite({ [SITE]: "" });
		const run = await crawl(
			companyCrawl({ scope: "SINGLE_PAGE", mode: "scheduled" }),
		);

		expect(run.result?.success).toBe(true);
		expect(h.points.has(SOURCE)).toBe(false);
		expect(h.sources.get(SOURCE)).toMatchObject({
			content: "",
			extractionStatus: "COMPLETED",
			extractionError: expect.stringMatching(/no text to index/),
			embeddedAt: null,
			embeddingModel: null,
			qdrantId: null,
		});
		expect(isReady(SOURCE, MODEL_A)).toBe(false);
	}, 60_000);

	it("fails a malformed owner non-retryably before anything is scheduled", async () => {
		seedLinkSource();
		const run = await crawl(companyCrawl({ owner: { kind: "company" } }), {
			taskQueue: COMPANY_CONTEXT_TASK_QUEUE,
		});

		expect(run.error).toBeInstanceOf(WorkflowFailedError);
		expect(
			((run.error as WorkflowFailedError).cause as { type?: string })
				.type,
		).toBe(CONTEXT_OWNER_INVALID);
		expect(await scheduled(run.workflowId)).toEqual([]);
	}, 60_000);
});

describe("the company crawl gate", () => {
	it("exits a scheduled crawl before any map or scrape when COMPANY_CONTEXT is off, keeping its data", async () => {
		seedLinkSource({
			extractionStatus: "COMPLETED",
			embeddedAt: new Date(),
			embeddingModel: MODEL_A,
		});
		await h.queries.createCompanyContextUrlPages({
			parentSourceId: SOURCE,
			organizationId: ORG,
			pageUrls: [PAGE_A],
		});
		const before = JSON.stringify([
			...h.sources.values(),
			...h.pages.values(),
		]);
		h.state.flagOn = false;
		serveSite({ [PAGE_A]: "# A" });

		const run = await crawl(companyCrawl({ mode: "scheduled" }));

		expect(run.result).toMatchObject({
			success: false,
			error: "company-context-disabled",
			pagesIndexed: 0,
		});
		expect((await scheduled(run.workflowId)).map((a) => a.name)).toEqual([
			"companyUrlCrawlGateActivity",
		]);
		expect(h.firecrawl.map).not.toHaveBeenCalled();
		expect(h.firecrawl.scrape).not.toHaveBeenCalled();
		expect(
			JSON.stringify([...h.sources.values(), ...h.pages.values()]),
		).toBe(before);
		expect(h.queries.isFeatureEnabled).toHaveBeenCalledWith(
			"COMPANY_CONTEXT",
			ORG,
		);
	}, 60_000);

	it("settles a crawl the API started when COMPANY_CONTEXT is off, so it does not look in flight", async () => {
		const workflowId = "url-crawl-src-1-resync-1";
		seedLinkSource({
			extractionStatus: "PENDING",
			urlActiveWorkflowId: workflowId,
		});
		h.state.flagOn = false;

		const run = await crawl(companyCrawl({ mode: "manual-resync" }), {
			workflowId,
		});

		expect(run.result).toMatchObject({
			success: false,
			error: COMPANY_CONTEXT_DISABLED_CRAWL_MESSAGE,
		});
		const source = h.sources.get(SOURCE);
		expect(source?.extractionStatus).toBe("CANCELLED");
		expect(source?.extractionError).toBe(
			COMPANY_CONTEXT_DISABLED_CRAWL_MESSAGE,
		);
		expect(source?.urlActiveWorkflowId).toBeNull();
		expect(h.firecrawl.map).not.toHaveBeenCalled();
	}, 60_000);

	it("does not settle another run's in-flight crawl", async () => {
		seedLinkSource({
			extractionStatus: "EXTRACTING",
			urlActiveWorkflowId: "url-crawl-src-1-resync-other",
		});
		h.state.flagOn = false;

		await crawl(companyCrawl({ mode: "manual-resync" }));

		expect(h.sources.get(SOURCE)?.extractionStatus).toBe("EXTRACTING");
		expect(h.sources.get(SOURCE)?.urlActiveWorkflowId).toBe(
			"url-crawl-src-1-resync-other",
		);
	}, 60_000);

	it("does not crawl a source that no longer exists", async () => {
		serveSite({ [PAGE_A]: "# A" });

		const run = await crawl(companyCrawl({ mode: "scheduled" }));

		expect(run.result).toMatchObject({
			success: false,
			error: "source-missing",
		});
		expect(h.firecrawl.map).not.toHaveBeenCalled();
		expect(h.pages.size).toBe(0);
	}, 60_000);

	it("does not crawl a website being deleted — a refresh that fires or a re-sync that reaches it — and writes nothing", async () => {
		seedLinkSource({
			extractionStatus: "FAILED",
			extractionError: "This source is being deleted.",
			embeddedAt: new Date(),
			embeddingModel: MODEL_A,
			deletingAt: new Date("2026-09-30T12:00:00.000Z"),
		});
		await h.queries.createCompanyContextUrlPages({
			parentSourceId: SOURCE,
			organizationId: ORG,
			pageUrls: [PAGE_A],
		});
		serveSite({ [PAGE_A]: "# A" });
		const before = rowsSnapshot();

		for (const mode of ["scheduled", "manual-resync"] as const) {
			const run = await crawl(companyCrawl({ mode }));

			expect(run.result, mode).toMatchObject({
				success: false,
				error: "source-deleting",
				pagesIndexed: 0,
			});
			expect(
				(await scheduled(run.workflowId)).map((a) => a.name),
				mode,
			).toEqual(["companyUrlCrawlGateActivity"]);
		}
		expect(h.firecrawl.map).not.toHaveBeenCalled();
		expect(h.firecrawl.scrape).not.toHaveBeenCalled();
		expect(rowsSnapshot()).toBe(before);
	}, 90_000);

	it("keeps a scheduled crawl out when the delete lands after the gate read the source: no crawl claims a source being deleted", async () => {
		seedLinkSource({
			extractionStatus: "COMPLETED",
			embeddedAt: new Date(),
			embeddingModel: MODEL_A,
		});
		// The gate reads the source as it was; the delete tombstones it next.
		h.queries.getCompanyContextSource.mockImplementationOnce(
			async (id: string, org: string) => {
				const row = h.sources.get(id);
				const seen =
					row && row.organizationId === org ? { ...row } : null;
				if (row) {
					Object.assign(row, {
						deletingAt: new Date("2026-09-30T12:00:00.000Z"),
						extractionStatus: "FAILED",
					});
				}
				return seen;
			},
		);

		await expect(
			companyUrlCrawlGateActivity({
				contextId: SOURCE,
				owner: OWNER,
				userId: USER,
				mode: "scheduled",
				workflowId: "wf-scheduled",
			}),
		).resolves.toMatchObject({ proceed: false });
		expect(h.queries.claimCompanyLinkSourceCrawl).toHaveBeenCalled();
		expect(h.sources.get(SOURCE)?.urlActiveWorkflowId).toBeNull();
		expect(h.queries.finalizeCompanyLinkSourceCrawl).not.toHaveBeenCalled();
	});

	it("fails the source instead of crawling when the embedding model cannot index it", async () => {
		seedLinkSource({ extractionStatus: "COMPLETED" });
		h.state.model = {
			identity: "OPENAI_DIRECT:text-embedding-3-large",
			dimensions: 3072,
			supported: false,
		};
		serveSite({ [PAGE_A]: "# A" });

		const run = await crawl(companyCrawl({ mode: "scheduled" }));

		expect(run.result?.success).toBe(false);
		expect(h.firecrawl.map).not.toHaveBeenCalled();
		const source = h.sources.get(SOURCE);
		expect(source?.extractionStatus).toBe("FAILED");
		expect(source?.extractionError).toBe(
			"Unsupported embedding model: OPENAI_DIRECT:text-embedding-3-large",
		);
		expect(h.points.size).toBe(0);
	}, 60_000);

	it("fails the source instead of crawling when no embedding provider is configured", async () => {
		seedLinkSource();
		h.state.modelError = new h.AIProviderNotConfiguredError("none");
		serveSite({ [PAGE_A]: "# A" });

		const run = await crawl(companyCrawl());

		expect(run.result?.success).toBe(false);
		expect(h.firecrawl.map).not.toHaveBeenCalled();
		expect(h.sources.get(SOURCE)?.extractionStatus).toBe("FAILED");
		expect(h.sources.get(SOURCE)?.extractionError).toMatch(
			/AI provider not configured/,
		);
	}, 60_000);

	it("keeps a COMPLETED, embedded website COMPLETED when a scheduled refresh finds no usable model, and frees the slot", async () => {
		seedLinkSource();
		serveSite({ [PAGE_A]: "# A", [PAGE_B]: "# B" });
		await crawl(companyCrawl());
		const lastSynced = h.sources.get(SOURCE)?.urlLastSyncedAt;
		h.firecrawl.map.mockClear();

		// The organization's provider is gone for a while.
		h.state.modelError = new h.AIProviderNotConfiguredError("none");
		const run = await crawl(companyCrawl({ mode: "scheduled" }));

		expect(run.result?.success).toBe(false);
		expect(h.firecrawl.map).not.toHaveBeenCalled();
		const source = h.sources.get(SOURCE);
		expect(source).toMatchObject({
			extractionStatus: "COMPLETED",
			extractionError: expect.stringMatching(
				/AI provider not configured/,
			),
			embeddingModel: MODEL_A,
			urlLastSyncedAt: lastSynced,
			urlActiveWorkflowId: null,
		});
		// The schedule keeps its next refresh.
		expect(source?.urlNextRefreshAt).toBeTruthy();

		// Its pages and vectors were never touched: back in retrieval the
		// moment the provider is.
		h.state.modelError = null;
		expect(isReady(SOURCE, MODEL_A)).toBe(true);
	}, 90_000);

	it("still fails a website a re-sync the API started when no usable model is found", async () => {
		seedLinkSource();
		serveSite({ [PAGE_A]: "# A" });
		await crawl(companyCrawl());
		// What the API does before it starts a re-sync.
		await h.queries.updateCompanyContextSourceStatus(
			SOURCE,
			ORG,
			"PENDING",
			{ extractionError: null },
		);

		h.state.modelError = new h.AIProviderNotConfiguredError("none");
		const run = await crawl(companyCrawl({ mode: "manual-resync" }));

		expect(run.result?.success).toBe(false);
		expect(h.sources.get(SOURCE)).toMatchObject({
			extractionStatus: "FAILED",
			extractionError: expect.stringMatching(
				/AI provider not configured/,
			),
			urlActiveWorkflowId: null,
		});
	}, 90_000);

	describe("with a crawl slot another workflow holds", () => {
		const describeHolder = vi.fn();
		let realClient: unknown;
		beforeEach(() => {
			realClient = h.temporal.client;
			h.temporal.client = {
				workflow: {
					getHandle: () => ({ describe: describeHolder }),
				},
			};
		});
		afterEach(() => {
			h.temporal.client = realClient;
		});

		const gate = (mode: "scheduled" | "retry-single-page") =>
			companyUrlCrawlGateActivity({
				contextId: SOURCE,
				owner: OWNER,
				userId: USER,
				mode,
				workflowId: "wf-me",
			});

		it("treats a crawl it cannot describe as running, and writes nothing", async () => {
			seedLinkSource({
				extractionStatus: "COMPLETED",
				urlActiveWorkflowId: "wf-other",
			});
			describeHolder.mockRejectedValue(new Error("deadline exceeded"));
			const before = rowsSnapshot();

			await expect(gate("scheduled")).resolves.toEqual({
				proceed: false,
				reason: "crawl-in-progress",
			});
			expect(rowsSnapshot()).toBe(before);
		});

		it("lets a single-page retry run beside no crawl without claiming the slot", async () => {
			seedLinkSource({ extractionStatus: "COMPLETED" });

			await expect(gate("retry-single-page")).resolves.toEqual({
				proceed: true,
			});
			expect(h.sources.get(SOURCE)?.urlActiveWorkflowId).toBeNull();
			expect(describeHolder).not.toHaveBeenCalled();
		});

		it("refuses a single-page retry while another crawl runs", async () => {
			seedLinkSource({
				extractionStatus: "COMPLETED",
				urlActiveWorkflowId: "wf-other",
			});
			describeHolder.mockResolvedValue({ status: { name: "RUNNING" } });

			await expect(gate("retry-single-page")).resolves.toEqual({
				proceed: false,
				reason: "crawl-in-progress",
			});
			expect(h.sources.get(SOURCE)?.urlActiveWorkflowId).toBe("wf-other");
		});
	});

	it("refuses a project owner", async () => {
		await expect(
			companyUrlCrawlGateActivity({
				contextId: SOURCE,
				owner: { kind: "project", projectId: "proj-1" },
				userId: USER,
				mode: "scheduled",
				workflowId: "wf-1",
			}),
		).rejects.toMatchObject({ type: CONTEXT_OWNER_INVALID });
		expect(h.queries.isFeatureEnabled).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// One crawl at a time, and what a crawl leaves when it ends
// ---------------------------------------------------------------------------

function companyWorker(): Promise<Worker> {
	return Worker.create({
		connection: env.nativeConnection,
		taskQueue: COMPANY_CONTEXT_TASK_QUEUE,
		workflowBundle,
		activities: ACTIVITIES,
	});
}

function startCrawl(input: Record<string, unknown>, workflowId: string) {
	return env.client.workflow.start("urlSourceCrawlWorkflow", {
		args: [input],
		taskQueue: COMPANY_CONTEXT_TASK_QUEUE,
		workflowId,
	});
}

/**
 * Wait for a crawl to close by describing it: unlike awaiting its result,
 * this never lets the test server skip time past a crawl held mid-scrape.
 */
async function untilClosed(workflowId: string): Promise<void> {
	const handle = env.client.workflow.getHandle(workflowId);
	for (let attempt = 0; attempt < 300; attempt++) {
		const { status } = await handle.describe();
		if (status.name !== "RUNNING") {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`${workflowId} did not finish`);
}

/** Hold the next scrape until released, serving the site as before. */
function holdNextScrape(): { reached: Promise<void>; release: () => void } {
	const serve = h.firecrawl.scrape.getMockImplementation();
	let arrive = () => {};
	let release = () => {};
	const reached = new Promise<void>((resolve) => {
		arrive = resolve;
	});
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	let held = false;
	h.firecrawl.scrape.mockImplementation(async (input: { url: string }) => {
		if (!held) {
			held = true;
			arrive();
			await released;
		}
		return serve?.(input);
	});
	return { reached, release };
}

const rowsSnapshot = () =>
	JSON.stringify([...h.sources.values(), ...h.pages.values()]);

describe("one crawl of a company source at a time", () => {
	it("exits a manual re-sync that starts while a scheduled crawl runs, before any crawler call; the scheduled crawl finishes the source", async () => {
		seedLinkSource();
		serveSite({ [PAGE_A]: "# A", [PAGE_B]: "# B" });
		await crawl(companyCrawl());
		h.firecrawl.map.mockClear();
		const scheduledId = "url-crawl-src-1-2026-10-04T00:00:00Z";
		const resyncId = "url-crawl-src-1-resync-1";

		const hold = holdNextScrape();
		const worker = await companyWorker();
		await worker.runUntil(async () => {
			const refresh = await startCrawl(
				companyCrawl({ mode: "scheduled" }),
				scheduledId,
			);
			await hold.reached;
			expect(h.sources.get(SOURCE)?.urlActiveWorkflowId).toBe(
				scheduledId,
			);

			// The API read the source just before the scheduled crawl
			// claimed it, so it set the source PENDING and started a re-sync.
			await h.queries.updateCompanyContextSourceStatus(
				SOURCE,
				ORG,
				"PENDING",
				{ extractionError: null },
			);
			await startCrawl(companyCrawl({ mode: "manual-resync" }), resyncId);
			await untilClosed(resyncId);
			expect(
				await env.client.workflow.getHandle(resyncId).result(),
			).toMatchObject({ success: false, error: "crawl-in-progress" });
			expect(h.sources.get(SOURCE)?.urlActiveWorkflowId).toBe(
				scheduledId,
			);

			hold.release();
			expect(await refresh.result()).toMatchObject({ success: true });
		});

		expect((await scheduled(resyncId)).map((a) => a.name)).toEqual([
			"companyUrlCrawlGateActivity",
		]);
		expect(h.firecrawl.map).toHaveBeenCalledTimes(1);
		expect(h.sources.get(SOURCE)).toMatchObject({
			extractionStatus: "COMPLETED",
			urlActiveWorkflowId: null,
		});
		expect(isReady(SOURCE, MODEL_A)).toBe(true);
	}, 90_000);

	it("exits a scheduled crawl that fires while a re-sync runs, with no crawler call and no write", async () => {
		seedLinkSource({ extractionStatus: "PENDING" });
		serveSite({ [PAGE_A]: "# A" });
		const resyncId = "url-crawl-src-1-resync-1";
		const scheduledId = "url-crawl-src-1-2026-10-04T00:00:00Z";

		const hold = holdNextScrape();
		const worker = await companyWorker();
		await worker.runUntil(async () => {
			const resync = await startCrawl(
				companyCrawl({ mode: "manual-resync" }),
				resyncId,
			);
			await hold.reached;
			const before = rowsSnapshot();
			const mapCalls = h.firecrawl.map.mock.calls.length;
			const scrapeCalls = h.firecrawl.scrape.mock.calls.length;

			await startCrawl(companyCrawl({ mode: "scheduled" }), scheduledId);
			await untilClosed(scheduledId);

			expect(
				await env.client.workflow.getHandle(scheduledId).result(),
			).toMatchObject({ success: false, error: "crawl-in-progress" });
			expect(rowsSnapshot()).toBe(before);
			expect(h.firecrawl.map).toHaveBeenCalledTimes(mapCalls);
			expect(h.firecrawl.scrape).toHaveBeenCalledTimes(scrapeCalls);

			hold.release();
			expect(await resync.result()).toMatchObject({ success: true });
		});

		expect(h.sources.get(SOURCE)).toMatchObject({
			extractionStatus: "COMPLETED",
			urlActiveWorkflowId: null,
		});
		expect(isReady(SOURCE, MODEL_A)).toBe(true);
	}, 90_000);

	it("takes over the slot a crawl that no longer runs left behind", async () => {
		seedLinkSource({
			extractionStatus: "COMPLETED",
			embeddedAt: new Date(),
			embeddingModel: MODEL_A,
			urlActiveWorkflowId: "url-crawl-src-1-resync-long-gone",
		});
		serveSite({ [PAGE_A]: "# A" });

		const run = await crawl(companyCrawl({ mode: "scheduled" }));

		expect(run.result?.success).toBe(true);
		expect(h.firecrawl.map).toHaveBeenCalledTimes(1);
		expect(pageByUrl(PAGE_A)?.embeddingModel).toBe(MODEL_A);
		expect(h.sources.get(SOURCE)?.urlActiveWorkflowId).toBeNull();
	}, 60_000);
});

describe("a scheduled refresh of a ready website", () => {
	it("keeps the website ready while the refresh adds a page, holding the crawl slot", async () => {
		seedLinkSource();
		serveSite({ [PAGE_A]: "# A", [PAGE_B]: "# B" });
		await crawl(companyCrawl());
		expect(isReady(SOURCE, MODEL_A)).toBe(true);

		serveSite({ [PAGE_A]: "# A", [PAGE_B]: "# B", [PAGE_C]: "# C" });
		const serve = h.firecrawl.scrape.getMockImplementation();
		const seenWhileRunning: unknown[] = [];
		h.firecrawl.scrape.mockImplementation(
			async (input: { url: string }) => {
				if (input.url === PAGE_C) {
					const source = h.sources.get(SOURCE);
					seenWhileRunning.push({
						ready: isReady(SOURCE, MODEL_A),
						status: source?.extractionStatus,
						slot: source?.urlActiveWorkflowId,
						newPage: pageByUrl(PAGE_C)?.extractionStatus,
					});
				}
				return serve?.(input);
			},
		);

		const run = await crawl(companyCrawl({ mode: "scheduled" }));

		expect(run.result?.success).toBe(true);
		expect(seenWhileRunning).toEqual([
			{
				ready: true,
				status: "COMPLETED",
				slot: run.workflowId,
				newPage: "PENDING",
			},
		]);
		expect(pageByUrl(PAGE_C)).toMatchObject({
			extractionStatus: "COMPLETED",
			embeddingModel: MODEL_A,
		});
		expect(h.sources.get(SOURCE)?.urlActiveWorkflowId).toBeNull();
		expect(isReady(SOURCE, MODEL_A)).toBe(true);
	}, 90_000);

	it("keeps the website COMPLETED and searchable when the refresh fails, recording the error", async () => {
		seedLinkSource();
		serveSite({ [PAGE_A]: "# A", [PAGE_B]: "# B" });
		await crawl(companyCrawl());
		const lastSynced = h.sources.get(SOURCE)?.urlLastSyncedAt;
		expect(lastSynced).toBeTruthy();
		h.firecrawl.map.mockRejectedValue(
			ApplicationFailure.nonRetryable(
				"Firecrawl returned 429 (rate limited)",
				"FIRECRAWL_QUOTA_EXCEEDED",
			),
		);

		const run = await crawl(companyCrawl({ mode: "scheduled" }));

		expect(run.error).toBeInstanceOf(WorkflowFailedError);
		const source = h.sources.get(SOURCE);
		expect(source).toMatchObject({
			extractionStatus: "COMPLETED",
			extractionError: "Firecrawl returned 429 (rate limited)",
			embeddingModel: MODEL_A,
			urlLastSyncedAt: lastSynced,
			urlActiveWorkflowId: null,
		});
		// The schedule still fires: the next refresh is not cleared.
		expect(source?.urlNextRefreshAt).toBeTruthy();
		expect(isReady(SOURCE, MODEL_A)).toBe(true);
	}, 90_000);

	it("still fails the website when a re-sync the API started fails", async () => {
		seedLinkSource();
		serveSite({ [PAGE_A]: "# A" });
		await crawl(companyCrawl());
		// What the API does before it starts a re-sync.
		await h.queries.updateCompanyContextSourceStatus(
			SOURCE,
			ORG,
			"PENDING",
			{ extractionError: null },
		);
		h.firecrawl.map.mockRejectedValue(
			ApplicationFailure.nonRetryable(
				"Firecrawl returned 429 (rate limited)",
				"FIRECRAWL_QUOTA_EXCEEDED",
			),
		);

		const run = await crawl(companyCrawl({ mode: "manual-resync" }));

		expect(run.error).toBeInstanceOf(WorkflowFailedError);
		expect(h.sources.get(SOURCE)).toMatchObject({
			extractionStatus: "FAILED",
			extractionError: "Firecrawl returned 429 (rate limited)",
			urlActiveWorkflowId: null,
		});
		expect(isReady(SOURCE, MODEL_A)).toBe(false);
	}, 90_000);
});

describe("a website none of whose pages could be indexed", () => {
	it("finalizes COMPLETED without the embedded mark, says why, and is not ready", async () => {
		seedLinkSource();
		serveSite({ [PAGE_A]: "# A", [PAGE_B]: "# B" });
		// Every page's embed fails, on every attempt; the crawl goes on.
		const embed = h.rag.embedCompanyContext.getMockImplementation();
		h.rag.embedCompanyContext.mockImplementation(async () => ({
			success: false,
			error: "embedding key revoked",
			chunksCreated: 0,
		}));

		let run: Run;
		try {
			run = await crawl(companyCrawl());
		} finally {
			if (embed) {
				h.rag.embedCompanyContext.mockImplementation(embed);
			}
		}

		expect(run.error).toBeUndefined();
		expect(h.points.size).toBe(0);
		for (const page of h.pages.values()) {
			expect(page.embeddedAt).toBeNull();
		}
		expect(h.sources.get(SOURCE)).toMatchObject({
			extractionStatus: "COMPLETED",
			extractionError: expect.stringMatching(
				/No page of this website could be indexed/,
			),
			embeddedAt: null,
			embeddingModel: null,
			urlActiveWorkflowId: null,
		});
		expect(isReady(SOURCE, MODEL_A)).toBe(false);
	}, 120_000);

	it("keeps a ready website ready when a refresh scrapes nothing, since its pages keep their vectors", async () => {
		seedLinkSource();
		serveSite({ [PAGE_A]: "# A", [PAGE_B]: "# B" });
		await crawl(companyCrawl());
		expect(isReady(SOURCE, MODEL_A)).toBe(true);

		serveSite(
			{ [PAGE_A]: "# A", [PAGE_B]: "# B" },
			new Set([PAGE_A, PAGE_B]),
		);
		const run = await crawl(companyCrawl({ mode: "scheduled" }));

		expect(run.error).toBeUndefined();
		expect(h.sources.get(SOURCE)).toMatchObject({
			extractionStatus: "COMPLETED",
			extractionError: null,
			embeddingModel: MODEL_A,
		});
		expect(isReady(SOURCE, MODEL_A)).toBe(true);
	}, 120_000);

	it("is not ready while it has pages and none holds the current model's vectors, whatever its own marks say", async () => {
		seedLinkSource({
			extractionStatus: "COMPLETED",
			embeddedAt: new Date(),
			embeddingModel: MODEL_A,
		});
		// A file, a text or a single page has no page rows, and is ready on
		// its own marks.
		expect(isReady(SOURCE, MODEL_A)).toBe(true);

		await h.queries.createCompanyContextUrlPages({
			parentSourceId: SOURCE,
			organizationId: ORG,
			pageUrls: [PAGE_A, PAGE_B],
		});
		for (const page of h.pages.values()) {
			page.extractionStatus = "FAILED";
		}
		expect(isReady(SOURCE, MODEL_A)).toBe(false);

		Object.assign(pageByUrl(PAGE_A) ?? {}, {
			extractionStatus: "COMPLETED",
			embeddedAt: new Date(),
			embeddingModel: MODEL_A,
		});
		expect(isReady(SOURCE, MODEL_A)).toBe(true);
	});
});

/**
 * The finalize the workflow's cancel path makes after some pages were
 * indexed: COMPLETED, no content, no error. (The time-skipping test server
 * cannot cancel a crawl mid-activity, so this is driven at the activity, with
 * the cancel path's exact input.)
 */
describe("a crawl cancelled after it indexed some pages", () => {
	it("leaves the website ready, and settles the pages it never reached as CANCELLED", async () => {
		const workflowId = "url-crawl-src-1";
		seedLinkSource({
			extractionStatus: "PENDING",
			urlActiveWorkflowId: workflowId,
		});
		await h.queries.createCompanyContextUrlPages({
			parentSourceId: SOURCE,
			organizationId: ORG,
			pageUrls: [PAGE_A, PAGE_B, PAGE_C],
		});
		// A was indexed; B was fetched but not embedded; C was never reached.
		Object.assign(pageByUrl(PAGE_A) ?? {}, {
			extractionStatus: "COMPLETED",
			embeddedAt: new Date(),
			embeddingModel: MODEL_A,
		});
		Object.assign(pageByUrl(PAGE_B) ?? {}, {
			content: "# B",
			contentHash: "hash:# B",
		});
		expect(isReady(SOURCE, MODEL_A)).toBe(false);

		await finalizeAs(workflowId, {
			contextId: SOURCE,
			extractionStatus: "COMPLETED",
			urlLastSyncedAt: new Date(),
			urlNextRefreshAt: new Date("2026-10-07T00:00:00.000Z"),
			extractionError: null,
			owner: OWNER,
		});

		expect(h.sources.get(SOURCE)).toMatchObject({
			extractionStatus: "COMPLETED",
			embeddingModel: MODEL_A,
			urlActiveWorkflowId: null,
		});
		expect(pageByUrl(PAGE_A)?.extractionStatus).toBe("COMPLETED");
		expect(pageByUrl(PAGE_B)?.extractionStatus).toBe("CANCELLED");
		expect(pageByUrl(PAGE_C)?.extractionStatus).toBe("CANCELLED");
		expect(isReady(SOURCE, MODEL_A)).toBe(true);
	});

	it("re-embeds, on the next refresh, a page whose new content was stored but never embedded", async () => {
		seedLinkSource();
		serveSite({ [PAGE_A]: "# A", [PAGE_B]: "# B" });
		await crawl(companyCrawl());
		// A refresh stored B's new content and hash, then was cancelled
		// before B's embed: B still holds the old version's vectors.
		Object.assign(pageByUrl(PAGE_B) ?? {}, {
			content: "# B changed",
			contentHash: "hash:# B changed",
			extractionStatus: "PENDING",
		});
		h.rag.embedCompanyContext.mockClear();

		serveSite({ [PAGE_A]: "# A", [PAGE_B]: "# B changed" });
		const run = await crawl(companyCrawl({ mode: "scheduled" }));

		expect(run.result?.success).toBe(true);
		expect(
			h.rag.embedCompanyContext.mock.calls.map(
				([options]) => options.contextId,
			),
		).toEqual([pageByUrl(PAGE_B)?.id]);
		expect(pageByUrl(PAGE_B)?.extractionStatus).toBe("COMPLETED");
		expect(isReady(SOURCE, MODEL_A)).toBe(true);
	}, 60_000);

	it("keeps a PENDING page that still holds vectors as it is", async () => {
		seedLinkSource({ urlActiveWorkflowId: "wf-1" });
		await h.queries.createCompanyContextUrlPages({
			parentSourceId: SOURCE,
			organizationId: ORG,
			pageUrls: [PAGE_A],
		});
		// Fetched with new content; its re-embed never ran.
		Object.assign(pageByUrl(PAGE_A) ?? {}, {
			embeddedAt: new Date(),
			embeddingModel: MODEL_A,
		});

		await finalizeAs("wf-1", {
			contextId: SOURCE,
			extractionStatus: "COMPLETED",
			extractionError: null,
			owner: OWNER,
		});

		expect(pageByUrl(PAGE_A)).toMatchObject({
			extractionStatus: "PENDING",
			embeddingModel: MODEL_A,
		});
		expect(isReady(SOURCE, MODEL_A)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

function fakeScheduleClient() {
	const create = vi.fn().mockResolvedValue(undefined);
	return {
		client: { create } as unknown as ScheduleClient,
		create,
	};
}

const scheduleBase = {
	contextId: SOURCE,
	url: SITE,
	scope: "PATH_PREFIX" as const,
	maxPages: 10,
	userId: USER,
	organizationId: ORG,
	apiKey: "fc-test-key",
	providerName: "firecrawl" as const,
	refreshMode: "WEEKLY" as const,
	parentSourceTitle: "Example docs",
};

describe("a source whose delete has started", () => {
	const DELETING_AT = new Date("2026-09-30T12:00:00.000Z");

	it("an embed that finishes after the delete started removes the points it wrote, and leaves the source not ready", async () => {
		seedLinkSource({
			content: "# Overview",
			extractionStatus: "FAILED",
			extractionError: "This source is being deleted.",
			deletingAt: DELETING_AT,
		});

		const result = await embedSingleContextActivity({
			contextId: SOURCE,
			userId: USER,
			type: "LINK",
			owner: OWNER,
		});

		expect(result).toEqual({ success: true });
		expect(h.rag.embedCompanyContext).toHaveBeenCalledTimes(1);
		// Written by the embed, refused its mark, removed again.
		expect(h.points.has(SOURCE)).toBe(false);
		expect(h.sources.get(SOURCE)).toMatchObject({
			extractionStatus: "FAILED",
			extractionError: "This source is being deleted.",
			embeddedAt: null,
			embeddingModel: null,
			deletingAt: DELETING_AT,
		});
		expect(isReady(SOURCE, MODEL_A)).toBe(false);
	});

	it("is never ready, whatever its status and index markers say", () => {
		const source = seedLinkSource({
			extractionStatus: "COMPLETED",
			embeddedAt: new Date(),
			embeddingModel: MODEL_A,
		});
		expect(isReady(SOURCE, MODEL_A)).toBe(true);

		source.deletingAt = DELETING_AT;

		expect(isReady(SOURCE, MODEL_A)).toBe(false);
	});
});

describe("company crawl schedules", () => {
	it("fires a crawl with the company owner, on the company queue", async () => {
		seedLinkSource({ extractionStatus: "COMPLETED" });
		serveSite({ [PAGE_A]: "# A" });
		const { client, create } = fakeScheduleClient();

		await createUrlSourceSchedule(
			{ ...scheduleBase, owner: OWNER },
			client,
		);

		const { action } = create.mock.calls[0][0];
		expect(action.taskQueue).toBe(COMPANY_CONTEXT_TASK_QUEUE);
		expect(action.args[0]).toMatchObject({
			mode: "scheduled",
			owner: OWNER,
		});
		expect(action.args[0]).not.toHaveProperty("projectId");

		// What the schedule would start, started the same way.
		const run = await crawl(action.args[0], {
			taskQueue: action.taskQueue,
		});

		expect(run.result?.success).toBe(true);
		expect(pageByUrl(PAGE_A)?.organizationId).toBe(ORG);
		expect(h.queries.upsertCompanyContextUrlPage).toHaveBeenCalled();
		expectNoProjectCalls();
	}, 60_000);

	/**
	 * Every schedule created before company context has args without an
	 * owner. They must still run the project crawl, with exactly the project
	 * inputs: no gate, and no `owner` on any activity.
	 */
	it("still runs a project crawl from schedule args recorded without an owner", async () => {
		const { client, create } = fakeScheduleClient();
		await createUrlSourceSchedule(
			{ ...scheduleBase, contextId: "ctx-1", projectId: "proj-1" },
			client,
		);
		const { action } = create.mock.calls[0][0];
		expect(action.taskQueue).toBe("project-documents");
		expect(action.args[0]).not.toHaveProperty("owner");

		serveSite({ [PAGE_A]: "# A", [PAGE_B]: "# B" });
		const projectActivities = {
			firecrawlMapActivity,
			firecrawlScrapeActivity,
			companyUrlCrawlGateActivity: vi.fn(),
			bulkInitUrlPagesActivity: vi.fn(
				async ({ urls }: { urls: string[] }) => ({
					totalCount: urls.length,
					createdCount: urls.length,
					existingCount: 0,
				}),
			),
			upsertUrlPageActivity: vi.fn(
				async ({ pageUrl }: { pageUrl: string }) => ({
					pageId: `page:${pageUrl}`,
					contentHash: "hash",
					skipped: false,
				}),
			),
			embedUrlPageActivity: vi.fn(async () => ({
				success: true,
				chunkCount: 1,
			})),
			pruneOrphanUrlPagesActivity: vi.fn(async () => ({
				deletedCount: 0,
			})),
			updateParentStatusActivity: vi.fn(async () => ({ success: true })),
		};

		const run = await crawl(action.args[0], {
			taskQueue: action.taskQueue,
			activities: projectActivities,
		});

		expect(run.result).toMatchObject({ success: true, pagesIndexed: 2 });
		const activities = await scheduled(run.workflowId);
		expect(activities.map((a) => a.name)).not.toContain(
			"companyUrlCrawlGateActivity",
		);
		expect(activities.map((a) => a.name)).toEqual([
			"firecrawlMapActivity",
			"bulkInitUrlPagesActivity",
			"firecrawlScrapeActivity",
			"upsertUrlPageActivity",
			"embedUrlPageActivity",
			"firecrawlScrapeActivity",
			"upsertUrlPageActivity",
			"embedUrlPageActivity",
			"pruneOrphanUrlPagesActivity",
			"updateParentStatusActivity",
		]);
		for (const activity of activities) {
			expect(activity.input, activity.name).not.toHaveProperty("owner");
			expect(activity.taskQueue).toBe(
				activity.name === "updateParentStatusActivity"
					? PROJECT_OPERATIONS_ACTIVITY_TASK_QUEUE
					: PROJECT_EMBEDDING_TASK_QUEUE,
			);
		}

		// Changing every recorded project queue to its historical value must
		// replay the same completed crawl without changing the command order.
		const history = await env.client.workflow
			.getHandle(run.workflowId)
			.fetchHistory();
		for (const event of history.events ?? []) {
			const activity = event.activityTaskScheduledEventAttributes;
			if (activity?.taskQueue) {
				activity.taskQueue.name = "project-documents";
			}
		}
		await Worker.runReplayHistory(
			{ workflowBundle },
			history,
			run.workflowId,
		);
		expect(
			activities.find((a) => a.name === "upsertUrlPageActivity")?.input,
		).toMatchObject({ projectId: "proj-1", mode: "scheduled" });
		expect(
			activities.find((a) => a.name === "updateParentStatusActivity")
				?.input,
		).toMatchObject({ projectId: "proj-1", sourceUrl: SITE });
		expect(
			projectActivities.companyUrlCrawlGateActivity,
		).not.toHaveBeenCalled();
	}, 60_000);

	it("keeps a project schedule's args exactly as before", async () => {
		const { client, create } = fakeScheduleClient();
		await createUrlSourceSchedule(
			{ ...scheduleBase, contextId: "ctx-1", projectId: "proj-1" },
			client,
		);
		expect(create.mock.calls[0][0].action.args[0]).toEqual({
			contextId: "ctx-1",
			url: SITE,
			scope: "PATH_PREFIX",
			maxPages: 10,
			projectId: "proj-1",
			userId: USER,
			organizationId: ORG,
			apiKey: "fc-test-key",
			providerName: "firecrawl",
			urlRefreshMode: "WEEKLY",
			parentSourceTitle: "Example docs",
			mode: "scheduled",
		});
	});

	it("refuses a company owner of another organization", async () => {
		const { client, create } = fakeScheduleClient();
		await expect(
			createUrlSourceSchedule(
				{
					...scheduleBase,
					owner: { kind: "company", organizationId: OTHER_ORG },
				},
				client,
			),
		).rejects.toMatchObject({ type: CONTEXT_OWNER_INVALID });
		expect(create).not.toHaveBeenCalled();
	});

	it("refuses args that name neither a project nor a company owner", async () => {
		const { client, create } = fakeScheduleClient();
		await expect(
			createUrlSourceSchedule(scheduleBase, client),
		).rejects.toThrow(/projectId, or a company owner/);
		expect(create).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Activity edges the end-to-end runs do not reach
// ---------------------------------------------------------------------------

const pageInput = (over: Record<string, unknown> = {}) => ({
	pageId: "page-1",
	parentContextId: SOURCE,
	pageUrl: PAGE_A,
	parentSourceTitle: "Example docs",
	content: "# A",
	userId: USER,
	organizationId: ORG,
	owner: OWNER,
	...over,
});

async function seedPage(over: Record<string, unknown> = {}) {
	seedLinkSource();
	await h.queries.createCompanyContextUrlPages({
		parentSourceId: SOURCE,
		organizationId: ORG,
		pageUrls: [PAGE_A],
	});
	const page = pageByUrl(PAGE_A);
	if (!page) {
		throw new Error("page not seeded");
	}
	Object.assign(page, over);
	return page;
}

describe("embedUrlPageActivity with a company owner", () => {
	it("fails the page without writing anything when the model cannot index it", async () => {
		const page = await seedPage();
		h.state.model = {
			identity: "X:big",
			dimensions: 3072,
			supported: false,
		};

		await expect(
			embedUrlPageActivity(pageInput({ pageId: page.id })),
		).rejects.toMatchObject({ nonRetryable: true });

		expect(page.extractionStatus).toBe("FAILED");
		expect(page.extractionError).toBe("Unsupported embedding model: X:big");
		expect(h.rag.embedCompanyContext).not.toHaveBeenCalled();
		expect(h.rag.deleteCompanyContextRowPoints).not.toHaveBeenCalled();
	});

	it("completes an empty page with no points, removing an earlier version's", async () => {
		const page = await seedPage({
			embeddedAt: new Date(),
			embeddingModel: MODEL_A,
			chunkCount: 3,
		});
		h.points.set(page.id, {
			organizationId: ORG,
			sourceId: SOURCE,
			parentContextId: SOURCE,
			embeddingModel: MODEL_A,
		});

		const result = await embedUrlPageActivity(
			pageInput({ pageId: page.id, content: "  " }),
		);

		expect(result).toEqual({ success: true, chunkCount: 0 });
		expect(h.points.has(page.id)).toBe(false);
		expect(page).toMatchObject({
			extractionStatus: "COMPLETED",
			embeddedAt: null,
			embeddingModel: null,
			chunkCount: 0,
		});
		expect(h.rag.embedCompanyContext).not.toHaveBeenCalled();
	});

	it("leaves a failed page with no points and no index markers, and rethrows for a retry", async () => {
		const page = await seedPage({
			embeddedAt: new Date(),
			embeddingModel: MODEL_A,
		});
		h.rag.embedCompanyContext.mockImplementationOnce(async (options) => {
			// A partial write before the failure.
			h.points.set(options.contextId, {
				organizationId: ORG,
				sourceId: SOURCE,
				parentContextId: SOURCE,
				embeddingModel: MODEL_A,
			});
			return {
				success: false,
				error: "provider timeout",
				chunksCreated: 1,
			};
		});

		await expect(
			embedUrlPageActivity(pageInput({ pageId: page.id })),
		).rejects.toThrow("provider timeout");

		expect(h.points.has(page.id)).toBe(false);
		expect(page).toMatchObject({
			extractionStatus: "FAILED",
			extractionError: "provider timeout",
			embeddedAt: null,
			embeddingModel: null,
		});
	});

	it("removes the points it wrote when the page was deleted mid-embed", async () => {
		const page = await seedPage();
		h.rag.embedCompanyContext.mockImplementationOnce(async (options) => {
			h.points.set(options.contextId, {
				organizationId: ORG,
				sourceId: SOURCE,
				parentContextId: SOURCE,
				embeddingModel: MODEL_A,
			});
			h.pages.delete(page.id);
			return {
				success: true,
				qdrantId: "point-x",
				chunksCreated: 1,
				embeddingModel: MODEL_A,
			};
		});

		const result = await embedUrlPageActivity(
			pageInput({ pageId: page.id }),
		);

		expect(result).toEqual({ success: true, chunkCount: 0 });
		expect(h.points.has(page.id)).toBe(false);
	});
});

describe("upsertUrlPageActivity with a company owner", () => {
	const upsertInput = (over: Record<string, unknown> = {}) => ({
		parentContextId: SOURCE,
		pageUrl: PAGE_A,
		pageTitle: "A",
		content: "# A",
		userId: USER,
		organizationId: ORG,
		mode: "scheduled" as const,
		owner: OWNER,
		...over,
	});

	it("re-embeds an unchanged page when the model cannot be resolved", async () => {
		const page = await seedPage();
		await upsertUrlPageActivity(upsertInput());
		Object.assign(page, {
			embeddedAt: new Date(),
			embeddingModel: MODEL_A,
		});
		h.state.modelError = new Error("settings unavailable");

		const result = await upsertUrlPageActivity(upsertInput());

		expect(result).toMatchObject({
			pageId: page.id,
			skipped: false,
			reason: "embedding-model-changed",
		});
	});

	it("forces the content write on a manual re-sync", async () => {
		await seedPage();
		await upsertUrlPageActivity(upsertInput({ mode: "manual-resync" }));

		expect(h.queries.upsertCompanyContextUrlPage).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: ORG, force: true }),
		);
	});

	it("re-embeds an unchanged page that is not COMPLETED, though it holds vectors from the current model", async () => {
		const page = await seedPage();
		// The new content and its hash are stored and the page is PENDING,
		// but the crawl stopped before the embed: the vectors are the earlier
		// version's.
		await upsertUrlPageActivity(upsertInput());
		Object.assign(page, {
			extractionStatus: "PENDING",
			embeddedAt: new Date(),
			embeddingModel: MODEL_A,
		});

		const stale = await upsertUrlPageActivity(upsertInput());

		expect(stale).toMatchObject({
			pageId: page.id,
			skipped: false,
			reason: "not-embedded",
		});

		// Once the embed completes it, the same content is skipped.
		page.extractionStatus = "COMPLETED";
		const indexed = await upsertUrlPageActivity(upsertInput());

		expect(indexed).toMatchObject({
			pageId: page.id,
			skipped: true,
			reason: "hash-unchanged",
		});
	});
});

describe("pruneOrphanUrlPagesActivity with a company owner", () => {
	it("removes the orphans' points before their rows", async () => {
		const page = await seedPage();

		await pruneOrphanUrlPagesActivity({
			parentContextId: SOURCE,
			keptUrls: [PAGE_B],
			owner: OWNER,
		});

		expect(h.rag.deleteCompanyContextRowPoints).toHaveBeenCalledWith({
			organizationId: ORG,
			contextIds: [page.id],
		});
		expect(
			h.rag.deleteCompanyContextRowPoints.mock.invocationCallOrder[0],
		).toBeLessThan(
			h.queries.pruneCompanyContextUrlPages.mock.invocationCallOrder[0],
		);
		expect(h.pages.has(page.id)).toBe(false);
	});

	it("keeps the rows when their points cannot be removed, so the next crawl retries", async () => {
		const page = await seedPage();
		h.rag.deleteCompanyContextRowPoints.mockRejectedValueOnce(
			new Error("qdrant unavailable"),
		);

		const result = await pruneOrphanUrlPagesActivity({
			parentContextId: SOURCE,
			keptUrls: [PAGE_B],
			owner: OWNER,
		});

		expect(result).toEqual({ deletedCount: 0 });
		expect(h.pages.has(page.id)).toBe(true);
		expect(h.queries.pruneCompanyContextUrlPages).not.toHaveBeenCalled();
	});

	it("deletes nothing when the crawl returned no pages", async () => {
		const page = await seedPage();
		seedPoint(page.id, SOURCE);

		const result = await pruneOrphanUrlPagesActivity({
			parentContextId: SOURCE,
			keptUrls: [],
			owner: OWNER,
		});

		expect(result).toEqual({ deletedCount: 0 });
		expect(h.pages.has(page.id)).toBe(true);
		expect(h.points.has(page.id)).toBe(true);
		expect(h.rag.deleteCompanyContextRowPoints).not.toHaveBeenCalled();
		// The sweep still runs, against the rows that are there.
		expect(h.rag.deleteCompanyPagePointsNotIn).toHaveBeenCalledWith({
			organizationId: ORG,
			sourceId: SOURCE,
			livePageIds: [page.id],
		});
	});

	it("sweeps the points of a page whose row is gone on every prune, with no orphan row to prune, and nothing else", async () => {
		const page = await seedPage();
		seedPoint(page.id, SOURCE);
		// Left behind by an earlier prune whose cleanup failed.
		seedPoint("page-gone", SOURCE);
		// The website's own chunks, and another source's page.
		seedPoint(SOURCE, null);
		seedPoint("page-elsewhere", "src-other");

		const result = await pruneOrphanUrlPagesActivity({
			parentContextId: SOURCE,
			keptUrls: [PAGE_A],
			owner: OWNER,
		});

		expect(result).toEqual({ deletedCount: 0 });
		expect(h.queries.pruneCompanyContextUrlPages).not.toHaveBeenCalled();
		expect(h.points.has("page-gone")).toBe(false);
		expect(h.points.has(page.id)).toBe(true);
		expect(h.points.has(SOURCE)).toBe(true);
		expect(h.points.has("page-elsewhere")).toBe(true);
		// Scoped to the owner's organization: the rows it reads and the
		// points it deletes.
		expect(h.queries.listCompanyContextUrlPages).toHaveBeenCalledWith(
			SOURCE,
			ORG,
		);
		expect(h.rag.deleteCompanyPagePointsNotIn).toHaveBeenCalledWith({
			organizationId: ORG,
			sourceId: SOURCE,
			livePageIds: [page.id],
		});
	});

	it("a vector store that fails after the row prune still reports the pruned rows, and the next prune removes what was left", async () => {
		const orphan = await seedPage();
		seedPoint(orphan.id, SOURCE);
		// Every point delete fails from the row prune on, until the next crawl.
		let storeDown = false;
		const rowPoints =
			h.rag.deleteCompanyContextRowPoints.getMockImplementation();
		const pagePoints =
			h.rag.deleteCompanyPagePointsNotIn.getMockImplementation();
		const prunePages =
			h.queries.pruneCompanyContextUrlPages.getMockImplementation();
		if (!rowPoints || !pagePoints || !prunePages) {
			throw new Error("harness implementations missing");
		}
		h.rag.deleteCompanyContextRowPoints.mockImplementation(async (args) => {
			if (storeDown) {
				throw new Error("qdrant unavailable");
			}
			return rowPoints(args);
		});
		h.rag.deleteCompanyPagePointsNotIn.mockImplementation(async (args) => {
			if (storeDown) {
				throw new Error("qdrant unavailable");
			}
			return pagePoints(args);
		});
		// A page created after the orphans were read is pruned with them.
		h.queries.pruneCompanyContextUrlPages.mockImplementationOnce(
			async (args) => {
				await h.queries.createCompanyContextUrlPages({
					parentSourceId: SOURCE,
					organizationId: ORG,
					pageUrls: [PAGE_C],
				});
				const late = pageByUrl(PAGE_C);
				if (late) {
					seedPoint(late.id, SOURCE);
				}
				const pruned = await prunePages(args);
				storeDown = true;
				return pruned;
			},
		);

		try {
			const first = await pruneOrphanUrlPagesActivity({
				parentContextId: SOURCE,
				keptUrls: [PAGE_B],
				owner: OWNER,
			});

			expect(first).toEqual({ deletedCount: 2 });
			expect(h.pages.size).toBe(0);
			expect(h.points.has(orphan.id)).toBe(false);
			// The late page's points outlived its row.
			expect(h.points.size).toBe(1);

			// The next crawl's prune, with no row left to prune.
			storeDown = false;
			const second = await pruneOrphanUrlPagesActivity({
				parentContextId: SOURCE,
				keptUrls: [PAGE_B],
				owner: OWNER,
			});

			expect(second).toEqual({ deletedCount: 0 });
			expect(h.points.size).toBe(0);
		} finally {
			h.rag.deleteCompanyContextRowPoints.mockImplementation(rowPoints);
			h.rag.deleteCompanyPagePointsNotIn.mockImplementation(pagePoints);
		}
	});
});

/** A point written from row `contextId`, under `parentContextId` for a page. */
function seedPoint(contextId: string, parentContextId: string | null) {
	h.points.set(contextId, {
		organizationId: ORG,
		sourceId: parentContextId ?? contextId,
		parentContextId,
		embeddingModel: MODEL_A,
	});
}

/** Run the finalize as the crawl `workflowId` would, inside an activity context. */
function finalizeAs(
	workflowId: string,
	input: Parameters<typeof updateParentStatusActivity>[0],
) {
	return new MockActivityEnvironment({
		workflowExecution: { workflowId, runId: `${workflowId}-run` },
	}).run(updateParentStatusActivity, input);
}

describe("updateParentStatusActivity with a company owner", () => {
	it("fails a multi-page finalize whose model cannot index the source", async () => {
		seedLinkSource();
		h.state.model = {
			identity: "X:big",
			dimensions: 3072,
			supported: false,
		};

		await finalizeAs("wf-1", {
			contextId: SOURCE,
			extractionStatus: "COMPLETED",
			urlLastSyncedAt: new Date(),
			owner: OWNER,
		});

		const source = h.sources.get(SOURCE);
		expect(source?.extractionStatus).toBe("FAILED");
		expect(source?.extractionError).toBe(
			"Unsupported embedding model: X:big",
		);
		expect(source?.embeddedAt).toBeNull();
		expect(h.projectOnly.emitCompletionNotification).not.toHaveBeenCalled();
	});

	it("records a failure without resolving the model", async () => {
		seedLinkSource({ urlActiveWorkflowId: "wf-1" });

		await finalizeAs("wf-1", {
			contextId: SOURCE,
			extractionStatus: "FAILED",
			extractionError: "Firecrawl returned 429",
			urlLastSyncedAt: null,
			urlNextRefreshAt: null,
			owner: OWNER,
			projectId: undefined,
			sourceUrl: SITE,
		});

		const source = h.sources.get(SOURCE);
		expect(source?.extractionStatus).toBe("FAILED");
		expect(source?.extractionError).toBe("Firecrawl returned 429");
		expect(source?.urlActiveWorkflowId).toBeNull();
		expect(h.rag.resolveCompanyEmbeddingModel).not.toHaveBeenCalled();
		expectNoProjectCalls();
	});

	it("does nothing to another organization's source", async () => {
		seedLinkSource({
			organizationId: OTHER_ORG,
			urlActiveWorkflowId: "wf-1",
		});

		const result = await finalizeAs("wf-1", {
			contextId: SOURCE,
			extractionStatus: "COMPLETED",
			owner: OWNER,
		});

		expect(result).toEqual({ success: true });
		expect(h.sources.get(SOURCE)).toMatchObject({
			extractionStatus: "EXTRACTING",
			urlActiveWorkflowId: "wf-1",
			embeddedAt: null,
		});
	});

	it("leaves a source another crawl holds untouched: no status, no freed slot, no settled pages", async () => {
		seedLinkSource({ urlActiveWorkflowId: "url-crawl-src-1-resync-2" });
		await h.queries.createCompanyContextUrlPages({
			parentSourceId: SOURCE,
			organizationId: ORG,
			pageUrls: [PAGE_A],
		});
		const before = JSON.stringify([
			...h.sources.values(),
			...h.pages.values(),
		]);

		for (const extractionStatus of ["COMPLETED", "FAILED"] as const) {
			const result = await finalizeAs("url-crawl-src-1-scheduled", {
				contextId: SOURCE,
				extractionStatus,
				extractionError: extractionStatus === "FAILED" ? "boom" : null,
				urlLastSyncedAt: new Date(),
				owner: OWNER,
			});
			expect(result).toEqual({ success: true });
		}

		expect(
			JSON.stringify([...h.sources.values(), ...h.pages.values()]),
		).toBe(before);
		expect(h.queries.finalizeCompanyLinkSourceCrawl).not.toHaveBeenCalled();
	});

	it("keeps a COMPLETED, embedded source COMPLETED when a refresh is cancelled before it indexed anything", async () => {
		const syncedAt = new Date("2026-09-01T00:00:00.000Z");
		seedLinkSource({
			extractionStatus: "COMPLETED",
			embeddedAt: new Date(),
			embeddingModel: MODEL_A,
			urlActiveWorkflowId: "wf-1",
			urlLastSyncedAt: syncedAt,
		});

		await finalizeAs("wf-1", {
			contextId: SOURCE,
			extractionStatus: "CANCELLED",
			extractionError: null,
			urlLastSyncedAt: null,
			urlNextRefreshAt: new Date("2026-10-07T00:00:00.000Z"),
			owner: OWNER,
		});

		expect(h.sources.get(SOURCE)).toMatchObject({
			extractionStatus: "COMPLETED",
			embeddingModel: MODEL_A,
			urlLastSyncedAt: syncedAt,
			urlNextRefreshAt: new Date("2026-10-07T00:00:00.000Z"),
			urlActiveWorkflowId: null,
		});
		expect(isReady(SOURCE, MODEL_A)).toBe(true);
	});
});

describe("updateParentStatusActivity with a company owner, on a website that was ready", () => {
	it("records only why when a scheduled refresh COMPLETED under a model that cannot index it", async () => {
		const syncedAt = new Date("2026-09-01T00:00:00.000Z");
		seedLinkSource({
			extractionStatus: "COMPLETED",
			embeddedAt: new Date(),
			embeddingModel: MODEL_A,
			urlActiveWorkflowId: "wf-1",
			urlLastSyncedAt: syncedAt,
		});
		await h.queries.createCompanyContextUrlPages({
			parentSourceId: SOURCE,
			organizationId: ORG,
			pageUrls: [PAGE_A],
		});
		Object.assign(pageByUrl(PAGE_A) ?? {}, {
			extractionStatus: "COMPLETED",
			embeddedAt: new Date(),
			embeddingModel: MODEL_A,
		});
		h.state.model = {
			identity: "X:big",
			dimensions: 3072,
			supported: false,
		};

		await finalizeAs("wf-1", {
			contextId: SOURCE,
			extractionStatus: "COMPLETED",
			urlLastSyncedAt: new Date("2026-09-30T00:00:00.000Z"),
			urlNextRefreshAt: new Date("2026-10-07T00:00:00.000Z"),
			owner: OWNER,
		});

		expect(h.sources.get(SOURCE)).toMatchObject({
			extractionStatus: "COMPLETED",
			extractionError: "Unsupported embedding model: X:big",
			embeddingModel: MODEL_A,
			urlLastSyncedAt: syncedAt,
			urlNextRefreshAt: new Date("2026-10-07T00:00:00.000Z"),
			urlActiveWorkflowId: null,
		});
		// Searchable again once the model is switched back.
		expect(isReady(SOURCE, MODEL_A)).toBe(true);
	});

	it("keeps its mark and stays ready when the refresh left a page with the current model's vectors", async () => {
		seedLinkSource({
			extractionStatus: "COMPLETED",
			embeddedAt: new Date(),
			embeddingModel: MODEL_A,
			urlActiveWorkflowId: "wf-1",
		});
		await h.queries.createCompanyContextUrlPages({
			parentSourceId: SOURCE,
			organizationId: ORG,
			pageUrls: [PAGE_A, PAGE_B],
		});
		// A kept its vectors; B's re-embed failed and took its points.
		Object.assign(pageByUrl(PAGE_A) ?? {}, {
			extractionStatus: "COMPLETED",
			embeddedAt: new Date(),
			embeddingModel: MODEL_A,
		});
		Object.assign(pageByUrl(PAGE_B) ?? {}, {
			extractionStatus: "FAILED",
			extractionError: "embedding key revoked",
		});

		await finalizeAs("wf-1", {
			contextId: SOURCE,
			extractionStatus: "COMPLETED",
			extractionError: null,
			urlLastSyncedAt: new Date(),
			owner: OWNER,
		});

		expect(
			h.queries.countCompanyContextUrlPagesEmbeddedWith,
		).toHaveBeenCalledWith({
			parentSourceId: SOURCE,
			organizationId: ORG,
			embeddingModel: MODEL_A,
		});
		expect(h.sources.get(SOURCE)).toMatchObject({
			extractionStatus: "COMPLETED",
			extractionError: null,
			embeddingModel: MODEL_A,
		});
		expect(isReady(SOURCE, MODEL_A)).toBe(true);
	});
});

describe("bulkInitUrlPagesActivity with a company owner", () => {
	it("creates PENDING company pages under the owner's organization", async () => {
		seedLinkSource();

		const result = await bulkInitUrlPagesActivity({
			parentContextId: SOURCE,
			urls: [PAGE_A, PAGE_B],
			userId: USER,
			organizationId: ORG,
			owner: OWNER,
		});

		expect(result).toEqual({
			totalCount: 2,
			createdCount: 2,
			existingCount: 0,
		});
		expect(h.queries.createCompanyContextUrlPages).toHaveBeenCalledWith({
			parentSourceId: SOURCE,
			organizationId: ORG,
			pageUrls: [PAGE_A, PAGE_B],
		});
		expect(pageByUrl(PAGE_A)?.extractionStatus).toBe("PENDING");
		expectNoProjectCalls();
	});

	it("refuses an owner whose organization is not the input's", async () => {
		await expect(
			bulkInitUrlPagesActivity({
				parentContextId: SOURCE,
				urls: [PAGE_A],
				userId: USER,
				organizationId: OTHER_ORG,
				owner: OWNER,
			}),
		).rejects.toMatchObject({ type: CONTEXT_OWNER_INVALID });
		expect(h.queries.createCompanyContextUrlPages).not.toHaveBeenCalled();
	});
});
