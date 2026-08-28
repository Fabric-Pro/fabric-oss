/**
 * `projects.contexts.createBatchDownloadUrl` — stream all contexts for a
 * project into a single ZIP and return a presigned GET URL.
 *
 * See spec §6.2, §4.6, §4.7, §8.1, §10, §11 in
 * `docs/specs/2026-04-15-download-project-context-files/spec.md`.
 *
 * Streaming model:
 *   archiver (Readable) → putObjectStream (lib-storage Upload, multipart)
 *
 * The procedure never buffers the full archive in memory. Per-file read
 * failures are caught and recorded in the MANIFEST's SKIPPED section — they
 * do not abort the archive. The MANIFEST is always the last entry appended.
 *
 * What gets in: a context is exported whenever there is something to export —
 * a storage location (Class A) or non-empty content (Class B/C). Extraction
 * status never withholds a row (Fizzy #2228); where it has not reached
 * `COMPLETED` the MANIFEST's INCLUDED row is annotated instead, so a partial
 * extraction ships with a caveat rather than vanishing from the archive.
 *
 * "Non-empty content" is not the same as a non-empty `content` column. Two
 * shapes park their text in child rows and leave the parent empty — a
 * `PATH_PREFIX` LINK's crawled pages, and a monitored Teams / Slack channel's
 * captured conversation bundles. Both are assembled before streaming begins
 * and weighed as they are assembled, so they are weighed and written as the
 * text they actually are rather than as zero bytes and a skip line
 * (Fizzy #2228).
 *
 * Two byte counts, deliberately kept apart (Fizzy #2228):
 *   - a pre-flight ESTIMATE over the rows this build intends to write, taken
 *     before a single byte streams. It exists only to gate
 *     `MAX_BATCH_DOWNLOAD_BYTES`, and it is an estimate because Class A
 *     contributes its recorded `fileSize` rather than a measured read. It is
 *     accumulated as the build is weighed rather than summed at the end: the
 *     child assemblies materialise text, so a project that must be refused for
 *     size would otherwise allocate all of it before the ceiling looked. Rows
 *     that need no query are weighed first, and the assemblies stop as soon as
 *     the running total is past the ceiling.
 *   - an ACCUMULATOR incremented as each entry is actually appended. This is
 *     what the MANIFEST's `Total size` reports, so an item that fails its
 *     storage read half-way through the loop leaves the total untouched.
 * Reporting the estimate as the archive's size is the defect this replaces.
 *
 * A build that cannot hand back a URL deletes the object it had already
 * uploaded. The archive streams into storage concurrently with the writes by
 * necessity, so EVERY exit past the first appended entry — a manifest build
 * that throws, a rejected `finalize()`, a rejected upload, the archiver's own
 * fatal error, a rejected presign — leaves a truncated object nobody will ever
 * be given a URL for; `downloads/project-contexts/…` has no expiry rule that
 * can be relied on to collect it, and since this branch it can hold captured
 * conversation text. One guarded region over manifest/finalize/upload/presign
 * is what makes that true of all five exits rather than only the one that sets
 * `fatalError`.
 *
 * What gets left out, and why: every skip — a row with nothing stored, a
 * terminally failed extraction, a linked conversation with nothing captured,
 * a crawl that indexed no pages, an object the store could not produce, and
 * the rows the item ceiling cut — is classified by the pure taxonomy in
 * `../../lib/context-skip-reason`. The MANIFEST prints its rendered line per
 * row and the response carries its per-reason counts, both from the one list
 * this handler builds, so the archive and the in-app summary cannot diverge.
 * The single blended sentence they replace called a deliberate truncation and
 * a dead extraction alike "still processing or unavailable" (Fizzy #2228).
 *
 * Ceilings: the item ceiling truncates and declares — rows past
 * `MAX_BATCH_DOWNLOAD_CONTEXTS` get one MANIFEST skip line each and the
 * archive still ships, since count rather than weight is what blocks large
 * projects and refusing the whole export is the least honest failure
 * available. The size ceiling stays a refusal: an archive that cannot be built
 * is not the same as one deliberately partial.
 *
 * Tenant isolation: enforced at the procedure boundary
 * (`tenantProtectedProcedure`, `requireProjectPermission(CONTEXT_READ)`,
 * `verifyOrganizationMembership` for org context) and on the project lookup
 * (`getProjectForDownload`, which applies the XOR filter on userId +
 * organizationId). Once the project is resolved under the tenant's scope,
 * the context listing is project-scoped.
 */

