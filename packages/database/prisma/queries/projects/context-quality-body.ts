import { db } from "../../client";

const MAX_SOURCE_BYTES = 96 * 1024;

interface SourceScope {
	sourceId: string;
	projectId: string;
	organizationId: string;
}

export interface ContextQualitySourceMetadata {
	id: string;
	projectId: string;
	organizationId: string;
	type: string;
	urlScope: string | null;
	/** Body bytes are deliberately absent from the metadata query. */
	content: null;
	extractionStatus: string;
	indexingExcluded: boolean;
	updatedAt: Date;
	/** Bounded display title, not the raw metadata/provider configuration. */
	sourceTitle: string;
	/** Only the existing extraction-lifecycle discriminator is projected. */
	metadata: { source?: "google-docs" };
}

function validScope(scope: SourceScope): boolean {
	return [scope.sourceId, scope.projectId, scope.organizationId].every(
		(value) =>
			typeof value === "string" &&
			value.trim().length > 0 &&
			value.length <= 128,
	);
}

/**
 * A tenant/project-scoped metadata read that never transfers the source body or
 * arbitrary JSON to Node. Authorization remains the facade caller's obligation.
 */
export async function getContextQualitySourceMetadata(
	scope: SourceScope,
): Promise<ContextQualitySourceMetadata | null> {
	if (!validScope(scope)) {
		return null;
	}
	const [row] = await db.$queryRaw<ContextQualitySourceMetadata[]>`
		SELECT id, "projectId", "organizationId", type::text,
		       "urlScope"::text, NULL::text AS content, "extractionStatus"::text,
		       "indexingExcluded", "updatedAt",
		       left(COALESCE(
		         NULLIF("sourceTitle", ''),
		         CASE WHEN jsonb_typeof(metadata->'title') = 'string' THEN NULLIF(metadata->>'title', '') END,
		         CASE WHEN jsonb_typeof(metadata->'documentTitle') = 'string' THEN NULLIF(metadata->>'documentTitle', '') END,
		         CASE WHEN jsonb_typeof(metadata->'sourceTitle') = 'string' THEN NULLIF(metadata->>'sourceTitle', '') END,
		         CASE WHEN jsonb_typeof(metadata->'filename') = 'string' THEN NULLIF(metadata->>'filename', '') END,
		         NULLIF("originalFilename", ''), 'Untitled context'
		       ), 240) AS "sourceTitle",
		       CASE WHEN metadata->>'source' = 'google-docs'
		         THEN jsonb_build_object('source', 'google-docs')
		         ELSE '{}'::jsonb END AS metadata
		  FROM project_context
		 WHERE id = ${scope.sourceId}
		   AND "projectId" = ${scope.projectId}
		   AND "organizationId" = ${scope.organizationId}
	`;
	return row ?? null;
}

/**
 * The canonical direct body, bounded BEFORE text crosses the database wire.
 *
 * Inline bytes and the exact formatted crawl/bundle bytes are measured in the
 * same statement snapshot. Oversized sources return no text. CASE guards the
 * string_agg subqueries, so the database does not assemble an oversized body
 * either. Size CTEs carry ids/numbers, not source text. The two assemblies match
 * getCrawledUrlSourceMarkdown / getCapturedConversationMarkdown byte-for-byte.
 * Changing those canonical formats requires updating this projection with them.
 * No provider fetch, arbitrary metadata or historical-source reconstruction.
 */
export async function readContextQualitySourceBody(
	scope: SourceScope & { maxBytes: number },
): Promise<{ content: string; truncated: boolean; hasReadableText: boolean }> {
	if (!validScope(scope)) {
		return { content: "", truncated: false, hasReadableText: false };
	}
	if (
		!Number.isInteger(scope.maxBytes) ||
		scope.maxBytes < 1 ||
		scope.maxBytes > MAX_SOURCE_BYTES
	) {
		throw new Error("Invalid context quality body byte limit");
	}
	const [row] = await db.$queryRaw<
		Array<{ content: string | null; truncated: boolean }>
	>`
		WITH parent AS (
			SELECT id, "projectId", "organizationId", type, "urlScope",
			       octet_length(content)::bigint AS "inlineBytes"
			  FROM project_context
			 WHERE id = ${scope.sourceId}
			   AND "projectId" = ${scope.projectId}
			   AND "organizationId" = ${scope.organizationId}
		), url_sizes AS (
			SELECT child.id,
			       octet_length(child.content)::bigint
			       + octet_length(COALESCE(NULLIF(child."pageTitle", ''), child."pageUrl"))
			       + octet_length(child."pageUrl") + 7 AS bytes
			  FROM project_context_url_page child JOIN parent p
			    ON child."parentContextId" = p.id
			   AND child."projectId" = p."projectId"
			   AND child."organizationId" = p."organizationId"
			 WHERE p.type = 'LINK' AND p."urlScope" = 'PATH_PREFIX'
			   AND child.content <> ''
		), url_total AS (
			SELECT COALESCE(sum(bytes), 0) + greatest(count(*) - 1, 0) * 6 AS bytes
			  FROM url_sizes
		), bundle_sizes AS (
			SELECT child.id, octet_length(child.content)::bigint AS bytes
			  FROM project_context_conversation_bundle child JOIN parent p
			    ON child."parentContextId" = p.id
			   AND child."projectId" = p."projectId"
			   AND child."organizationId" = p."organizationId"
			 WHERE p.type = 'INTEGRATION' AND child.content <> ''
		), bundle_total AS (
			SELECT count(*) AS count,
			       COALESCE(sum(bytes), 0) + greatest(count(*) - 1, 0) * 7 AS bytes
			  FROM bundle_sizes
		), selected AS (
			SELECT p.id,
			       CASE WHEN p.type = 'LINK' AND p."urlScope" = 'PATH_PREFIX' THEN 'crawl'
			            WHEN p.type = 'INTEGRATION' AND b.count > 0 THEN 'conversation'
			            ELSE 'inline' END AS kind,
			       CASE WHEN p.type = 'LINK' AND p."urlScope" = 'PATH_PREFIX' THEN u.bytes
			            WHEN p.type = 'INTEGRATION' AND b.count > 0 THEN b.bytes
			            ELSE p."inlineBytes" END AS bytes
			  FROM parent p CROSS JOIN url_total u CROSS JOIN bundle_total b
		)
		SELECT CASE WHEN selected.bytes > ${scope.maxBytes} THEN ''
		       WHEN selected.kind = 'crawl' THEN (
		         SELECT COALESCE(string_agg(
		           concat('## ', COALESCE(NULLIF(child."pageTitle", ''), child."pageUrl"),
		                  chr(10), child."pageUrl", chr(10), chr(10), child.content, chr(10)),
		           concat(chr(10), '---', chr(10), chr(10)) ORDER BY child."pageUrl", child.id
		         ), '')
		           FROM project_context_url_page child JOIN url_sizes sized ON sized.id = child.id
		       )
		       WHEN selected.kind = 'conversation' THEN (
		         SELECT COALESCE(string_agg(child.content,
		           concat(chr(10), chr(10), '---', chr(10), chr(10))
		           ORDER BY child."bundleStartedAt", child.id
		         ), '')
		           FROM project_context_conversation_bundle child JOIN bundle_sizes sized ON sized.id = child.id
		       )
		       ELSE (SELECT content FROM project_context WHERE id = selected.id)
		       END AS content,
		       selected.bytes > ${scope.maxBytes} AS truncated
		  FROM selected
	`;
	const content = row?.content ?? "";
	return {
		content,
		truncated: row?.truncated ?? false,
		hasReadableText: content.trim().length > 0,
	};
}
