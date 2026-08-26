/**
 * updateUrlSource — URL Context Sources.
 *
 * Edits scope / maxPages / refreshMode / label on an existing LINK
 * context. Does NOT trigger a re-crawl — that's `resyncUrlSource`'s job.
 *
 * Schedule lifecycle (DAILY / WEEKLY / MONTHLY): when the cadence flips
 * into, out of, or between scheduled modes we route through the
 * `updateUrlSourceSchedule` helper which wraps `ScheduleClient` from
 * `packages/temporal/src/schedules/url-source-schedule.ts`. Switching INTO
 * a scheduled mode requires a Firecrawl API key — the activity sandbox
 * can't reach the credential store at fire-time, so the schedule's args
 * embed the decrypted key. Missing key on switch-in surfaces as a typed
 * BAD_REQUEST with the same `FIRECRAWL_NOT_CONFIGURED` payload the dialog
 * already consumes.
 */
import { ORPCError } from "@orpc/server";
import {
	db,
	getContextById,
	getSearchProviderConfig,
	hasProjectAccess,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	cadenceNextFireUtc,
	getScheduleClient,
	isScheduledMode,
	MissingFirecrawlKeyError,
	updateUrlSourceSchedule,
} from "@repo/temporal";
import { decryptApiKey } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	assertKnowledgeBaseCategoryIsDescribed,
	knowledgeBaseCategoryInputFields,
} from "./knowledge-base-category";

const URL_SCOPE_VALUES = ["SINGLE_PAGE", "PATH_PREFIX"] as const;
const URL_REFRESH_MODE_VALUES = [
	"ONCE",
	"DAILY",
	"WEEKLY",
	"MONTHLY",
	"LIVE",
] as const;

type UrlRefreshMode = (typeof URL_REFRESH_MODE_VALUES)[number];
type UrlSourceScope = (typeof URL_SCOPE_VALUES)[number];

// Aligned with `process-context-link.ts` — see that file for the rationale.
// 500 upper bound is tuned to the worker's concurrency-1 wall clock; 200
// default keeps Firecrawl spend low on the common case.
const MIN_MAX_PAGES = 1;
const MAX_MAX_PAGES = 500;
const DEFAULT_MAX_PAGES = 200;

interface FirecrawlNotConfiguredData {
	code: "FIRECRAWL_NOT_CONFIGURED";
	settingsPath: string;
}

function buildFirecrawlSettingsPath(orgSlug: string | null): string {
	return orgSlug
		? `/app/${orgSlug}/settings/search-providers`
		: "/app/settings/search-providers";
}

