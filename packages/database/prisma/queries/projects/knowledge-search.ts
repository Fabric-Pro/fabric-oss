import { db, Prisma } from "../../client";

export const KNOWLEDGE_SOURCE_KINDS = [
	"feature",
	"document",
	"context",
	"context_page",
	"context_bundle",
] as const;
export type KnowledgeSourceKind = (typeof KNOWLEDGE_SOURCE_KINDS)[number];
export interface KnowledgeSearchPosition {
	rank: number;
	sourceKind: KnowledgeSourceKind;
	sourceId: string;
}
export interface KnowledgeSearchHit extends KnowledgeSearchPosition {
	parentContextId: string | null;
	title: string;
	titleTruncated: boolean;
	excerpt: string;
	excerptField: "body" | "title" | "identifier";
	excerptTruncated: boolean;
	identifier: string | null;
	sourceType: string;
	sourceUrl: string | null;
	sourceUrlOmitted: boolean;
}
interface KnowledgeSearchInput {
	projectId: string;
	organizationId: string;
	query: string;
	limit: number;
	after?: KnowledgeSearchPosition;
}

// PostgreSQL 15-compatible JSON string grammar. Only these complete tokens are
// cast, never the whole legacy description: invalid escapes, NUL and unmatched
// UTF-16 surrogates cannot poison a search. Decode escaped text before matching.
// Windowed ownership associates fields with their own object in one pass after
// sorting, regardless of field order or nested marks. Attributes are not prose.
// Group closing tokens with fields so block separators need no ownership join.
const JSON_TOKEN = String.raw`("(?:[^"\\[:cntrl:]]|\\["\\/bfnrt]|\\u[dD][89aAbB][0-9a-fA-F]{2}\\u[dD][c-fC-F][0-9a-fA-F]{2}|\\u(?!0000|[dD][89a-fA-F])[0-9a-fA-F]{4})*"|[{}\[\]:,])`;
const POSSIBLE_JSON_DOCUMENT = String.raw`^\s*\{`;

/**
 * Literal keyword search, ranked in SQL before a bounded page is transferred.
 * Caller must authorize current project access and resolve its hosting tenant.
 * Child rows also match that project and tenant, never the guest's own tenant.
 * No embedding/provider calls or inventory-wide body reads.
 */