import { randomUUID } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import { ORPCError } from "@orpc/server";
import { config } from "@repo/config";
import {
	type ConversationCaptureTenant,
	getCapturedConversationMarkdown,
	getProjectForDownload,
	listContextsForDownload,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	deleteObjects,
	getObjectStream,
	getSignedUrl,
	putObjectStream,
} from "@repo/storage";
import archiver from "archiver";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";
import { buildContextTextPayload } from "../../lib/build-context-text-payload";
import {
	classifyContext,
	dedupeFilename,
} from "../../lib/context-classification";
import { contextDownloadFilename } from "../../lib/context-download-filename";
import {
	buildContextDownloadManifest,
	type ManifestIncludedRow,
	type ManifestSkippedRow,
} from "../../lib/context-download-manifest";
import {
	type ContextSkipReason,
	countContextSkipReasons,
	deriveContextSkipReason,
	deriveStorageErrorSkipReason,
	describeContextSkipReason,
} from "../../lib/context-skip-reason";
import {
	buildPathPrefixMarkdown,
	type ContextTenantFilter,
	isPathPrefixLink,
} from "../../lib/path-prefix-link-markdown";
import {
	BATCH_PRESIGN_EXPIRY_SECONDS,
	MAX_BATCH_DOWNLOAD_BYTES,
	MAX_BATCH_DOWNLOAD_CONTEXTS,
} from "./constants";

// ---------------------------------------------------------------------------
// Zod input / output — spec §6.2
// ---------------------------------------------------------------------------

const createContextsBatchDownloadUrlInput = z.object({
	projectId: z.string().min(1),
	organizationId: z.string().nullable().optional(),
});

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Slugify a free-text name for the outer ZIP filename. Mirrors spec §4.3. */
function slugifyProjectName(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "project";
}

/** Format a Date as `YYYY-MM-DD` in UTC. */
function utcDateStamp(date: Date): string {
	return date.toISOString().slice(0, 10);
}

/**
 * Pick the in-ZIP subfolder for a context entry. Mirrors spec §4.4:
 *   - Class A (FILE/IMAGE/DOCUMENT/SPREADSHEET) → `files/`
 *   - Class C (CODE_FILE/CODE_FILE_SUMMARY)     → `code/`
 *   - Class B LINK                              → `links/`
 *   - Class B MEETING_TRANSCRIPT                → `transcripts/`
 *   - Class B INTEGRATION                       → `integrations/{provider}/`
 *   - Class B TEXT / planning surfaces          → `notes/`
 */
function resolveSubfolder(
	klass: "A" | "B" | "C",
	type: string,
	integration: string | null,
): string {
	if (klass === "A") {
		return "files";
	}
	if (klass === "C") {
		return "code";
	}
	if (type === "LINK") {
		return "links";
	}
	if (type === "MEETING_TRANSCRIPT") {
		return "transcripts";
	}
	if (type === "INTEGRATION") {
		const provider = integration
			? integration
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, "-")
					.replace(/^-+|-+$/g, "")
			: "";
		return provider ? `integrations/${provider}` : "integrations";
	}
	return "notes";
}

interface ContextRow {
	id: string;
	type: string;
	content: string | null;
	s3Path: string | null;
	s3Bucket: string | null;
	originalFilename: string | null;
	mimeType: string | null;
	fileSize: number | null;
	sourceTitle: string | null;
	sourceUrl: string | null;
	/**
	 * Nullable on purpose: free-text contexts never run extraction, and older
	 * rows predate the column's default. Absent means "nothing to report",
	 * never "not ready".
	 *
	 * `urlScope === "PATH_PREFIX"` marks a crawled LINK whose markdown lives in
	 * child `ProjectContextUrlPage` rows rather than on `content`. Selected by
	 * `listContextsForDownload` so the loop below can tell a crawl apart from
	 * an empty row.
	 */
	extractionStatus: string | null;
	urlScope: string | null;
	metadata: unknown;
	createdAt: Date;
}

/** The one extraction state in which stored text is known to be final. */
const EXTRACTION_COMPLETE = "COMPLETED";

/**
 * Manifest annotation for a text-bearing row whose extraction never reached
 * `COMPLETED` — queued, mid-flight, failed or cancelled. The row is exported
 * regardless (Fizzy #2228: the text Fabric holds beats no text at all), so
 * the manifest has to say the text may fall short of its source.
 *
 * Rendered into the trailing FILE IN ZIP column, which is free-width, so the
 * manifest's fixed 3 / 14 / 40 / rest column layout is untouched.
 */
function extractionAnnotation(status: string | null): string {
	if (!status || status === EXTRACTION_COMPLETE) {
		return "";
	}
	return `  (extraction ${status} — text may be incomplete)`;
}

/** Extract a display title from metadata → sourceTitle → originalFilename. */
function resolveTitle(ctx: ContextRow): string {
	const meta = (ctx.metadata ?? {}) as Record<string, unknown>;
	const metaTitle = typeof meta.title === "string" ? meta.title : null;
	return (
		metaTitle ||
		ctx.sourceTitle ||
		ctx.originalFilename ||
		`context-${ctx.id}`
	);
}

/** Extract an integration provider slug, if any, from metadata. */
function resolveIntegrationProvider(ctx: ContextRow): string | null {
	const meta = (ctx.metadata ?? {}) as Record<string, unknown>;
	const provider = meta.provider ?? meta.integrationProvider ?? null;
	return typeof provider === "string" ? provider : null;
}

