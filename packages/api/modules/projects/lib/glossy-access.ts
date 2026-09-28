import { ORPCError } from "@orpc/client";
import { GLOSSY_STYLE_DIRECTION_MAX_CHARS } from "@repo/agent-prompts/glossy";
import { canEditProject, db } from "@repo/database";
import { HEX_COLOR_PATTERN } from "@repo/utils/brand-colors";
import {
	type EditionContent,
	type EditionVisual,
	editionContentSchema,
} from "@repo/utils/glossy/edition-content";
import { isGlossyEligible } from "@repo/utils/glossy/eligibility";
import { z } from "zod";
import { loadDocumentForAutoRefresh } from "./auto-refresh-document-access";
import { assertGlossyEnabled } from "./glossy-feature";

/**
 * The gate every Glossy edition procedure runs after
 * `requireProjectPermission` (Fizzy #2589, KTD19, KTD20). The middleware has
 * already answered NOT_FOUND to a caller with no tie to the project and
 * FORBIDDEN to one whose role lacks DOCUMENT_READ (reads) or DOCUMENT_UPDATE
 * (writes). Then, in NOT_FOUND-before-FORBIDDEN order:
 *
 *  1. the rollout gate, resolved from the project row — NOT_FOUND when off,
 *     for every procedure (AE10);
 *  2. a trashed project, or one outside any organization — NOT_FOUND;
 *  3. `loadDocumentForAutoRefresh`: a document outside this project, or whose
 *     organization is not the project's, is NOT_FOUND; a caller without
 *     `hasProjectAccess` is FORBIDDEN;
 *  4. writes also need `canEditProject` — FORBIDDEN otherwise. The database
 *     does not make this decision: the Glossy tables' RLS `USING` clause
 *     admits every accepted project member, viewers included, by design.
 *
 * The organization handed to step 3 is the project's own, read from the row
 * after the middleware proved the caller's tie to that project — never one
 * the client sent, and not the session's active organization, which names an
 * invited guest's own organization rather than the host's, and may name
 * another organization for someone who belongs to several. It is returned as the one
 * id that drives the flag, BYOK resolution, storage keys, the workflow
 * input, and audit (KTD19).
 */

type GlossyDocument = Awaited<ReturnType<typeof loadDocumentForAutoRefresh>>;

export interface GlossyDocumentAccess {
	document: GlossyDocument;
	/** The document's organization: the project's, checked against the document's. */
	organizationId: string;
}

export async function loadGlossyDocument(args: {
	projectId: string;
	documentId: string;
	userId: string;
	write: boolean;
}): Promise<GlossyDocumentAccess> {
	await assertGlossyEnabled(args.projectId);

	const project = await db.project.findUnique({
		where: { id: args.projectId },
		select: { organizationId: true, deletedAt: true },
	});
	if (!project || project.deletedAt || !project.organizationId) {
		throw new ORPCError("NOT_FOUND", { message: "Project not found" });
	}

	const document = await loadDocumentForAutoRefresh({
		documentId: args.documentId,
		projectId: args.projectId,
		userId: args.userId,
		organizationId: project.organizationId,
	});

	if (args.write && !(await canEditProject(args.projectId, args.userId))) {
		throw new ORPCError("FORBIDDEN", {
			message: "You don't have permission to edit this project",
		});
	}

	return { document, organizationId: project.organizationId };
}

/** Why a document cannot be built now (R2, R3). */
export const GLOSSY_INELIGIBLE_REASONS = [
	/** Not a Proposal or Business Case. */
	"documentType",
	/** The generation workflow still owns the document. */
	"generating",
	/** The document has no content. */
	"empty",
	/** Nothing survives cleanup (Align first computes this in the request). */
	"nothingToPresent",
] as const;

export type GlossyIneligibleReason = (typeof GLOSSY_INELIGIBLE_REASONS)[number];

/** Statuses of a document the generation workflow still owns (R3). */
const MID_GENERATION = new Set(["QUEUED", "GENERATING"]);

/**
 * Whether the document can be built now, and why not. The build's prepare
 * step re-checks the type and the generation status against the snapshot,
 * because minutes may pass between the two.
 */
export function glossyIneligibility(document: {
	type: string;
	status: string;
	content: string;
}): Exclude<GlossyIneligibleReason, "nothingToPresent"> | null {
	if (!isGlossyEligible(document.type)) {
		return "documentType";
	}
	if (MID_GENERATION.has(document.status)) {
		return "generating";
	}
	if (!document.content.trim()) {
		return "empty";
	}
	return null;
}

// ---------------------------------------------------------------------------
// Build options, as recorded
// ---------------------------------------------------------------------------

/** Lowercase `#rrggbb`, the only color shape the Glossy palette accepts. */
const glossyHexColorSchema = z
	.string()
	.trim()
	.regex(HEX_COLOR_PATTERN)
	.transform((value) => value.toLowerCase());