export function buildProjectKnowledgeSearchQuery(
	input: KnowledgeSearchInput,
): Prisma.Sql {
	if (!input.organizationId) {
		throw new Error(
			"organizationId must resolve to the project's hosting organization",
		);
	}
	const { projectId, organizationId, query, limit, after } = input;
	// Match the shared presentation helper: only nonempty string metadata values
	// are titles. An object containing the keyword must not become a title hit.
	const contextTitle = Prisma.sql`COALESCE(NULLIF(c."sourceTitle", ''),
		CASE WHEN jsonb_typeof(c.metadata->'title') = 'string' THEN NULLIF(c.metadata->>'title', '') END,
		CASE WHEN jsonb_typeof(c.metadata->'documentTitle') = 'string' THEN NULLIF(c.metadata->>'documentTitle', '') END,
		CASE WHEN jsonb_typeof(c.metadata->'sourceTitle') = 'string' THEN NULLIF(c.metadata->>'sourceTitle', '') END,
		CASE WHEN jsonb_typeof(c.metadata->'filename') = 'string' THEN NULLIF(c.metadata->>'filename', '') END,
		NULLIF(c."originalFilename", ''), 'Untitled context')`;
	const continuation = after
		? Prisma.sql`AND (rank < ${after.rank}::integer OR
    (rank = ${after.rank}::integer AND ("sourceKind" COLLATE "C", "sourceId" COLLATE "C") >
     (${after.sourceKind}::text COLLATE "C", ${after.sourceId}::text COLLATE "C")))`
		: Prisma.empty;
	return Prisma.sql`
 WITH sources AS MATERIALIZED (
  SELECT 'feature'::text AS "sourceKind", s.id AS "sourceId", NULL::text AS "parentContextId",
   s.title, s.identifier, s.kind::text AS "sourceType", NULL::text AS "sourceUrl",
   CASE WHEN s.description ~ ${POSSIBLE_JSON_DOCUMENT} THEN (
    WITH tokens AS (
     SELECT token[1] AS token, ordinal
     FROM regexp_matches(s.description, ${JSON_TOKEN}, 'g') WITH ORDINALITY AS lexemes(token, ordinal)
    ), depths AS (
     SELECT *, COALESCE(sum(CASE token WHEN '{' THEN 1 WHEN '}' THEN -1 ELSE 0 END)
      OVER (ORDER BY ordinal ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS depth
     FROM tokens
    ), levels AS (
     SELECT *, depth + CASE WHEN token = '{' THEN 1 ELSE 0 END AS owner_depth FROM depths
    ), owned AS (
     SELECT *, max(ordinal) FILTER (WHERE token = '{')
      OVER (PARTITION BY owner_depth ORDER BY ordinal ROWS UNBOUNDED PRECEDING) AS owner
     FROM levels
    ), keys AS (
     SELECT *, lead(token, 1) OVER (ORDER BY ordinal) AS separator,
      lead(token, 2) OVER (ORDER BY ordinal) AS value
     FROM owned
    ), fields AS (
     SELECT owner, token, value, ordinal FROM keys
     WHERE token = '}' OR
      (token IN ('"type"', '"text"') AND separator = ':' AND left(value, 1) = '"')
    ), objects AS (
     SELECT owner, max(value) FILTER (WHERE token = '"type"') AS node_type,
      max(value) FILTER (WHERE token = '"text"') AS text_value,
      max(ordinal) FILTER (WHERE token = '"text"') AS text_ordinal,
      max(ordinal) FILTER (WHERE token = '}') AS close_ordinal
     FROM fields GROUP BY owner
    ), prose AS (
     SELECT text_ordinal AS ordinal, text_value::jsonb #>> '{}' AS value FROM objects
      WHERE node_type = '"text"' AND text_value IS NOT NULL
     UNION ALL
     SELECT close_ordinal, E'\n' FROM objects
      WHERE close_ordinal IS NOT NULL AND node_type IN
       ('"paragraph"', '"heading"', '"codeBlock"', '"blockquote"', '"listItem"', '"hardBreak"', '"horizontalRule"')
    )
    SELECT CASE WHEN EXISTS (SELECT 1 FROM objects WHERE owner = 1 AND node_type = '"doc"') THEN
     COALESCE((SELECT string_agg(value, '' ORDER BY ordinal) FROM prose), '')
     ELSE COALESCE(s.description, '') END
   ) ELSE COALESCE(s.description, '') END AS body
   FROM user_story s WHERE s."projectId" = ${projectId} AND s."organizationId" = ${organizationId}
  UNION ALL
  SELECT 'document', d.id, NULL, d.title, NULL, d.type::text, NULL, d.content
   FROM project_document d WHERE d."projectId" = ${projectId} AND d."organizationId" = ${organizationId}
  UNION ALL
  SELECT 'context', c.id, c.id,
   ${contextTitle},
   NULL, c.type::text, c."sourceUrl", c.content
   FROM project_context c WHERE c."projectId" = ${projectId} AND c."organizationId" = ${organizationId}
    AND c.type::text NOT IN ('CODE_FILE', 'CODE_FILE_SUMMARY')
    AND (c.type::text <> 'LINK' OR c."urlScope"::text IS DISTINCT FROM 'PATH_PREFIX')
    AND NOT (c.type::text = 'INTEGRATION' AND EXISTS
     (SELECT 1 FROM project_context_conversation_bundle b WHERE b."parentContextId" = c.id
      AND b."projectId" = ${projectId} AND b."organizationId" = ${organizationId} AND b.content <> ''))
  UNION ALL
  SELECT 'context_page', p.id, c.id, COALESCE(NULLIF(p."pageTitle", ''), p."pageUrl"), NULL, c.type::text, p."pageUrl", p.content
   FROM project_context_url_page p JOIN project_context c ON c.id = p."parentContextId"
   WHERE c."projectId" = ${projectId} AND c."organizationId" = ${organizationId}
    AND p."projectId" = ${projectId} AND p."organizationId" = ${organizationId}
    AND c.type::text = 'LINK' AND c."urlScope"::text = 'PATH_PREFIX'
  UNION ALL
  SELECT 'context_bundle', b.id, c.id,
   ${contextTitle},
   NULL, c.type::text, c."sourceUrl", b.content
   FROM project_context_conversation_bundle b JOIN project_context c ON c.id = b."parentContextId"
   WHERE c."projectId" = ${projectId} AND c."organizationId" = ${organizationId}
    AND b."projectId" = ${projectId} AND b."organizationId" = ${organizationId}
    AND c.type::text = 'INTEGRATION'
 ), matches AS (
  SELECT *, strpos(lower(title), lower(${query}::text)) AS title_match,
   strpos(lower(body), lower(${query}::text)) AS body_match
  FROM sources
  WHERE "sourceKind" IN ('feature', 'document') OR body ~ '[^[:space:]]'
 ), ranked AS (
  SELECT *, CASE WHEN lower(title) = lower(${query}::text) OR lower(identifier) = lower(${query}::text) THEN 3
   WHEN title_match > 0 THEN 2 ELSE 1 END AS rank
  FROM matches WHERE title_match > 0 OR body_match > 0 OR lower(identifier) = lower(${query}::text)
 ), excerpt_sources AS (
  SELECT *, CASE WHEN body_match > 0 THEN body WHEN title_match > 0 THEN title ELSE COALESCE(identifier, title) END AS excerpt_body,
   CASE WHEN body_match > 0 THEN body_match WHEN title_match > 0 THEN title_match ELSE 1 END AS excerpt_match,
   CASE WHEN body_match > 0 THEN 'body' WHEN title_match > 0 THEN 'title' ELSE 'identifier' END AS "excerptField"
  FROM ranked
 )
 SELECT "sourceKind", "sourceId", "parentContextId", rank,
  left(title, 160) AS title, length(title) > 160 AS "titleTruncated",
  substring(excerpt_body FROM greatest(1, excerpt_match - 120) FOR 480) AS excerpt, "excerptField",
  length(excerpt_body) > 480 AS "excerptTruncated", left(identifier, 80) AS identifier, "sourceType",
  CASE WHEN length("sourceUrl") <= 512 THEN "sourceUrl" ELSE NULL END AS "sourceUrl",
  COALESCE(length("sourceUrl") > 512, false) AS "sourceUrlOmitted"
 FROM excerpt_sources WHERE true ${continuation}
 ORDER BY rank DESC, "sourceKind" COLLATE "C" ASC, "sourceId" COLLATE "C" ASC
 LIMIT ${limit + 1}::integer
 `;
}

export async function searchProjectKnowledge(
	input: KnowledgeSearchInput,
): Promise<KnowledgeSearchHit[]> {
	const query = buildProjectKnowledgeSearchQuery(input);
	return db.$transaction(
		async (tx) => {
			// Limit CPU spent scanning large bodies. LOCAL restores the pooled
			// connection's setting when this read transaction ends.
			await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
			return tx.$queryRaw<KnowledgeSearchHit[]>(query);
		},
		{ timeout: 10_000 },
	);
}
