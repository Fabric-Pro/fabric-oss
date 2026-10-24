import { ORPCError } from "@orpc/client";
import { config } from "@repo/config";
import { db } from "@repo/database";
import { getObjectStream, getStorageProvider } from "@repo/storage";
import {
	BRAND_ASSET_MAX_BYTES,
	BRAND_FONT_CONTENT_TYPES,
	type BrandFontFormat,
} from "@repo/utils/brand-assets";
import { organizationBrandAssetId } from "@repo/utils/proposal-artifact/brand-sources";
import { safeFontFamily } from "@repo/utils/proposal-artifact/theme-tokens";
import { z } from "zod";
import { decodeBrandFont } from "../../../../lib/brand-font";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { loadProposalClientDocument } from "../../lib/proposal-artifact-access";
import { requireProposalArtifactEnabled } from "../../lib/proposal-artifact-feature";

/** The largest font file a Brand kit upload accepts, and so the most read here. */
const FONT_MAX_BYTES = BRAND_ASSET_MAX_BYTES.font;

const THEME_FONT_SLOTS = ["display", "body"] as const;
type ThemeFontSlot = (typeof THEME_FONT_SLOTS)[number];

/** Every format a Brand kit font is stored in. */
const THEME_FONT_FORMATS = Object.keys(BRAND_FONT_CONTENT_TYPES) as [
	BrandFontFormat,
	...BrandFontFormat[],
];

/** The same one refusal for every failure: nothing here names what it found. */
function fontNotFound(): ORPCError<"NOT_FOUND", unknown> {
	return new ORPCError("NOT_FOUND", { message: "Font not found" });
}

/**
 * The slot's current family and font key on the owning organization's Brand
 * kit. Only the four font columns are selected: this read reaches project
 * guests, so nothing else of the kit is even loaded.
 */
async function readBrandKitFont(
	organizationId: string,
	slot: ThemeFontSlot,
): Promise<{ family: string | null; key: string | null } | null> {
	const kit = await db.organizationBrandKit.findUnique({
		where: { organizationId },
		select: {
			displayFontFamily: true,
			displayFontKey: true,
			bodyFontFamily: true,
			bodyFontKey: true,
		},
	});
	if (!kit) {
		return null;
	}
	return slot === "display"
		? { family: kit.displayFontFamily, key: kit.displayFontKey }
		: { family: kit.bodyFontFamily, key: kit.bodyFontKey };
}

/**
 * The stored font's bytes, or null when it is missing, empty or larger than
 * {@link FONT_MAX_BYTES}. The stored size is checked before anything is
 * read, and the bytes are counted again as they arrive, so no more than the
 * cap and one chunk are ever held whatever the object turns out to be.
 */
async function readFontWithin(key: string): Promise<Buffer | null> {
	const bucket = config.storage.bucketNames.projectContexts;
	const metadata = await getStorageProvider().getFileMetadata(key, {
		bucket,
	});
	if (!metadata || metadata.size <= 0 || metadata.size > FONT_MAX_BYTES) {
		return null;
	}
	const stream = await getObjectStream(key, { bucket });
	const chunks: Buffer[] = [];
	let total = 0;
	try {
		for await (const chunk of stream) {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			total += bytes.length;
			if (total > FONT_MAX_BYTES) {
				return null;
			}
			chunks.push(bytes);
		}
	} finally {
		// Releases the connection whether the read finished or was abandoned.
		stream.destroy();
	}
	return total > 0 ? Buffer.concat(chunks, total) : null;
}

/**
 * One uploaded Brand kit font of a Proposal in artifact mode (Fizzy #2946),
 * for the live page to register under its own alias: the bytes as base64,
 * the format they declare and the family the Brand kit names for the slot.
 * Members and project guests read it alike, as they read the tokens that
 * carry its file id. Print does not use it.
 *
 * The file is the slot's CURRENT one only: the Brand kit's family for the
 * slot must be one the theme may write, and its font key must be a promoted
 * font of the owning organization whose id is exactly `fileId`, all checked
 * before storage is touched, so an id from another organization, an older
 * upload or a guess reads nothing. The stored size is checked before the
 * read, at most 512 KiB is read, and bytes that do not decode as the WOFF2
 * or TrueType font their key names are refused. Every refusal is the same
 * NOT_FOUND, and the page keeps its fallback font. A read, so no audit row.
 *
 * AUTHORIZATION: as `getThemeTokens`: `requireProposalArtifactEnabled` first
 * (gate off → NOT_FOUND for every caller), then
 * `requireProjectPermission(DOCUMENT_READ)`, then `loadProposalClientDocument`
 * (document in project, project access, a Proposal with the gate on for the
 * owning organization; NOT_FOUND for every failure). No membership of the
 * owning organization is required.
 */
export const getProposalThemeFontProcedure = tenantProtectedProcedure
	.use(requireProposalArtifactEnabled())
	.use(requireProjectPermission(Permissions.DOCUMENT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/documents/{documentId}/proposal-artifact/theme-font",
		tags: ["Projects", "Proposal artifact"],
		summary: "Get a Proposal theme font",
		description:
			"The bytes of one uploaded Brand kit font a Proposal's live page wears, by the file id its theme tokens carry. Readable by anyone with access to the project.",
	})
	.input(
		z.object({
			projectId: z.string(),
			documentId: z.string(),
			slot: z.enum(THEME_FONT_SLOTS),
			fileId: z.string().min(1).max(128),
		}),
	)
	.output(
		z.object({
			family: z.string(),
			format: z.enum(THEME_FONT_FORMATS),
			base64: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { organizationId } = await loadProposalClientDocument({
			projectId: input.projectId,
			documentId: input.documentId,
			userId: context.user.id,
		});

		const font = await readBrandKitFont(organizationId, input.slot);
		const family = safeFontFamily(font?.family);
		// A file counts only with the family it is uploaded for, as in the
		// tokens, so an id the page was never handed is refused here too.
		if (
			!font?.key ||
			!family ||
			organizationBrandAssetId(organizationId, "fonts", font.key) !==
				input.fileId
		) {
			throw fontNotFound();
		}
		const declared = font.key.slice(font.key.lastIndexOf(".") + 1);

		let bytes: Buffer | null;
		try {
			bytes = await readFontWithin(font.key);
		} catch {
			throw fontNotFound();
		}
		// The stored content type proves nothing, so only the bytes count.
		const format = bytes ? decodeBrandFont(bytes) : null;
		if (!bytes || !format || format !== declared) {
			throw fontNotFound();
		}
		return { family, format, base64: bytes.toString("base64") };
	});
