import { createHash } from "node:crypto";
import { hasExtractionLifecycle } from "@repo/database/src/context-extraction-lifecycle";
import { resolveContextTitle } from "@repo/database/src/project-context-presentation";
import { hasPermission, type Permission, Permissions } from "@repo/permissions";

export const MAX_CONTEXT_QUALITY_SOURCE_BYTES = 96 * 1024;

export type ContextReadErrorCode =
	| "INVALID_SCOPE"
	| "INVALID_REVISION"
	| "NOT_FOUND"
	| "FORBIDDEN"
	| "NOT_READY"
	| "TOO_LARGE"
	| "STALE_REVISION";

const MESSAGES: Record<ContextReadErrorCode, string> = {
	INVALID_SCOPE: "An organization, project, subject and source are required.",
	INVALID_REVISION:
		"Use the exact lowercase SHA-256 revision returned by source inspection.",
	NOT_FOUND: "Context source is unavailable.",
	FORBIDDEN: "No permission to read context sources of this project.",
	NOT_READY: "Context source has no completed readable content.",
	TOO_LARGE: "Context source exceeds the offline quality snapshot limit.",
	STALE_REVISION: "Context source changed. Read it again before evaluating.",
};

/** Safe for transport adapters: messages never interpolate source/provider metadata. */
export class ContextReadError extends Error {
	constructor(readonly code: ContextReadErrorCode) {
		super(MESSAGES[code]);
		this.name = "ContextReadError";
	}
}

export interface ProjectContextReadInput {
	organizationId: string;
	projectId: string;
	userId: string;
	sourceId: string;
	/** Current content pin, not a request to retrieve historical source bytes. */
	expectedRevision?: string;
}

export interface ProjectContextSnapshot {
	sourceId: string;
	sourceKind: "project_context";
	projectId: string;
	organizationId: string;
	title: string;
	content: string;
	/** SHA-256 of the exact returned UTF-8 bytes, without newline normalization. */
	revision: string;
	byteLength: number;
	indexingExcluded: boolean;
	readMode: "direct";
}

interface ContextRow {
	id: string;
	projectId: string;
	organizationId: string | null;
	type: string;
	urlScope: string | null;
	content: string | null;
	extractionStatus: string;
	indexingExcluded: boolean;
	updatedAt: Date;
	sourceTitle?: string | null;
	originalFilename?: string | null;
	metadata?: unknown;
}

/** Internal adapters retain the existing authorization and canonical body-reader contracts. */
interface ContextReaderDependencies {
	resolveAccess: (
		projectId: string,
		userId: string,
	) => Promise<{
		organizationId: string | null;
		organizationDeleted?: boolean;
		permissions: readonly Permission[];
	} | null>;
	hasProjectAccess: (
		projectId: string,
		userId: string,
		organizationId: string,
	) => Promise<boolean>;
	isProjectSoftDeleted: (projectId: string) => Promise<boolean>;
	getContext: (
		sourceId: string,
		projectId: string,
		tenant: { userId: string; organizationId: string },
	) => Promise<ContextRow | null>;
	readBody: (
		row: ContextRow,
		tenant: { userId: string; organizationId: string },
		page: { offset: number; maxLength: number },
	) => Promise<{
		content: string;
		truncated: boolean;
		hasReadableText: boolean;
	}>;
}

function validId(value: string): boolean {
	return (
		typeof value === "string" &&
		value.trim().length > 0 &&
		value.length <= 128
	);
}

/**
 * Direct reads only: STORE_ONLY remains readable, and nothing is added to search,
 * prompts or traces. Each invocation repeats live authorization, including after
 * the canonical reader's asynchronous child/bundle reads. The digest describes
 * the observed body, not an approved publication or frozen search-index build.
 */
