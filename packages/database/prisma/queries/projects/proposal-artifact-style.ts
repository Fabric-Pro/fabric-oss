/** Proposal artifact (Fizzy #2801) — the document's style settings. */

import { HEX_COLOR_PATTERN } from "@repo/utils/brand-colors";
import { db, type Prisma } from "../../client";
import {
	assertDocumentOrganization,
	PROPOSAL_STYLE_MAX_ACCENT_COLORS,
	PROPOSAL_STYLE_MAX_DIRECTION_LENGTH,
} from "./proposal-artifact-shared";

export type DocumentStyleValidationCode =
	| "directionTooLong"
	| "tooManyAccentColors"
	| "invalidColor";

export class DocumentStyleValidationError extends Error {
	constructor(readonly code: DocumentStyleValidationCode) {
		super(`Invalid document style: ${code}`);
		this.name = "DocumentStyleValidationError";
	}
}

export interface DocumentStyleFields {
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

	return {
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
 * Save the document's style, replacing every field. Fields are validated
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

	return db.projectDocumentStyle.upsert({
		where: { documentId: input.documentId },
		create: {
			documentId: input.documentId,
			projectId: input.projectId,
			organizationId,
			...fields,
			updatedById: input.updatedById,
		},
		update: { ...fields, updatedById: input.updatedById },
		select: STYLE_VIEW_SELECT,
	});
}