/**
 * Source bytes one row contributes. Class A contributes its recorded
 * `fileSize` — the object is streamed straight through, so its true length is
 * only knowable by reading it, which is exactly what the pre-flight must not
 * do. Class B/C contribute the UTF-8 byte length of the text that will be
 * written, which for a crawled LINK is the markdown assembled from its
 * children rather than the empty parent `content`.
 *
 * One function serves both counts on purpose: the estimate and the
 * accumulator differ in WHICH rows they add up, never in how a row is
 * measured, so the two numbers stay comparable.
 */
function sourceBytesFor(
	ctx: ContextRow,
	klass: "A" | "B" | "C",
	entryContent: string,
): number {
	if (klass === "A") {
		return ctx.fileSize ?? 0;
	}
	return Buffer.byteLength(entryContent, "utf8");
}

/**
 * How many child-row assemblies run at once — crawled links and captured
 * conversations alike. Each is one child query, and a project may hold up to
 * the item ceiling of either shape; an unbounded fan-out would put hundreds of
 * concurrent queries on the connection pool this request shares with every
 * other caller. Matches the cap the bulk test-case side effects use.
 *
 * One cap serves both passes because they run one after the other, never at
 * the same time, so the number in flight is bounded by this alone.
 */
const CHILD_ASSEMBLY_CONCURRENCY = 8;

/**
 * Run `fn` over `items` with at most `limit` in flight, in list order, until
 * the list is exhausted or `shouldStop` says to give up on the rest.
 *
 * A local copy of the shape in `test-cases/bulk-mutate-test-cases`, not a
 * shared import: the two are a handful of lines of scheduling with different
 * failure contracts (that one swallows per-item rejections, `fn` here records
 * them), and a shared utility would have to grow a policy argument to serve
 * both.
 *
 * `shouldStop` is consulted BEFORE each item is taken, never after, so the work
 * it refuses is work that never happened. Stopping resolves normally rather
 * than rejecting: the caller — the size ceiling — wants the partial result and
 * its own error, not a rejection from inside the scheduler. Items already in
 * flight still finish, so the number that runs past the point of no return is
 * bounded by `limit`.
 */
async function mapWithConcurrency<T>(
	items: ReadonlyArray<T>,
	limit: number,
	fn: (item: T) => Promise<void>,
	shouldStop?: () => boolean,
): Promise<void> {
	let cursor = 0;
	const workers = Array.from(
		{ length: Math.min(limit, items.length) },
		async () => {
			while (cursor < items.length) {
				if (shouldStop?.()) {
					return;
				}
				const item = items[cursor++];
				await fn(item);
			}
		},
	);
	await Promise.all(workers);
}

/**
 * The running weight of the build, in the bytes `MAX_BATCH_DOWNLOAD_BYTES` is
 * expressed in.
 *
 * Mutable and shared by the on-row pre-pass and both child assemblies, because
 * the ceiling has to be able to stop the assemblies rather than judge them
 * afterwards. Weighing a project only once every link's and every channel's
 * markdown was already materialised meant a project that must be REFUSED for
 * size allocated all of it first — the ceiling ran after the memory it exists
 * to guard (Fizzy #2228).
 */
interface SizeBudget {
	bytes: number;
}

/** Has the build already outgrown what the size ceiling permits? */
function overSizeCeiling(budget: SizeBudget): boolean {
	return budget.bytes > MAX_BATCH_DOWNLOAD_BYTES;
}

/**
 * The text a crawled (`PATH_PREFIX`) LINK will contribute, resolved once per
 * link before streaming begins.
 *
 * Assembled up front rather than inside the loop because the pre-flight has
 * to weigh these rows — their parent `content` is empty, so counting it would
 * put a whole crawled site into the size ceiling as zero bytes — and because
 * doing it twice would double the child-page round trips this export makes.
 * The cost is holding the assembled markdown of every crawled link in memory
 * for the length of the build, which the item ceiling bounds.
 *
 * A lookup that throws is recorded, not raised: the loop rethrows it inside
 * its own try so the row lands in SKIPPED with a read-failure reason, exactly
 * as it did when the assembly happened there. Because every failure is
 * contained per id, the lookups are independent and run with a bounded
 * fan-out — this whole pass happens before a byte is streamed, inside the
 * client's 60-second budget, and one sequential round trip per crawled link
 * was the largest fixed cost in it.
 *
 * Both maps are keyed by context id and only ever read by `.get`, so the
 * completion order the fan-out produces is not observable.
 *
 * Each link's bytes land in `budget` as they are assembled, and the fan-out
 * ABANDONS the remaining links the moment the running total crosses the size
 * ceiling. The refusal is still the caller's to raise — this only makes sure
 * the memory a refused project would have allocated is never allocated.
 */