/**
 * Align first's per-edition preparer colors (U13's palette overrides). They
 * shape rendering only, so the build records them with its options for the
 * page to read back, and the workflow never sees them.
 */
export const glossyPreparerOverridesSchema = z.object({
	primary: glossyHexColorSchema.nullable().optional(),
	accents: z.array(glossyHexColorSchema).max(3).optional(),
});

/**
 * The options a build recorded on the edition (`lastOptions`), as `get`
 * returns them to prefill the next build. The confirmed opportunities are
 * left out: they name sections of a body that may since have changed, and
 * Align first detects again anyway.
 */
export const glossyLastOptionsSchema = z.object({
	mode: z.enum(["roll_the_dice", "align_first"]),
	lengthMode: z.enum(["brief", "standard"]),
	styleDirection: z
		.string()
		.max(GLOSSY_STYLE_DIRECTION_MAX_CHARS)
		.nullable()
		.optional(),
	preparerOverrides: glossyPreparerOverridesSchema.nullable().optional(),
});

export type GlossyLastOptions = z.infer<typeof glossyLastOptionsSchema>;

/** A stored options value this code cannot read counts as none. */
export function readGlossyLastOptions(
	value: unknown,
): GlossyLastOptions | null {
	const parsed = glossyLastOptionsSchema.safeParse(value);
	if (!parsed.success) {
		return null;
	}
	return {
		mode: parsed.data.mode,
		lengthMode: parsed.data.lengthMode,
		styleDirection: parsed.data.styleDirection ?? null,
		preparerOverrides: parsed.data.preparerOverrides ?? null,
	};
}

// ---------------------------------------------------------------------------
// Who started a build
// ---------------------------------------------------------------------------

export const glossyUserRefSchema = z.object({
	id: z.string(),
	name: z.string().nullable(),
});

export type GlossyUserRef = z.infer<typeof glossyUserRefSchema>;

/**
 * The display name of each build starter, for "building — started by …".
 * Name only: the page is open to every project member, guests included.
 */
export async function loadGlossyUserRefs(
	userIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, GlossyUserRef>> {
	const ids = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
	if (ids.length === 0) {
		return new Map();
	}
	const users = await db.user.findMany({
		where: { id: { in: ids } },
		select: { id: true, name: true },
	});
	return new Map(
		users.map((user) => [
			user.id,
			{ id: user.id, name: user.name ?? null },
		]),
	);
}

/** The attempt holding a build, as `build` and `regenerate` report it. */
export const glossyHolderSchema = z
	.object({
		startedBy: glossyUserRefSchema.nullable(),
		startedAt: z.date(),
	})
	.nullable();

export async function presentGlossyHolder(
	holder: { startedById: string | null; startedAt: Date } | null,
): Promise<z.infer<typeof glossyHolderSchema>> {
	if (!holder) {
		return null;
	}
	const starters = await loadGlossyUserRefs([holder.startedById]);
	return {
		startedBy: holder.startedById
			? (starters.get(holder.startedById) ?? null)
			: null,
		startedAt: holder.startedAt,
	};
}

// ---------------------------------------------------------------------------
// Visuals of the published edition (regenerate and review, U20)
// ---------------------------------------------------------------------------

/** Stored edition content, or null when there is none or this code cannot read it. */
export function readGlossyEditionContent(
	value: unknown,
): EditionContent | null {
	if (value === null || value === undefined) {
		return null;
	}
	const parsed = editionContentSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

/**
 * The decision key of a diagram only the source's own Appendix shows; a build
 * keeps decisions filed under it (finalize passes it as a live section).
 */
export { GLOSSY_APPENDIX_SECTION_KEY } from "@repo/utils/glossy/edition-content";

export interface LocatedGlossyVisual {
	visual: EditionVisual;
	/** The main-flow section that shows it; null for a diagram only the appendix shows. */
	sectionKey: string | null;
}

/**
 * A visual the published content both holds and shows (KTD19: a visual key
 * must exist in the current edition content), with the section it hangs
 * off. A key the content does not hold, or holds without any anchor showing
 * it, is not reviewable.
 */
export function locateGlossyVisual(
	content: EditionContent,
	visualKey: string,
): LocatedGlossyVisual | null {
	if (!Object.hasOwn(content.visuals, visualKey)) {
		return null;
	}
	const visual = content.visuals[visualKey];
	const shows = (anchors: EditionContent["sections"][number]["anchors"]) =>
		anchors.some(
			(anchor) =>
				anchor.ref.type === "visual" &&
				anchor.ref.visualKey === visualKey,
		);
	const section = content.sections.find((entry) => shows(entry.anchors));
	if (section) {
		return { visual, sectionKey: section.sectionKey };
	}
	if (
		content.appendix.additionalMaterial.some((entry) =>
			shows(entry.anchors),
		)
	) {
		return { visual, sectionKey: null };
	}
	return null;
}