async function resolveFirecrawlApiKey(args: {
	userId: string;
	organizationId: string | undefined;
}): Promise<string | null> {
	const config = await getSearchProviderConfig({
		userId: args.userId,
		organizationId: args.organizationId,
		providerName: "firecrawl",
	});
	if (!config || !config.enabled || !config.encryptedApiKey) {
		return null;
	}
	try {
		return decryptApiKey(config.encryptedApiKey);
	} catch (error) {
		logger.error(
			`[UpdateUrlSource] Failed to decrypt Firecrawl key: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return null;
	}
}

async function buildFirecrawlNotConfiguredError(args: {
	organizationId: string | undefined;
}): Promise<ORPCError<"BAD_REQUEST", FirecrawlNotConfiguredData>> {
	let orgSlug: string | null = null;
	if (args.organizationId) {
		const org = await db.organization.findUnique({
			where: { id: args.organizationId },
			select: { slug: true },
		});
		orgSlug = org?.slug ?? null;
	}
	const data: FirecrawlNotConfiguredData = {
		code: "FIRECRAWL_NOT_CONFIGURED",
		settingsPath: buildFirecrawlSettingsPath(orgSlug),
	};
	return new ORPCError("BAD_REQUEST", {
		message:
			"URL sources need a Firecrawl API key. Configure it in Settings → Search Providers to enable scheduled re-syncs.",
		data,
	});
}

export const updateUrlSourceProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.CONTEXT_UPDATE))
	.route({
		method: "PATCH",
		path: "/projects/:projectId/contexts/:contextId/url-source",
		tags: ["Projects", "Contexts"],
		summary: "Update URL context source settings",
		description:
			"Edit scope, maxPages, refreshMode, or label on an existing URL context. Does not trigger a re-crawl. Rotates the Temporal Schedule when the cadence changes.",
	})
	.input(
		z.object({
			contextId: z.string(),
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			label: z.string().max(120).optional(),
			scope: z.enum(URL_SCOPE_VALUES).optional(),
			maxPages: z
				.number()
				.int()
				.min(MIN_MAX_PAGES)
				.max(MAX_MAX_PAGES)
				.optional(),
			refreshMode: z.enum(URL_REFRESH_MODE_VALUES).optional(),
			/**
			 * Classify a link that predates the category (Fizzy #2165).
			 *
			 * Link sources created before the classification existed have none,
			 * and there is no backfill — guessing one would report readiness the
			 * project has not earned. Without an edit path the only way to label
			 * an already-indexed source was to delete it and crawl it again,
			 * paying for a scrape to record a value the person already knows.
			 * Setting it here changes classification only; it does not re-crawl.
			 */
			...knowledgeBaseCategoryInputFields,
		}),
	)
	.handler(async ({ input, context }) => {
		assertKnowledgeBaseCategoryIsDescribed(input);

		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Project access — required because permission middleware only
		// checks the permission token, not membership XOR.
		const hasAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// Tenant + IDOR guard: fetch the parent row inside the XOR filter
		// so a personal-context user can't address an org row by id.
		const existing = await getContextById(
			input.contextId,
			input.projectId,
			{
				userId: user.id,
				organizationId: organizationId ?? null,
			},
		);
		if (!existing) {
			throw new ORPCError("NOT_FOUND", {
				message: "URL context not found",
			});
		}
		if (existing.type !== "LINK") {
			throw new ORPCError("BAD_REQUEST", {
				message: "Only LINK contexts can be updated as URL sources",
			});
		}
		if (!existing.sourceUrl) {
			throw new ORPCError("BAD_REQUEST", {
				message: "URL context has no sourceUrl",
			});
		}

		// Lock-while-crawling guard. The UI hides the Settings inputs and
		// Save button while the row is in PENDING/EXTRACTING, but a stale
		// tab (or a concurrent request from another user in the same org)
		// could still hit this endpoint. Mid-crawl edits to scope/maxPages
		// would race against the in-flight workflow's read of those fields
		// — the cleanest contract is to require the user to wait or cancel
		// before editing.
		if (
			existing.extractionStatus === "PENDING" ||
			existing.extractionStatus === "EXTRACTING"
		) {
			throw new ORPCError("CONFLICT", {
				message:
					"Processing is currently running for this URL source. Wait for it to finish or cancel it before editing settings.",
			});
		}

		// Build the patch from only the fields the caller supplied. Sending
		// `undefined` to Prisma is a no-op, but being explicit keeps the
		// diff readable in audit logs.
		const data: Parameters<typeof db.projectContext.update>[0]["data"] = {};

		if (input.label !== undefined) {
			data.sourceTitle = input.label;
		}
		if (input.scope !== undefined) {
			data.urlScope = input.scope;
			// PATH_PREFIX without an explicit maxPages keeps the existing
			// value; SINGLE_PAGE wipes maxPages because it's meaningless.
			if (input.scope === "SINGLE_PAGE" && input.maxPages === undefined) {
				data.urlMaxPages = null;
			}
		}
		if (input.maxPages !== undefined) {
			data.urlMaxPages = input.maxPages;
		}
		if (input.knowledgeBaseSourceCategory !== undefined) {
			data.knowledgeBaseSourceCategory =
				input.knowledgeBaseSourceCategory;
			// The free-text half only means anything alongside OTHER, and the
			// assert above has already refused OTHER without it. Clearing it on
			// every other category stops a stale description outliving the
			// choice it described.
			data.knowledgeBaseSourceCategoryOther =
				input.knowledgeBaseSourceCategory === "OTHER"
					? (input.knowledgeBaseSourceCategoryOther?.trim() ?? null)
					: null;
		}

		// Cadence change → maybe rotate the Temporal schedule. We call the
		// helper for every transition (it no-ops internally when nothing to
		// do) so the action label stays observable in the response.
		let scheduleAction: "created" | "updated" | "deleted" | "noop" = "noop";
		let nextScheduleId: string | null = existing.urlScheduleId ?? null;

		if (input.refreshMode !== undefined) {
			data.urlRefreshMode = input.refreshMode;

			const oldMode = (existing.urlRefreshMode ??
				null) as UrlRefreshMode | null;
			const newMode: UrlRefreshMode = input.refreshMode;
			const cadenceChanged = oldMode !== newMode;
			const touchesSchedule =
				isScheduledMode(oldMode) || isScheduledMode(newMode);

			// Recompute `urlNextRefreshAt` on every cadence change so the
			// Details sidebar reflects the new schedule before the workflow
			// fires next. `cadenceNextFireUtc` returns `null` for
			// ONCE/LIVE, which is exactly the value we want stamped when
			// switching out of a scheduled mode (clears the column).
			if (cadenceChanged) {
				data.urlNextRefreshAt = cadenceNextFireUtc(newMode, new Date());
			}

			if (cadenceChanged && touchesSchedule) {
				// Compose the schedule args from the merged future state of
				// the row (caller's overrides + existing values).
				const effectiveScope: UrlSourceScope = (input.scope ??
					existing.urlScope ??
					"SINGLE_PAGE") as UrlSourceScope;
				const effectiveMaxPages =
					input.maxPages ?? existing.urlMaxPages ?? DEFAULT_MAX_PAGES;

				// Resolve the Firecrawl key only when we're going to need
				// it (switching INTO a scheduled mode). The delete path
				// doesn't need it.
				let apiKey: string | null = null;
				if (isScheduledMode(newMode)) {
					apiKey = await resolveFirecrawlApiKey({
						userId: user.id,
						organizationId,
					});
					if (!apiKey) {
						throw await buildFirecrawlNotConfiguredError({
							organizationId,
						});
					}
				}

				try {
					const scheduleClient = await getScheduleClient();
					const result = await updateUrlSourceSchedule(
						{
							contextId: existing.id,
							oldRefreshMode: oldMode,
							newRefreshMode: newMode,
							url: existing.sourceUrl,
							scope: effectiveScope,
							maxPages: effectiveMaxPages,
							projectId: input.projectId,
							userId: user.id,
							organizationId: organizationId ?? null,
							parentSourceTitle:
								input.label ?? existing.sourceTitle ?? null,
							apiKey,
						},
						scheduleClient,
					);
					nextScheduleId = result.scheduleId;
					scheduleAction = result.action;
					data.urlScheduleId = nextScheduleId;
				} catch (error) {
					if (error instanceof MissingFirecrawlKeyError) {
						// Defensive — we already checked above, but the
						// helper enforces the invariant too.
						throw await buildFirecrawlNotConfiguredError({
							organizationId,
						});
					}
					const message =
						error instanceof Error ? error.message : String(error);
					logger.error(
						`[UpdateUrlSource] Schedule rotation failed for ${existing.id}: ${message}`,
					);
					throw new ORPCError("INTERNAL_SERVER_ERROR", {
						message: `Failed to update schedule: ${message}`,
					});
				}
			}
		}

		// Persist. If the patch is empty (caller passed contextId only) we
		// still return the existing row so the UI's optimistic update
		// resolves cleanly.
		const updated =
			Object.keys(data).length > 0
				? await db.projectContext.update({
						where: { id: existing.id },
						data,
						select: {
							id: true,
							sourceTitle: true,
							urlScope: true,
							urlMaxPages: true,
							urlRefreshMode: true,
							urlScheduleId: true,
							knowledgeBaseSourceCategory: true,
							knowledgeBaseSourceCategoryOther: true,
						},
					})
				: {
						id: existing.id,
						sourceTitle: existing.sourceTitle,
						urlScope: existing.urlScope,
						urlMaxPages: existing.urlMaxPages,
						urlRefreshMode: existing.urlRefreshMode,
						urlScheduleId: existing.urlScheduleId,
						knowledgeBaseSourceCategory:
							existing.knowledgeBaseSourceCategory,
						knowledgeBaseSourceCategoryOther:
							existing.knowledgeBaseSourceCategoryOther,
					};

		return {
			contextId: updated.id,
			label: updated.sourceTitle,
			scope: updated.urlScope,
			maxPages: updated.urlMaxPages,
			refreshMode: updated.urlRefreshMode,
			urlScheduleId: updated.urlScheduleId,
			knowledgeBaseSourceCategory: updated.knowledgeBaseSourceCategory,
			knowledgeBaseSourceCategoryOther:
				updated.knowledgeBaseSourceCategoryOther,
			scheduleAction,
			// Preserved for back-compat with Group 3's response contract —
			// tests + UI both already key off `scheduleRotated`.
			scheduleRotated: scheduleAction !== "noop",
		};
	});