async function assembleCrawledLinks(
	contexts: ReadonlyArray<ContextRow>,
	tenantFilter: ContextTenantFilter,
	budget: SizeBudget,
): Promise<{
	content: Map<string, string>;
	failures: Map<string, unknown>;
}> {
	const content = new Map<string, string>();
	const failures = new Map<string, unknown>();
	const links = contexts.filter(isPathPrefixLink);

	await mapWithConcurrency(
		links,
		CHILD_ASSEMBLY_CONCURRENCY,
		async (ctx) => {
			try {
				content.set(
					ctx.id,
					await buildPathPrefixMarkdown(ctx.id, tenantFilter),
				);
			} catch (err) {
				failures.set(ctx.id, err);
			}
			// Outside the try, and spelled the way `exportTextFor` reads this
			// shape — a lookup that failed contributes the empty string there,
			// so it has to contribute nothing here too. Weighing a row as one
			// thing and writing it as another is the defect class this file
			// keeps closing.
			budget.bytes += Buffer.byteLength(
				content.get(ctx.id) ?? "",
				"utf8",
			);
		},
		() => overSizeCeiling(budget),
	);

	return { content, failures };
}

/**
 * True when this context is an integration pointer row whose text may live in
 * `ProjectContextConversationBundle` children rather than on `content`.
 *
 * Deliberately broader than the taxonomy's `conversationSourceSystem`, which
 * additionally demands a recognized provider and a conversation identifier in
 * `metadata` before it will call a row a conversation. Bundles hang off the
 * parent by `parentContextId` alone, so a channel registered with a provider
 * spelling the taxonomy does not know would still hold real captured text — and
 * narrowing this predicate to match would drop exactly that text on the floor.
 * The cost of being broad is one cheap lookup that returns "" for an
 * integration row that never had a bundle.
 */
function isIntegrationPointer(ctx: { type: string }): boolean {
	return ctx.type === "INTEGRATION";
}

/**
 * The text a monitored Teams / Slack channel will contribute, resolved once
 * per channel before streaming begins.
 *
 * The exact mirror of `assembleCrawledLinks`, for the exact same reason: a
 * linked channel's `ProjectContext` row is a pointer — a cursor and dedup
 * markers, never the messages — so an export that reads `content` and stops
 * sees an empty conversation and reports a channel Fabric holds transcripts
 * for as "no messages captured yet" (Fizzy #2228). The messages live in
 * `ProjectContextConversationBundle` children, and this is where they are put
 * back together.
 *
 * Assembled up front for the same two reasons as well: the pre-flight has to
 * weigh these rows, or a fully captured channel enters the size ceiling as
 * zero bytes, and doing it twice would double the round trips.
 *
 * `getCapturedConversationMarkdown` returns every bundle's stored text in
 * `bundleStartedAt` order, joined by a rule — so a channel captured across
 * many bundles yields ONE entry holding all of them chronologically, not one
 * entry per bundle. Each bundle's own text is headed with the window it covers
 * (`formatConversationBundle`), which is what lets the archive entry state the
 * period its content covers without this module composing that sentence.
 *
 * A lookup that throws is recorded, not raised — the loop rethrows it inside
 * its own try so the row lands in SKIPPED as a read failure rather than losing
 * the whole export.
 */
async function assembleCapturedConversations(
	contexts: ReadonlyArray<ContextRow>,
	tenant: ConversationCaptureTenant,
	budget: SizeBudget,
): Promise<{
	content: Map<string, string>;
	failures: Map<string, unknown>;
}> {
	const content = new Map<string, string>();
	const failures = new Map<string, unknown>();
	const pointers = contexts.filter(isIntegrationPointer);

	await mapWithConcurrency(
		pointers,
		CHILD_ASSEMBLY_CONCURRENCY,
		async (ctx) => {
			try {
				content.set(
					ctx.id,
					await getCapturedConversationMarkdown(ctx.id, tenant),
				);
			} catch (err) {
				failures.set(ctx.id, err);
			}
			// The same weighing rule `exportTextFor` applies to this shape: a
			// channel with nothing captured — or a lookup that failed — falls
			// back to the pointer row's own `content`, so that is what its
			// bytes are.
			budget.bytes += Buffer.byteLength(
				content.get(ctx.id) || (ctx.content ?? ""),
				"utf8",
			);
		},
		() => overSizeCeiling(budget),
	);

	return { content, failures };
}

/**
 * The text one row contributes to the archive, given the child assemblies.
 *
 * Pure, and the ONE answer both the pre-flight estimate and the export loop
 * read — the whole class of defect this file keeps fixing is a row weighed as
 * one thing and written as another (Fizzy #2228). The loop still resolves its
 * own failures first, because a failed assembly must skip the row rather than
 * quietly export it as empty; this only decides text.
 *
 * A captured conversation falls back to the pointer row's own `content` when
 * nothing has been captured, matching the MCP project-context read. An
 * integration that is not a monitored channel therefore keeps exporting
 * whatever it always held.
 */
