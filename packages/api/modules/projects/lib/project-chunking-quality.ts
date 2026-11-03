/**
 * The chunking quality report of one project (spec 2026-10-28 §8b): its
 * sources from the database, their stored chunks from the index, analysed
 * without a model. Read-only.
 */

import { db } from "@repo/database";
import {
	analyzeChunkQuality,
	type ChunkingQualityReport,
	contentGroupFor,
	contentKindForContext,
	contentKindForDocumentType,
	type QualitySource,
	scrollProjectChunks,
} from "@repo/rag";

/** Points read back at most; a larger project is reported on a prefix. */
const MAX_POINTS = 20_000;

export interface ProjectChunkingQuality extends ChunkingQualityReport {
	/** True when the index held more chunks than were read. */
	truncated: boolean;
	/** Retrieval telemetry is not logged yet, so there is none to show. */
	telemetry: null;
}

/** One source as the quality report groups it, with what names it. */
interface NamedQualitySource extends QualitySource {
	/** What a person recognises: file path, page title, URL or document. */
	title: string;
	origin: "context" | "document";
	/** Where it came from, when known (a repository path or URL). */
	location: string | null;
}

async function loadProjectChunkingSources(
	projectId: string,
	organizationId: string,
): Promise<{ sources: NamedQualitySource[]; truncated: boolean }> {
	const [contexts, documents, stored] = await Promise.all([
		db.projectContext.findMany({
			where: {
				projectId,
				organizationId,
				extractionStatus: "COMPLETED",
				type: { notIn: ["CODE_FILE", "CODE_FILE_SUMMARY"] },
			},
			select: {
				id: true,
				type: true,
				metadata: true,
				content: true,
				mimeType: true,
				originalFilename: true,
				sourceTitle: true,
				sourcePath: true,
				sourceUrl: true,
				embeddedAt: true,
			},
		}),
		db.projectDocument.findMany({
			where: { projectId, organizationId, isActive: true },
			select: {
				id: true,
				type: true,
				title: true,
				content: true,
				embeddedAt: true,
			},
		}),
		scrollProjectChunks({
			projectId,
			organizationId,
			maxPoints: MAX_POINTS,
		}),
	]);

	const bySource = new Map<string, typeof stored.chunks>();
	for (const chunk of stored.chunks) {
		const list = bySource.get(chunk.sourceId) ?? [];
		list.push(chunk);
		bySource.set(chunk.sourceId, list);
	}
	const chunksOf = (sourceId: string) =>
		(bySource.get(sourceId) ?? [])
			.sort((a, b) => a.chunkIndex - b.chunkIndex)
			.map((c) => ({
				content: c.content,
				profile: c.profile,
				section: c.section,
			}));

	const sources: NamedQualitySource[] = [
		...contexts.map((row) => ({
			id: row.id,
			title:
				row.sourceTitle ??
				row.originalFilename ??
				row.sourcePath ??
				row.sourceUrl ??
				row.id,
			origin: "context" as const,
			location: row.sourcePath ?? row.sourceUrl ?? null,
			// Grouped as the analysis groups them, so the two tables agree.
			contentType: contentGroupFor({
				kind: contentKindForContext({
					type: row.type,
					metadata: row.metadata,
				}),
				content: row.content,
				mimeType: row.mimeType ?? "",
				filename: row.originalFilename ?? row.id,
			}),
			textLength: row.content.length,
			embedded: row.embeddedAt !== null,
			chunks: chunksOf(row.id),
		})),
		...documents.map((doc) => ({
			id: doc.id,
			title: doc.title,
			origin: "document" as const,
			location: null,
			contentType:
				contentKindForDocumentType(doc.type) ?? `document:${doc.type}`,
			textLength: doc.content.length,
			embedded: doc.embeddedAt !== null,
			chunks: chunksOf(`doc-${doc.id}`),
		})),
	];
	return { sources, truncated: stored.truncated };
}

export async function buildProjectChunkingQuality(
	projectId: string,
	organizationId: string,
): Promise<ProjectChunkingQuality> {
	const { sources, truncated } = await loadProjectChunkingSources(
		projectId,
		organizationId,
	);
	return {
		...analyzeChunkQuality(sources),
		truncated,
		telemetry: null,
	};
}

export interface ChunkingSourceRow {
	id: string;
	title: string;
	origin: "context" | "document";
	location: string | null;
	characters: number;
	chunks: number;
	embedded: boolean;
	/** Profiles on its stored chunks; `setting` for pre-profile chunks. */
	chunkedBy: string[];
}

/**
 * The sources one row of the per-type table counts, a page at a time, so a
 * person can see which files a type covers. Grouped exactly as the report.
 */
export async function listProjectChunkingSources(params: {
	projectId: string;
	organizationId: string;
	contentType: string;
	offset: number;
	limit: number;
}): Promise<{ total: number; rows: ChunkingSourceRow[] }> {
	const { sources } = await loadProjectChunkingSources(
		params.projectId,
		params.organizationId,
	);
	const matching = sources
		.filter((source) => source.contentType === params.contentType)
		.sort((a, b) => a.title.localeCompare(b.title));
	return {
		total: matching.length,
		rows: matching
			.slice(params.offset, params.offset + params.limit)
			.map((source) => ({
				id: source.id,
				title: source.title,
				origin: source.origin,
				location: source.location,
				characters: source.textLength,
				chunks: source.chunks.length,
				embedded: source.embedded,
				chunkedBy: [
					...new Set(
						source.chunks.map((c) => c.profile ?? "setting"),
					),
				].sort(),
			})),
	};
}
