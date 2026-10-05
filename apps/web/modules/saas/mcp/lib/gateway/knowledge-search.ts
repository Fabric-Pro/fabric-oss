import { createHash } from "node:crypto";
import type {
	KnowledgeSearchHit,
	KnowledgeSearchPosition,
} from "@repo/database/prisma/queries/projects/knowledge-search";

const SOURCE_KINDS = [
	"feature",
	"document",
	"context",
	"context_page",
	"context_bundle",
];
export const KNOWLEDGE_SEARCH_DEFAULT_BYTES = 12_000;
export const KNOWLEDGE_SEARCH_MIN_BYTES = 8192;
export const KNOWLEDGE_SEARCH_MAX_BYTES = 50_000;

export function knowledgeSearchFingerprint(
	projectId: string,
	organizationId: string,
	query: string,
): string {
	return createHash("sha256")
		.update(JSON.stringify([projectId, organizationId, query]))
		.digest("hex");
}
function cursor(
	position: KnowledgeSearchPosition,
	fingerprint: string,
): string {
	return Buffer.from(
		JSON.stringify({
			version: 1,
			fingerprint,
			rank: position.rank,
			sourceKind: position.sourceKind,
			sourceId: position.sourceId,
		}),
	).toString("base64url");
}
export function parseKnowledgeSearchCursor(
	value: unknown,
	fingerprint: string,
): KnowledgeSearchPosition | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (
		typeof value !== "string" ||
		value.length > 1024 ||
		!/^[A-Za-z0-9_-]+$/.test(value)
	) {
		throw new Error("cursor must be a valid continuation from this search");
	}
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
	} catch {
		throw new Error("cursor must be a valid continuation from this search");
	}
	if (
		!parsed ||
		parsed.version !== 1 ||
		parsed.fingerprint !== fingerprint ||
		!Number.isInteger(parsed.rank) ||
		![1, 2, 3].includes(parsed.rank as number) ||
		!SOURCE_KINDS.includes(parsed.sourceKind as string) ||
		typeof parsed.sourceId !== "string" ||
		!parsed.sourceId ||
		parsed.sourceId.length > 128
	) {
		throw new Error(
			"cursor does not belong to this project, query and organization",
		);
	}
	return {
		rank: parsed.rank as number,
		sourceKind: parsed.sourceKind as KnowledgeSearchPosition["sourceKind"],
		sourceId: parsed.sourceId,
	};
}
function bound(value: string, max: number) {
	const chars = Array.from(value);
	return {
		value: chars.slice(0, max).join(""),
		truncated: chars.length > max,
	};
}
function present(hit: KnowledgeSearchHit, projectId: string) {
	const title = bound(hit.title, 160);
	const excerpt = bound(hit.excerpt, 480);
	const contextId = hit.parentContextId ?? hit.sourceId;
	const includeUrl = Boolean(
		hit.sourceUrl &&
			Buffer.byteLength(JSON.stringify(hit.sourceUrl), "utf8") <= 1024,
	);
	return {
		id: hit.sourceId,
		sourceKind: hit.sourceKind,
		sourceType: hit.sourceType,
		title: title.value,
		titleTruncated: hit.titleTruncated || title.truncated,
		excerpt: excerpt.value,
		excerptField: hit.excerptField,
		excerptTruncated: hit.excerptTruncated || excerpt.truncated,
		rank: hit.rank,
		matchReason:
			hit.rank === 3
				? "exact_title_or_identifier"
				: hit.rank === 2
					? "title"
					: "body",
		...(hit.identifier
			? { identifier: bound(hit.identifier, 80).value }
			: {}),
		...(includeUrl ? { sourceUrl: hit.sourceUrl } : {}),
		sourceUrlOmitted:
			hit.sourceUrlOmitted || Boolean(hit.sourceUrl && !includeUrl),
		...(hit.sourceKind === "feature"
			? {
					readTool: "fabric_get_feature",
					readArguments: { featureId: hit.sourceId, projectId },
				}
			: hit.sourceKind === "document"
				? {
						readTool: "fabric_get_document",
						readArguments: { documentId: hit.sourceId },
					}
				: {
						contextId,
						...(hit.sourceKind === "context_page"
							? { pageId: hit.sourceId }
							: {}),
						...(hit.sourceKind === "context_bundle"
							? { bundleId: hit.sourceId }
							: {}),
						readTool: "fabric_get_project_context",
						readArguments: { contextId },
					}),
	};
}

/** Emit a complete ranked prefix. Measure the actual compact JSON text, including its cursor. */
export function serializeKnowledgeSearchPage(
	hits: KnowledgeSearchHit[],
	options: {
		projectId: string;
		limit: number;
		maxBytes: number;
		fingerprint: string;
	},
): string {
	const results: ReturnType<typeof present>[] = [];
	const envelope = (
		count: number,
		reason: "response_budget" | "result_limit" | null,
	) => {
		const hasMore = count < hits.length;
		return {
			results,
			returnedCount: count,
			hasMore,
			nextCursor:
				hasMore && count > 0
					? cursor(hits[count - 1], options.fingerprint)
					: null,
			omissionReason: hasMore ? reason : null,
			excludedSources: [
				"CODE_FILE",
				"CODE_FILE_SUMMARY",
				"contexts_without_readable_text",
			],
			consistency: "live_keyset",
		};
	};
	for (const hit of hits.slice(0, options.limit)) {
		results.push(present(hit, options.projectId));
		if (
			Buffer.byteLength(
				JSON.stringify(envelope(results.length, "response_budget")),
				"utf8",
			) > options.maxBytes
		) {
			results.pop();
			if (!results.length) {
				throw new Error(
					"maxBytes cannot fit the first result; increase the response budget",
				);
			}
			return JSON.stringify(envelope(results.length, "response_budget"));
		}
	}
	return JSON.stringify(envelope(results.length, "result_limit"));
}