function exportTextFor(
	ctx: ContextRow,
	crawledContent: ReadonlyMap<string, string>,
	capturedContent: ReadonlyMap<string, string>,
): string {
	if (isPathPrefixLink(ctx)) {
		return crawledContent.get(ctx.id) ?? "";
	}
	if (isIntegrationPointer(ctx)) {
		return capturedContent.get(ctx.id) || (ctx.content ?? "");
	}
	return ctx.content ?? "";
}

/**
 * The part of the pre-flight estimate that needs no child query: Class A's
 * recorded `fileSize`, and the `content` column of every Class B/C row that
 * carries its own text. Rows with nothing to export — a Class A row with no
 * storage location, a Class B/C row with no text — contribute nothing, because
 * they will be skipped rather than written.
 *
 * The two parent/child shapes are DELIBERATELY absent. A crawled link and a
 * monitored channel keep their text in child rows, so weighing them means
 * fetching them, and this pass runs before any of that: it establishes the
 * floor the assemblies then add to, which is what lets a project already over
 * the ceiling on its files alone be refused without one child query running
 * (Fizzy #2228).
 *
 * Used for one thing only: gating `MAX_BATCH_DOWNLOAD_BYTES` before the upload
 * starts. It is never reported as the archive's size.
 */
function estimateOnRowBytes(contexts: ReadonlyArray<ContextRow>): number {
	let total = 0;
	for (const ctx of contexts) {
		const klass = classifyContext(ctx);
		if (klass === "A") {
			if (ctx.s3Path) {
				total += sourceBytesFor(ctx, klass, "");
			}
			continue;
		}
		// Weighed by their own assembly, as the text arrives. Checked after
		// Class A so the ordering matches `exportTextFor`'s — though neither
		// LINK nor INTEGRATION classifies as A, so the two cannot overlap.
		if (isPathPrefixLink(ctx) || isIntegrationPointer(ctx)) {
			continue;
		}
		total += sourceBytesFor(ctx, klass, ctx.content ?? "");
	}
	return total;
}

/**
 * Best-effort removal of an archive object that was uploaded but must not be
 * handed to anyone.
 *
 * The stream reaches storage before the build is known to have succeeded — it
 * has to, or archiver stalls on back-pressure — so any failure from the first
 * appended entry onwards leaves a truncated object under
 * `downloads/project-contexts/…` that nothing would ever collect. That prefix's
 * expiry rule is applied per environment by hand and may not be live, so the
 * orphan can persist indefinitely, and since Fizzy #2228 it can contain
 * captured conversation text.
 *
 * NEVER throws. The caller is already on its way out with the real error, and
 * a failed cleanup must not replace the reason the export failed with a
 * complaint about the cleanup. `deleteObjects` reports per-key failures rather
 * than raising, so both shapes of failure are logged and swallowed here.
 */
async function deleteOrphanedArchive(key: string, bucket: string) {
	try {
		const result = await deleteObjects([key], { bucket });
		if (result.errors.length > 0) {
			logger.error(
				{ key, bucket, errors: result.errors },
				"context batch-download failed archive left behind",
			);
		}
	} catch (err) {
		logger.error(
			{ err, key, bucket },
			"context batch-download failed archive left behind",
		);
	}
}

// ---------------------------------------------------------------------------
// Procedure
// ---------------------------------------------------------------------------

export const createContextsBatchDownloadUrlProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.CONTEXT_READ))
	.route({
		method: "POST",
		path: "/projects/:projectId/contexts/batch-download-url",
		tags: ["Projects", "Contexts"],
		summary: "Create batch context ZIP download URL",
		description:
			"Stream every context of a project into a ZIP and return a presigned GET URL.",
	})
	.input(createContextsBatchDownloadUrlInput)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Active-member check for org context. Personal context is implicit via
		// `organizationId = undefined`.
		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				user.id,
			);
			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}
		}

		const tenant = {
			userId: user.id,
			organizationId: organizationId ?? null,
		};

		// 1. Load the project under tenant XOR.
		const project = await getProjectForDownload(input.projectId, tenant);
		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		// 2. Load all contexts (ordered by createdAt asc). Authorization for
		//    this project was already enforced by the procedure middleware and
		//    `getProjectForDownload` above, so the query is project-scoped.
		const contexts = (await listContextsForDownload(
			input.projectId,
		)) as unknown as ContextRow[];

		// 3. Fix the order, apply the item ceiling, and weigh the result —
		//    all BEFORE streaming anything.
		const totalCount = contexts.length;

		// Child-row lookups — page rows for a crawled link, conversation
		// bundles for a monitored channel — re-derive tenant XOR from the
		// caller, never from the parent row, so a stale mirrored tenant column
		// on a child cannot pull content across an organization boundary. Same
		// rule the single-item download follows.
		const childPageTenantFilter: ContextTenantFilter = organizationId
			? { organizationId }
			: { organizationId: null, userId: user.id };
		// The same derivation, in the shape the bundle query takes. It
		// collapses this internally to exactly `childPageTenantFilter` —
		// `organizationId` alone for an org caller, `{ userId, organizationId:
		// null }` for a personal one — so both child reads are filtered
		// identically, from the one source.
		const capturedTenant: ConversationCaptureTenant = {
			userId: user.id,
			organizationId: organizationId ?? null,
		};

		// The item ceiling truncates rather than refusing: a project past it
		// exports its first `MAX_BATCH_DOWNLOAD_CONTEXTS` rows and declares the
		// rest in the manifest, so nothing becomes unreachable — every excluded
		// row is still one single-item download away.
		//
		// Which rows those are has to be reproducible, or two exports of an
		// unchanged project would truncate differently. `listContextsForDownload`
		// orders on `createdAt` and then `id`, a total order, so this prefix is
		// the same prefix every time — the tie-break matters because rows
		// written in one transaction share a timestamp.
		const selected = contexts.slice(0, MAX_BATCH_DOWNLOAD_CONTEXTS);
		const excluded = contexts.slice(MAX_BATCH_DOWNLOAD_CONTEXTS);

		// Estimate only — it gates the size ceiling and is never reported as
		// the archive's size. What the manifest reports is `writtenBytes`,
		// accumulated below as entries are actually appended.
		//
		// It is accumulated rather than computed at the end because the two
		// assemblies below MATERIALISE text: every crawled link's markdown and
		// every monitored channel's transcript are held in memory for the
		// length of the build. Weighing after the fact meant a project that
		// must be refused for size allocated all of it first, so the ceiling
		// ran after the memory it exists to guard (Fizzy #2228). The rows that
		// need no query are weighed first, and each assembly adds its own bytes
		// as it goes and gives up on the rest once the total is past the
		// ceiling — so the refusal below fires having read as little as the
		// bounded fan-out allows.
		const budget: SizeBudget = { bytes: estimateOnRowBytes(selected) };

		const crawled = await assembleCrawledLinks(
			selected,
			childPageTenantFilter,
			budget,
		);
		const captured = await assembleCapturedConversations(
			selected,
			capturedTenant,
			budget,
		);

		if (overSizeCeiling(budget)) {
			// The same error the whole-project estimate used to raise, in the
			// same shape — `size` is now the running total at the point the
			// build gave up, which is still the honest answer to "how big had
			// this got": at least this, and more than the ceiling allows.
			throw new ORPCError("BAD_REQUEST", {
				message: "projects.contexts.download.tooLarge",
				data: {
					reason: "too_large" as const,
					count: totalCount,
					size: budget.bytes,
					maxSize: MAX_BATCH_DOWNLOAD_BYTES,
				},
			});
		}

		// 4. Build the output filenames / S3 key.
		const now = new Date();
		const dateStamp = utcDateStamp(now);
		const filename = `${slugifyProjectName(project.name)}_context_${dateStamp}.zip`;
		const key = `downloads/project-contexts/${input.projectId}/${dateStamp}/${randomUUID()}.zip`;
		const bucket = config.storage.bucketNames.projectContexts;

		// 5. Create archiver + streaming upload pipeline.
		const archive = archiver("zip", { zlib: { level: 6 } });
		// Pipe archive into a PassThrough so the underlying `Upload` reads from
		// a plain Readable and we can attach error handlers without coupling.
		const archiveOutput = new PassThrough();
		archive.pipe(archiveOutput);

		// Has anything been handed to the archive yet?
		//
		// This is the difference between "`key` holds a truncated object that
		// has to be collected" and "`key` was never written at all", and the
		// cleanup below turns on it: deleting a key nothing ever wrote is a
		// round trip spent on an object that does not exist. Every append goes
		// through `appendEntry` so the flag cannot drift from the fact.
		let streamingStarted = false;
		const appendEntry = (
			body: Readable | Buffer | string,
			options: { name: string },
		): void => {
			streamingStarted = true;
			archive.append(body, options);
		};

		const included: ManifestIncludedRow[] = [];
		const skipped: ManifestSkippedRow[] = [];
		// The reasons behind `skipped`, kept as discriminated values rather
		// than as the strings already rendered into the manifest. The manifest
		// section and the per-reason counts returned to the client are two
		// renderings of this one list (Fizzy #2228) — the last taxonomy fix in
		// this repo left a second copy of the message somewhere the first fix
		// never reached, and a single list is how that stops being possible.
		const skipReasons: ContextSkipReason[] = [];
		const recordSkip = (
			ctx: { type: string },
			title: string,
			reason: ContextSkipReason,
		): void => {
			skipReasons.push(reason);
			skipped.push({
				type: ctx.type,
				title,
				reason: describeContextSkipReason(reason),
			});
		};
		const seenNames = new Map<string, number>();
		// The reported total. Incremented only where an entry has reached the
		// archive, so a mid-loop storage failure cannot inflate it.
		let writtenBytes = 0;

		// Kick off the upload concurrently with the archive writes. We must
		// start consuming the archive output immediately or archiver will stall
		// on back-pressure.
		const uploadPromise = putObjectStream(key, archiveOutput, {
			bucket,
			contentType: "application/zip",
		});
		// A rejected `finalize()` jumps straight to the cleanup below without
		// awaiting this one, so between those two points the upload's own
		// rejection would have nobody listening — an unhandled rejection, which
		// Node treats as fatal. Observing it here closes that window; the awaits
		// on either side still receive the error itself.
		uploadPromise.catch(() => {});

		// Capture any fatal archiver/upload error so we can wrap it.
		let fatalError: unknown = null;
		archive.on("error", (err) => {
			fatalError = err;
		});

		for (const ctx of selected) {
			const title = resolveTitle(ctx);
			const integration = resolveIntegrationProvider(ctx);
			const klass = classifyContext(ctx);
			// Manifest suffix for this row — set only where extraction is
			// unfinished and the exported artifact is the extracted text.
			let annotation = "";

			try {
				// Two shapes keep their text OFF the row, and both are
				// parent/child: a `PATH_PREFIX` LINK scatters its markdown
				// across `ProjectContextUrlPage` children, and a monitored
				// channel keeps its messages in
				// `ProjectContextConversationBundle` children. Both leave
				// `content` empty, so an export that reads `content` and stops
				// drops them. Only those two shapes pay for the extra query; an
				// ordinary single-URL LINK or a free-text note keeps reading
				// straight off `content`.
				if (isPathPrefixLink(ctx)) {
					// Assembled before streaming began, so the pre-flight could
					// weigh it. A lookup that failed there is raised here,
					// inside the try, so it reports as a read failure on this
					// row instead of losing the whole export.
					const failure = crawled.failures.get(ctx.id);
					if (failure) {
						throw failure;
					}
				} else if (isIntegrationPointer(ctx)) {
					// The second shape whose text is NOT on the row: a
					// monitored Teams / Slack channel is a pointer, and its
					// messages live in `ProjectContextConversationBundle`
					// children. Reading `content` and stopping is what made a
					// captured channel export as "no messages captured yet"
					// while the assistant was citing it (Fizzy #2228). Same
					// treatment as a crawled link, for the same parent/child
					// reason — including raising the assembly's own failure
					// here, inside the try.
					const failure = captured.failures.get(ctx.id);
					if (failure) {
						throw failure;
					}
				}
				// The text that actually goes into the ZIP entry. One
				// resolution, shared with the pre-flight, so the bytes a row
				// was weighed at and the bytes it writes cannot disagree.
				// Resolved BEFORE the taxonomy runs, so "the text this row
				// contributes" means the same thing for every row it sees —
				// which is what lets a channel with bundles stop reporting as
				// an uncaptured conversation, and an empty crawl still report
				// as an empty crawl.
				const entryContent = exportTextFor(
					ctx,
					crawled.content,
					captured.content,
				);

				// Inclusion turns on whether there is anything to export at
				// all: a storage location for Class A, non-empty text for Class
				// B/C. Extraction status gates neither (Fizzy #2228) — it is
				// reported, not enforced. One pure function answers both "is
				// this exportable" and "if not, why", so the reason the user
				// reads can never disagree with the decision taken.
				const skipReason = deriveContextSkipReason({
					context: ctx,
					downloadClass: klass,
					exportText: entryContent,
				});
				if (skipReason) {
					recordSkip(ctx, title, skipReason);
					continue;
				}

				if (klass !== "A") {
					// Partial text still ships: an integration parked in
					// PENDING or an extraction that gave up part-way holds real
					// content, and withholding it loses the export's whole
					// point. The manifest carries the caveat instead.
					annotation = extractionAnnotation(ctx.extractionStatus);
				}
				// For Class A the raw bytes always flow. Extraction status
				// describes the text derived from that object, not the object
				// itself, so it says nothing about whether the upload is whole.

				const baseName = contextDownloadFilename({
					title,
					class: klass,
					originalFilename: ctx.originalFilename,
					mimeType: ctx.mimeType,
					integration,
				});
				const finalName = dedupeFilename(seenNames, baseName);
				const subfolder = resolveSubfolder(
					klass,
					ctx.type,
					integration,
				);
				const entryPath = `${subfolder}/${finalName}`;

				if (klass === "A") {
					const srcBucket = ctx.s3Bucket ?? bucket;
					// biome-ignore lint/style/noNonNullAssertion: guarded above.
					const body = await getObjectStream(ctx.s3Path!, {
						bucket: srcBucket,
					});
					appendEntry(body, { name: entryPath });
				} else {
					const payload = buildContextTextPayload({
						id: ctx.id,
						title,
						type: ctx.type,
						integrationProvider: integration,
						createdAt: ctx.createdAt,
						content: entryContent,
					});
					appendEntry(Readable.from(Buffer.from(payload, "utf8")), {
						name: entryPath,
					});
				}

				// Past the append — these bytes are in the archive, so they are
				// the ones the manifest gets to claim.
				writtenBytes += sourceBytesFor(ctx, klass, entryContent);
				included.push({
					type: ctx.type,
					title,
					fileInZip: `${entryPath}${annotation}`,
				});
			} catch (err) {
				logger.warn(
					{ err, contextId: ctx.id },
					"context batch-download skipped",
				);
				recordSkip(ctx, title, deriveStorageErrorSkipReason(err));
			}
		}

		// 6. Declare every row the item ceiling left out — one line each, so the
		//    manifest names them individually and the user knows exactly what
		//    to fetch one at a time. Appended after the loop's own skips, which
		//    keeps the tail grouped and the whole list deterministic.
		for (const ctx of excluded) {
			recordSkip(ctx, resolveTitle(ctx), { code: "BEYOND_ITEM_LIMIT" });
		}

		// 7-9. Manifest, finalize, upload, presign — ONE guarded region, because
		//      every way out of it that is not a URL leaves the same orphan.
		//
		//      The upload has been running since before the first entry was
		//      written (archiver stalls on back-pressure otherwise), so from
		//      here on `key` holds bytes nobody can reach unless this returns.
		//      Five things can go wrong — the manifest build throws, archiver's
		//      `finalize()` rejects, the upload rejects having already written
		//      parts, the archiver reported a fatal error mid-stream, or the
		//      presign rejects over a perfectly good object — and every one of
		//      them ends the same way: an object under
		//      `downloads/project-contexts/…` that no caller is ever handed a
		//      URL for and no expiry rule can be relied on to collect
		//      (Fizzy #2228). Guarding them one at a time is exactly how four of
		//      the five came to be missed, so they are guarded together.
		try {
			// 7. Always append MANIFEST last so it reflects the final SKIPPED
			//    list.
			const manifest = buildContextDownloadManifest({
				project: { id: project.id, name: project.name },
				tenant: organizationId
					? { kind: "org", id: organizationId, name: project.name }
					: { kind: "personal" },
				exportedAt: now,
				exportedBy: {
					id: user.id,
					email: (user as { email?: string }).email ?? "",
				},
				included,
				skipped,
				totalBytes: writtenBytes,
			});
			appendEntry(manifest, { name: "MANIFEST.txt" });

			// 8. Finalize the archive and await the upload. `finalize()`
			//    resolves when archiver has flushed its last bytes into the
			//    PassThrough; the upload promise resolves when lib-storage has
			//    acked the final part.
			await archive.finalize();
			await uploadPromise;

			if (fatalError) {
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message: "Failed to build context archive",
				});
			}

			// 9. Presign a GET URL for the uploaded ZIP. Force the browser to
			//    save as `filename` (not the UUID S3 key) via Response*
			//    overrides — `anchor.download` is ignored for cross-origin URLs.
			const url = await getSignedUrl(key, {
				bucket,
				expiresIn: BATCH_PRESIGN_EXPIRY_SECONDS,
				responseContentDisposition: `attachment; filename="${filename}"`,
				responseContentType: "application/zip",
			});
			const expiresAt = new Date(
				now.getTime() + BATCH_PRESIGN_EXPIRY_SECONDS * 1000,
			).toISOString();

			return {
				url,
				filename,
				expiresAt,
				includedCount: included.length,
				skippedCount: skipped.length,
				// Rows the item ceiling dropped. Reported separately from
				// `skippedCount` — which also covers rows that had nothing to
				// export — so the in-app summary can say the archive was truncated
				// rather than lumping a deliberate cut in with failures. Equal to
				// `skippedByReason.BEYOND_ITEM_LIMIT`; kept as its own field
				// because a truncation is the one skip a caller may want to react
				// to without walking the whole taxonomy.
				excludedCount: excluded.length,
				// Every reason, zero-filled, summing to `skippedCount`. The client
				// renders one line per non-zero entry; the MANIFEST inside the ZIP
				// renders the same reasons row by row. Both are derived from the
				// one `skipReasons` list, so the archive and the app can never tell
				// different stories about the same export (Fizzy #2228).
				skippedByReason: countContextSkipReasons(skipReasons),
				totalCount,
				key,
			};
		} catch (err) {
			// Nothing to collect if nothing was ever handed to the archive —
			// an empty export whose manifest build threw never wrote to `key`,
			// and a delete against it is a round trip spent on an object that
			// does not exist.
			if (streamingStarted) {
				// A `finalize()` that failed can leave the upload still in
				// flight, and a delete that lands underneath a live multipart
				// upload is undone by that upload's own completion. Ending the
				// source settles it either way — lib-storage either completes
				// what it has or rejects — so the delete runs against a key
				// nothing is still writing to. Its rejection is already spoken
				// for: either it is the error being carried out, or the handler
				// attached at creation observed it.
				if (!archiveOutput.writableEnded) {
					archiveOutput.end();
				}
				await uploadPromise.catch(() => {});
				// Best-effort and never throwing — see `deleteOrphanedArchive`.
				await deleteOrphanedArchive(key, bucket);
			}
			// The cleanup never speaks for the failure. Whatever brought us
			// here leaves exactly as it arrived, so a caller still sees the
			// error it already handles rather than a complaint about a delete.
			throw err;
		}
	});