export function createProjectContextReader(
	dependencies: ContextReaderDependencies,
) {
	async function authorize(input: ProjectContextReadInput): Promise<void> {
		const access = await dependencies.resolveAccess(
			input.projectId,
			input.userId,
		);
		if (
			!access ||
			access.organizationId !== input.organizationId ||
			access.organizationDeleted ||
			!(await dependencies.hasProjectAccess(
				input.projectId,
				input.userId,
				input.organizationId,
			)) ||
			(await dependencies.isProjectSoftDeleted(input.projectId))
		) {
			throw new ContextReadError("NOT_FOUND");
		}
		if (!hasPermission(access.permissions, Permissions.CONTEXT_READ)) {
			throw new ContextReadError("FORBIDDEN");
		}
	}

	async function load(
		input: ProjectContextReadInput,
		requireReady = true,
	): Promise<ContextRow> {
		const row = await dependencies.getContext(
			input.sourceId,
			input.projectId,
			{
				userId: input.userId,
				organizationId: input.organizationId,
			},
		);
		if (
			!row ||
			row.id !== input.sourceId ||
			row.projectId !== input.projectId ||
			row.organizationId !== input.organizationId
		) {
			throw new ContextReadError("NOT_FOUND");
		}
		if (
			requireReady &&
			hasExtractionLifecycle(row) &&
			row.extractionStatus !== "COMPLETED"
		) {
			throw new ContextReadError("NOT_READY");
		}
		return row;
	}

	const read = async function read(
		input: ProjectContextReadInput,
	): Promise<ProjectContextSnapshot> {
		if (
			![
				input.organizationId,
				input.projectId,
				input.userId,
				input.sourceId,
			].every(validId)
		) {
			throw new ContextReadError("INVALID_SCOPE");
		}
		if (
			input.expectedRevision !== undefined &&
			!/^[a-f0-9]{64}$/.test(input.expectedRevision)
		) {
			throw new ContextReadError("INVALID_REVISION");
		}
		await authorize(input);
		const row = await load(input);
		const body = await dependencies.readBody(
			row,
			{ userId: input.userId, organizationId: input.organizationId },
			// The production adapter enforces this UTF-8 byte ceiling inside SQL
			// before transferring/assembling any source body in Node.
			{ offset: 0, maxLength: MAX_CONTEXT_QUALITY_SOURCE_BYTES },
		);
		// Recheck access and parent state after the bounded body query. Child
		// bodies are one observed read, not historical/as-of reconstruction.
		await authorize(input);
		const current = await load(input);
		if (
			current.updatedAt.getTime() !== row.updatedAt.getTime() ||
			current.content !== row.content ||
			current.type !== row.type ||
			current.urlScope !== row.urlScope ||
			current.indexingExcluded !== row.indexingExcluded
		) {
			throw new ContextReadError("STALE_REVISION");
		}
		if (
			current.type === "INTEGRATION" ||
			(current.type === "LINK" && current.urlScope === "PATH_PREFIX")
		) {
			// Captures/pages can change without updating their parent. Revalidate
			// the exact bounded body after the asynchronous authorization fence,
			// rather than accepting a parent timestamp as a child revision.
			const confirmed = await dependencies.readBody(
				current,
				{ userId: input.userId, organizationId: input.organizationId },
				{ offset: 0, maxLength: MAX_CONTEXT_QUALITY_SOURCE_BYTES },
			);
			if (
				confirmed.content !== body.content ||
				confirmed.truncated !== body.truncated ||
				confirmed.hasReadableText !== body.hasReadableText
			) {
				throw new ContextReadError("STALE_REVISION");
			}
		}
		const byteLength = Buffer.byteLength(body.content, "utf8");
		if (body.truncated || byteLength > MAX_CONTEXT_QUALITY_SOURCE_BYTES) {
			throw new ContextReadError("TOO_LARGE");
		}
		if (!body.hasReadableText || body.content.trim().length === 0) {
			throw new ContextReadError("NOT_READY");
		}
		const revision = createHash("sha256")
			.update(body.content, "utf8")
			.digest("hex");
		if (
			input.expectedRevision !== undefined &&
			input.expectedRevision !== revision
		) {
			throw new ContextReadError("STALE_REVISION");
		}
		return {
			sourceId: row.id,
			sourceKind: "project_context",
			projectId: input.projectId,
			organizationId: input.organizationId,
			title: Array.from(resolveContextTitle(current))
				.slice(0, 240)
				.join(""),
			content: body.content,
			revision,
			byteLength,
			indexingExcluded: current.indexingExcluded,
			readMode: "direct",
		};
	};
	return Object.assign(read, {
		/** Current access only: historical safe reports do not require matching current content. */
		async assertAccess(
			input: Omit<ProjectContextReadInput, "expectedRevision">,
		) {
			if (
				![
					input.organizationId,
					input.projectId,
					input.userId,
					input.sourceId,
				].every(validId)
			) {
				throw new ContextReadError("INVALID_SCOPE");
			}
			await authorize(input);
			await load(input, false);
			await authorize(input);
			await load(input, false);
		},
	});
}

/** Production wiring is lazy so pure facade tests need no database connection. */
async function productionReader() {
	const [database, permissions, boundedSources] = await Promise.all([
		import("@repo/database"),
		import("./project-access"),
		import("@repo/database/prisma/queries/projects/context-quality-body"),
	]);
	return createProjectContextReader({
		resolveAccess: permissions.resolveEffectiveProjectPermissions,
		hasProjectAccess: database.hasProjectAccess,
		isProjectSoftDeleted: database.isProjectSoftDeleted,
		getContext: (sourceId, projectId, tenant) =>
			boundedSources.getContextQualitySourceMetadata({
				sourceId,
				projectId,
				organizationId: tenant.organizationId,
			}),
		readBody: (row, tenant, page) =>
			boundedSources.readContextQualitySourceBody({
				sourceId: row.id,
				projectId: row.projectId,
				organizationId: tenant.organizationId,
				maxBytes: page.maxLength,
			}),
	});
}

export async function readProjectContextSnapshot(
	input: ProjectContextReadInput,
): Promise<ProjectContextSnapshot> {
	return (await productionReader())(input);
}

export async function assertProjectContextSourceAccess(
	input: Omit<ProjectContextReadInput, "expectedRevision">,
): Promise<void> {
	await (await productionReader()).assertAccess(input);
}
