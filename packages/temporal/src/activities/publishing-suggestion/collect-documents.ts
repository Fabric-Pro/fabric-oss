/**
 * Publishing Suggestion — Document Collector Activity
 *
 * `items` = ProjectDocument rows touched (created or updated) in the window,
 * bounded by `PER_SOURCE_CAP` — this is raw LLM context.
 *
 * `qualifyingCount` (M5) is a SEPARATE, bounded scan of `DocumentVersion` —
 * distinct `documentId` among in-window versions whose `content` is
 * substantive (`content.trim().length >= MIN_DOC_CONTENT_CHARS`). A non-empty
 * `changeDescription` is NOT sufficient on its own — it is free text an
 * author can set on a no-op edit. `DocumentVersion` has no stored size/diff
 * column, so the scan is bounded (F6) at `PER_SOURCE_CAP + 1` rows; an
 * unbounded 180-day history could exhaust the activity timeout/DB. If the
 * scan returns more than `PER_SOURCE_CAP` rows, the source is treated as
 * incomplete (`capExhausted = true`, no coverage advance) rather than
 * silently undercounting.
 *
 * (F7) The substantive-content check is done IN Postgres via a raw
 * `db.$queryRaw` — rather than by selecting `content` and measuring
 * `.trim().length` in JS. `DocumentVersion.content` has no DB size bound, so
 * loading the full text of up to `PER_SOURCE_CAP + 1` versions into worker
 * memory purely to test its length risks a worker OOM / activity timeout on
 * large documents. The raw query selects only `documentId` + `createdAt`.
 *
 * (N5) The trim MUST match JS `.trim()` semantics: Postgres `btrim()` strips
 * only ASCII spaces, not tabs/newlines/CR/FF/VT, so a whitespace-only doc
 * (e.g. all tabs/newlines) would qualify in SQL while JS `.trim()` would call
 * it empty — inflating `qualifyingCount` with empty context. Instead we strip
 * leading/trailing `\s` (Postgres ARE default flavor — `[ \t\n\r\f\v]`, the
 * same class JS `\s`/`.trim()` strips) via
 * `regexp_replace(content, '^\s+|\s+$', '', 'g')` before measuring
 * `char_length`. NOTE: in the TS source below the pattern is written as
 * `'^\\s+|\\s+$'` (double backslash) — `db.$queryRaw` is a tagged template
 * and Prisma builds the SQL from the *cooked* strings array, and JS silently
 * drops an unrecognized single backslash escape (`` `\s` === `s` ``), so a
 * single backslash here would ship `^s+|s+$` to Postgres and never match
 * whitespace. Coverage note: `collect-documents.test.ts` mocks `$queryRaw`
 * (JS-side `.trim()` semantics), so it cannot exercise the actual SQL regex —
 * this package has no real-Postgres test harness (`RUN_DB_INTEGRATION` only
 * exists under `packages/database`). A real-DB test proving a tabs/newlines-
 * only document is excluded is a tracked follow-up, not stood up here.
 */

import { db, MIN_DOC_CONTENT_CHARS, PER_SOURCE_CAP } from "@repo/database";
import { Context } from "@temporalio/activity";
import { byteBoundItems } from "./lib/byte-bound";

export interface CollectDocumentsInput {
	projectId: string;
	organizationId: string | null;
	userId: string | null;
	windowStart: string;
	windowEnd: string;
}

export interface CollectDocumentsOutput {
	items: { id: string; title: string; updatedAt: Date }[];
	count: number;
	qualifyingCount: number;
	newestQualifyingIso: string | null; // F7 — max DocumentVersion.createdAt among substantive versions
	capExhausted: boolean;
}

export async function collectDocuments(
	input: CollectDocumentsInput,
): Promise<CollectDocumentsOutput> {
	Context.current().heartbeat();
	const { projectId, organizationId, windowStart, windowEnd } = input;
	const start = new Date(windowStart);
	const end = new Date(windowEnd);
	const scope = { projectId, project: { organizationId } }; // explicit tenant guard (worker bypasses RLS)

	const rows = await db.projectDocument.findMany({
		where: {
			...scope,
			OR: [
				{ createdAt: { gte: start, lte: end } },
				{ updatedAt: { gte: start, lte: end } },
			],
		},
		select: { id: true, title: true, updatedAt: true },
		orderBy: { updatedAt: "desc" },
		take: PER_SOURCE_CAP + 1, // +1 sentinel to detect exhaustion
	});
	const capExhaustedByCount = rows.length > PER_SOURCE_CAP;
	const items = capExhaustedByCount ? rows.slice(0, PER_SOURCE_CAP) : rows;

	// M5 / F7: qualifyingCount is a separate bounded scan of DocumentVersion, keyed
	// on substantive content — NOT derived from the `items` above (ProjectDocument's
	// own updatedAt reflects any field change, including metadata-only edits).
	// The content-length filter runs IN Postgres (never selects `content` into JS) —
	// see the module docblock. Tenant scope mirrors `scope` above: the document's
	// own projectId, joined through to the document's project.organizationId
	// (`IS NOT DISTINCT FROM` so a null org — personal-context — still matches).
	const qualifyingVersionRows = await db.$queryRaw<
		{ documentId: string; createdAt: Date }[]
	>`
		SELECT dv."documentId", dv."createdAt"
		FROM "document_version" dv
		JOIN "project_document" pd ON pd."id" = dv."documentId"
		JOIN "project" p ON p."id" = pd."projectId"
		WHERE pd."projectId" = ${projectId}
			AND p."organizationId" IS NOT DISTINCT FROM ${organizationId}
			AND dv."createdAt" >= ${start}
			AND dv."createdAt" <= ${end}
			AND char_length(regexp_replace(dv."content", '^\\s+|\\s+$', '', 'g')) >= ${MIN_DOC_CONTENT_CHARS}
		ORDER BY dv."createdAt" DESC
		LIMIT ${PER_SOURCE_CAP + 1}
	`;
	const versionScanCapExhausted =
		qualifyingVersionRows.length > PER_SOURCE_CAP; // F6 — bound the qualification scan
	const qualifyingCount = new Set(
		qualifyingVersionRows.map((v) => v.documentId),
	).size;
	const newestQualifyingIso =
		qualifyingVersionRows.length > 0
			? new Date(
					Math.max(
						...qualifyingVersionRows.map((v) =>
							v.createdAt.getTime(),
						),
					),
				).toISOString()
			: null;

	// H3: byte-bound the returned `items` before returning (reuses the #1750
	// helper). A byte-trim is source INCOMPLETENESS — OR it into `capExhausted`.
	const { items: bounded, trimmed } = byteBoundItems(items);
	return {
		items: bounded,
		count: bounded.length,
		qualifyingCount,
		newestQualifyingIso,
		capExhausted: capExhaustedByCount || versionScanCapExhausted || trimmed,
	};
}
