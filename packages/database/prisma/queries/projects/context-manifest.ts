import {
	createOrganizationContext,
	runWithTenantContext,
} from "../../../src/tenant-context";
import { withRLSContext } from "../../../src/tenant-db";
import { db, Prisma } from "../../client";

export interface ContextManifestMetadata {
	sourceId: string;
	title: string;
	type: string;
	extractionStatus: string;
	indexingExcluded: boolean;
	updatedAt: Date;
	hasLifecycle: boolean;
	bodyKind: "inline" | "composite";
	hasText: boolean;
	privateConversation: boolean;
	byteLength: number | null;
	revision: string | null;
}
const TRIM_CHARACTERS =
	"\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF";

/**
 * Metadata only; hashing/trimming is SQL-side and bounded to 96 KiB inline bodies.
 * Oversized bodies conservatively require canonical inspection, even if whitespace.
 */
export async function listContextManifestMetadata(input: {
	userId: string;
	organizationId: string;
	projectId: string;
	limit: number;
	offset: number;
	includeCodeContexts: boolean;
	type?: string;
}) {
	if (
		![input.userId, input.organizationId, input.projectId].every(
			(id) => typeof id === "string" && id.length > 0 && id.length <= 128,
		) ||
		!Number.isInteger(input.limit) ||
		input.limit < 1 ||
		input.limit > 50 ||
		!Number.isInteger(input.offset) ||
		input.offset < 0 ||
		input.offset > 2147483646
	)
		throw new Error("Invalid context manifest scope or page.");
	const hideCode = !input.type && !input.includeCodeContexts;
	const base = Prisma.sql`"projectId" = ${input.projectId} AND "organizationId" = ${input.organizationId}`;
	const filter = Prisma.sql`${base} AND (${input.type ?? null}::text IS NULL OR type::text = ${input.type ?? null}::text) AND (NOT ${hideCode}::boolean OR type NOT IN ('CODE_FILE', 'CODE_FILE_SUMMARY'))`;
	return runWithTenantContext(
		createOrganizationContext(input.organizationId, input.userId),
		() =>
			withRLSContext(db, async (tx) => {
				const rows = await tx.$queryRaw<
					ContextManifestMetadata[]
				>(Prisma.sql`
			WITH page AS (
				SELECT id, "projectId", "organizationId", type, content, "sourceTitle", "originalFilename", "extractionStatus", "indexingExcluded", "urlScope", metadata, "createdAt", "updatedAt"
				FROM project_context WHERE ${filter}
				ORDER BY "createdAt" DESC, id DESC LIMIT ${input.limit + 1}::integer OFFSET ${input.offset}::integer
			), state AS (
				SELECT p.*,
					(p.type <> 'INTEGRATION' OR p.metadata->>'source' = 'google-docs') IS TRUE AS lifecycle,
					((p.type = 'LINK' AND p."urlScope" = 'PATH_PREFIX') OR
					(p.type = 'INTEGRATION' AND EXISTS (SELECT 1 FROM project_context_conversation_bundle b WHERE b."parentContextId" = p.id AND b."projectId" = p."projectId" AND b."organizationId" = p."organizationId" AND b.content <> ''))) IS TRUE AS composite,
					CASE WHEN octet_length(COALESCE(p.content, '')) > 98304 THEN true
					ELSE length(btrim(COALESCE(p.content, ''), ${TRIM_CHARACTERS})) > 0 END AS inline_text
				FROM page p
			)
			SELECT p.id AS "sourceId", left(COALESCE(NULLIF(p."sourceTitle", ''),
				CASE WHEN jsonb_typeof(p.metadata->'title') = 'string' THEN NULLIF(p.metadata->>'title', '') END,
				CASE WHEN jsonb_typeof(p.metadata->'documentTitle') = 'string' THEN NULLIF(p.metadata->>'documentTitle', '') END,
				NULLIF(p."originalFilename", ''), 'Untitled context'), 240) AS title,
				p.type::text, p."extractionStatus"::text, p."indexingExcluded", p."updatedAt", p.lifecycle AS "hasLifecycle",
				CASE WHEN p.composite THEN 'composite' ELSE 'inline' END AS "bodyKind",
				CASE WHEN p.composite AND p.type = 'LINK' THEN EXISTS (SELECT 1 FROM project_context_url_page u WHERE u."parentContextId" = p.id AND u."projectId" = p."projectId" AND u."organizationId" = p."organizationId" AND u.content <> '')
				WHEN p.composite THEN EXISTS (SELECT 1 FROM project_context_conversation_bundle b WHERE b."parentContextId" = p.id AND b."projectId" = p."projectId" AND b."organizationId" = p."organizationId" AND CASE WHEN octet_length(b.content) > 98304 THEN true ELSE length(btrim(b.content, ${TRIM_CHARACTERS})) > 0 END)
				ELSE p.inline_text END AS "hasText",
				(p.type = 'INTEGRATION' AND upper(p.metadata->>'provider') IN ('SLACK','TEAMS','MICROSOFT_TEAMS') AND jsonb_typeof(p.metadata->'chatId') = 'string' AND (jsonb_typeof(p.metadata->'channelId') = 'string' AND COALESCE(p.metadata->>'chatType', 'channel') = 'channel') IS NOT TRUE) IS TRUE AS "privateConversation",
				CASE WHEN NOT p.composite THEN octet_length(COALESCE(p.content, '')) END AS "byteLength",
				CASE WHEN NOT p.composite AND p.inline_text AND (NOT p.lifecycle OR p."extractionStatus" = 'COMPLETED') AND octet_length(p.content) <= 98304
				THEN encode(sha256(convert_to(p.content, 'UTF8')), 'hex') END AS revision
			FROM state p ORDER BY p."createdAt" DESC, p.id DESC
		`);
				const [counts] = await tx.$queryRaw<
					{ total: number; excludedCodeContexts: number }[]
				>(Prisma.sql`
			SELECT (SELECT count(*)::integer FROM project_context WHERE ${filter}) AS total,
				CASE WHEN ${hideCode}::boolean THEN (SELECT count(*)::integer FROM project_context WHERE ${base} AND type IN ('CODE_FILE','CODE_FILE_SUMMARY')) ELSE 0 END AS "excludedCodeContexts"
		`);
				return {
					rows: rows.slice(0, input.limit),
					total: counts?.total ?? 0,
					excludedCodeContexts: counts?.excludedCodeContexts ?? 0,
					hasMore: rows.length > input.limit,
				};
			}),
	);
}
