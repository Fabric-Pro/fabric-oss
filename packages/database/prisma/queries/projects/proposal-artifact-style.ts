import {
	ARTIFACT_BRAND_SOURCES,
	type ArtifactBrandSource,
	type ArtifactCoverStyle,
	isArtifactCoverStyle,
} from "@repo/utils/artifact-brand-theme";
/** Proposal artifact (Fizzy #2801) — the document's style settings. */

import { HEX_COLOR_PATTERN } from "@repo/utils/brand-colors";
import { db, type Prisma } from "../../client";
import {
	assertDocumentOrganization,
	PROPOSAL_STYLE_MAX_ACCENT_COLORS,
	PROPOSAL_STYLE_MAX_DIRECTION_LENGTH,
	ProposalArtifactTenantError,
} from "./proposal-artifact-shared";

export type DocumentStyleValidationCode =
	| "directionTooLong"
	| "tooManyAccentColors"
	| "invalidColor"
	| "invalidBrandSource"
	| "invalidCoverStyle";

export class DocumentStyleValidationError extends Error {
	constructor(readonly code: DocumentStyleValidationCode) {
		super(`Invalid document style: ${code}`);
		this.name = "DocumentStyleValidationError";
	}
}

export class DocumentStyleConflictError extends Error {
	constructor() {
		super("The proposal style changed. Read it again before saving.");
		this.name = "DocumentStyleConflictError";
	}
}

export interface DocumentStyleFields {
	brandSource?: ArtifactBrandSource;
	coverStyle?: ArtifactCoverStyle | null;
	styleDirection: string | null;
	primaryColor: string | null;
	accentColors: string[];
}

/**
 * Validate and normalize style fields: trimmed direction (empty becomes null)
 * of at most 500 characters, a lowercase `#rrggbb` primary color, and up to
 * three lowercase `#rrggbb` accents.
 */
export function normalizeDocumentStyleFields(input: {
	brandSource?: ArtifactBrandSource;
	coverStyle?: ArtifactCoverStyle | null;
	styleDirection?: string | null;
	primaryColor?: string | null;
	accentColors?: string[];
}): DocumentStyleFields {
	const styleDirection = input.styleDirection?.trim() || null;
	if (
		styleDirection &&
		styleDirection.length > PROPOSAL_STYLE_MAX_DIRECTION_LENGTH
	) {
		throw new DocumentStyleValidationError("directionTooLong");
	}

	const primaryColor = input.primaryColor?.trim() || null;
	if (primaryColor && !HEX_COLOR_PATTERN.test(primaryColor)) {
		throw new DocumentStyleValidationError("invalidColor");
	}

	const accentColors = input.accentColors ?? [];
	if (accentColors.length > PROPOSAL_STYLE_MAX_ACCENT_COLORS) {
		throw new DocumentStyleValidationError("tooManyAccentColors");
	}
	if (!accentColors.every((color) => HEX_COLOR_PATTERN.test(color))) {
		throw new DocumentStyleValidationError("invalidColor");
	}

	if (
		input.brandSource !== undefined &&
		!ARTIFACT_BRAND_SOURCES.some((value) => value === input.brandSource)
	) {
		throw new DocumentStyleValidationError("invalidBrandSource");
	}
	if (
		input.coverStyle !== undefined &&
		input.coverStyle !== null &&
		!isArtifactCoverStyle(input.coverStyle)
	) {
		throw new DocumentStyleValidationError("invalidCoverStyle");
	}
	return {
		...(input.brandSource === undefined
			? {}
			: { brandSource: input.brandSource }),
		...(input.coverStyle === undefined
			? {}
			: { coverStyle: input.coverStyle }),
		styleDirection,
		primaryColor: primaryColor?.toLowerCase() ?? null,
		accentColors: accentColors.map((color) => color.toLowerCase()),
	};
}

const STYLE_VIEW_SELECT = {
	documentId: true,
	projectId: true,
	organizationId: true,
	styleDirection: true,
	primaryColor: true,
	accentColors: true,
	autoVisuals: true,
	brandSource: true,
	coverStyle: true,
	updatedById: true,
	updatedAt: true,
} as const satisfies Prisma.ProjectDocumentStyleSelect;

export type DocumentStyleView = Prisma.ProjectDocumentStyleGetPayload<{
	select: typeof STYLE_VIEW_SELECT;
}>;

/** The document's saved style, scoped to the owning organization. */
export async function getDocumentStyle(input: {
	documentId: string;
	organizationId: string;
}): Promise<DocumentStyleView | null> {
	return db.projectDocumentStyle.findFirst({
		where: {
			documentId: input.documentId,
			organizationId: input.organizationId,
		},
		select: STYLE_VIEW_SELECT,
	});
}

/**
 * Save the document's style, replacing the direction and colours. The
 * automatic-diagrams switch is replaced only when `autoVisuals` is given, so a
 * save that leaves it out keeps the stored value (a new row starts on). Fields
 * are validated
 * before anything is read. The tenant columns come from the document's
 * project; the document must belong to `projectId`, and `organizationId`,
 * when given, is only checked against the project's.
 */
export async function upsertDocumentStyle(input: {
	documentId: string;
	projectId: string;
	organizationId?: string;
	styleDirection: string | null;
	primaryColor: string | null;
	accentColors: string[];
	autoVisuals?: boolean;
	brandSource?: ArtifactBrandSource;
	coverStyle?: ArtifactCoverStyle | null;
	expectedUpdatedAt?: Date | null;
	updatedById: string | null;
}): Promise<DocumentStyleView> {
	const fields = normalizeDocumentStyleFields(input);

	const document = await db.projectDocument.findFirst({
		where: { id: input.documentId, projectId: input.projectId },
		select: { project: { select: { organizationId: true } } },
	});
	assertDocumentOrganization(
		document?.project.organizationId,
		input.organizationId || undefined,
	);
	const organizationId = document.project.organizationId;

	// Serialize all Style writers, including an initial save without a row. The
	// timestamp advances monotonically so two writes in one millisecond cannot
	// make a reviewed timestamp valid again. Existing callers may omit CAS.
	return db.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`proposal-style:${input.documentId}`}, 0))`;
		const current = await tx.projectDocumentStyle.findUnique({
			where: { documentId: input.documentId },
			select: { updatedAt: true, organizationId: true, projectId: true },
		});
		if (
			current &&
			(current.organizationId !== organizationId ||
				current.projectId !== input.projectId)
		) {
			throw new ProposalArtifactTenantError(
				"The saved Style belongs to another project or organization",
			);
		}
		if (
			input.expectedUpdatedAt !== undefined &&
			(current?.updatedAt.getTime() ?? null) !==
				(input.expectedUpdatedAt?.getTime() ?? null)
		) {
			throw new DocumentStyleConflictError();
		}
		const updatedAt = new Date(
			Math.max(Date.now(), (current?.updatedAt.getTime() ?? 0) + 1),
		);
		return tx.projectDocumentStyle.upsert({
			where: { documentId: input.documentId },
			create: {
				documentId: input.documentId,
				projectId: input.projectId,
				organizationId,
				...fields,
				autoVisuals: input.autoVisuals ?? true,
				updatedById: input.updatedById,
				updatedAt,
			},
			update: {
				...fields,
				...(input.autoVisuals === undefined
					? {}
					: { autoVisuals: input.autoVisuals }),
				updatedById: input.updatedById,
				updatedAt,
			},
			select: STYLE_VIEW_SELECT,
		});
	});
}
