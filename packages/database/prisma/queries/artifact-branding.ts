import {
	type ArtifactBrandSelection,
	artifactBrandSnapshotSchema,
} from "@repo/utils/artifact-brand-snapshot";
import {
	isArtifactCoverStyle,
	isArtifactFontFamily,
} from "@repo/utils/artifact-brand-theme";
import { db, type Prisma } from "../client";
import { hasProjectAccess } from "./projects/projects";
import { isOrganizationMember } from "./verify-organization-membership";

export class ArtifactBrandingError extends Error {
	constructor(
		readonly code:
			| "NOT_FOUND"
			| "REVIEW_REQUIRED"
			| "CLIENT_BRAND_MISSING"
			| "PUBLIC_FRAME",
	) {
		super(
			code === "REVIEW_REQUIRED"
				? "Branding changed. Review the saved brand and apply it again."
				: code === "CLIENT_BRAND_MISSING"
					? "Choose a project with saved client colors before using client branding."
					: code === "PUBLIC_FRAME"
						? "Make this Frame private before changing its branding."
						: "Branding is unavailable.",
		);
	}
}

export interface ArtifactBrandingContext {
	organizationId: string;
	userId: string;
	projectId?: string | null;
}

/** Scalar previews are deliberately separate from private brand asset records. */
export async function getArtifactBrandingChoices(
	input: ArtifactBrandingContext,
	client: Prisma.TransactionClient = db,
) {
	const project = input.projectId
		? await client.project.findFirst({
				where: {
					id: input.projectId,
					organizationId: input.organizationId,
					deletedAt: null,
				},
				select: { id: true },
			})
		: null;
	if (
		input.projectId
			? !project ||
				!(await hasProjectAccess(
					input.projectId,
					input.userId,
					input.organizationId,
					client,
				))
			: !(await isOrganizationMember(input.userId, input.organizationId))
	) {
		throw new ArtifactBrandingError("NOT_FOUND");
	}
	const [company, kit, recipient] = await Promise.all([
		client.organization.findUnique({
			where: { id: input.organizationId },
			select: { name: true },
		}),
		client.organizationBrandKit.findUnique({
			where: { organizationId: input.organizationId },
			select: {
				version: true,
				primaryColor: true,
				accentColors: true,
				displayFontFamily: true,
				bodyFontFamily: true,
			},
		}),
		input.projectId
			? client.projectRecipientBrand.findFirst({
					where: {
						projectId: input.projectId,
						organizationId: input.organizationId,
					},
					select: {
						version: true,
						name: true,
						colors: true,
						displayFontFamily: true,
						bodyFontFamily: true,
						coverStyle: true,
					},
				})
			: null,
	]);
	if (!company) {
		throw new ArtifactBrandingError("NOT_FOUND");
	}
	const safeColors = (colors: string[]) =>
		colors.filter((color) => /^#[0-9a-f]{6}$/i.test(color)).slice(0, 3);
	const companyAccents = safeColors(kit?.accentColors ?? []);
	const clientColors = safeColors(recipient?.colors ?? []);
	const primary =
		kit?.primaryColor && /^#[0-9a-f]{6}$/i.test(kit.primaryColor)
			? kit.primaryColor
			: companyAccents[0];
	return {
		company: {
			version: kit?.version ?? 0,
			name: company.name.slice(0, 200),
			hasPalette: !!primary,
			primaryColor: primary ?? "#334155",
			accentColors: companyAccents,
			displayFontFamily: isArtifactFontFamily(kit?.displayFontFamily)
				? kit.displayFontFamily
				: ("Poppins" as const),
			bodyFontFamily: isArtifactFontFamily(kit?.bodyFontFamily)
				? kit.bodyFontFamily
				: ("Inter" as const),
			coverStyle: "DARK" as const,
		},
		client: input.projectId
			? {
					version: recipient?.version ?? 0,
					name: recipient?.name?.slice(0, 200) ?? null,
					hasPalette: clientColors.length > 0,
					primaryColor: clientColors[0] ?? "#334155",
					accentColors: clientColors.slice(1),
					displayFontFamily: isArtifactFontFamily(
						recipient?.displayFontFamily,
					)
						? recipient.displayFontFamily
						: ("Poppins" as const),
					bodyFontFamily: isArtifactFontFamily(
						recipient?.bodyFontFamily,
					)
						? recipient.bodyFontFamily
						: ("Inter" as const),
					coverStyle: isArtifactCoverStyle(recipient?.coverStyle)
						? recipient.coverStyle
						: ("DARK" as const),
				}
			: null,
	};
}

export async function resolveArtifactBrandSnapshot(
	input: ArtifactBrandingContext & ArtifactBrandSelection,
	client: Prisma.TransactionClient = db,
) {
	if (client !== db) {
		await lockArtifactBrandSelection(input, client);
	}
	const choices = await getArtifactBrandingChoices(input, client);
	const chosen = input.source === "CLIENT" ? choices.client : choices.company;
	if (!chosen || (input.source === "CLIENT" && !chosen.hasPalette)) {
		throw new ArtifactBrandingError("CLIENT_BRAND_MISSING");
	}
	if (chosen.version !== input.expectedBrandVersion) {
		throw new ArtifactBrandingError("REVIEW_REQUIRED");
	}
	return artifactBrandSnapshotSchema.parse({
		version: 1,
		source: input.source,
		companyName: choices.company.name,
		clientName: choices.client?.name ?? null,
		primaryColor: chosen.primaryColor,
		accentColors: chosen.accentColors,
		displayFontFamily: chosen.displayFontFamily,
		bodyFontFamily: chosen.bodyFontFamily,
		coverStyle: chosen.coverStyle,
		companyBrandVersion: choices.company.version,
		clientBrandVersion: choices.client?.version ?? 0,
	});
}

/** Keep the selected saved row unchanged until the formatting mutation/admission commits. */
export async function lockArtifactBrandSelection(
	input: ArtifactBrandingContext & ArtifactBrandSelection,
	client: Prisma.TransactionClient,
) {
	if (input.source === "CLIENT") {
		if (!input.projectId) {
			throw new ArtifactBrandingError("CLIENT_BRAND_MISSING");
		}
		const rows = await client.$queryRaw<
			Array<{ version: number }>
		>`SELECT version FROM project_recipient_brand WHERE "projectId" = ${input.projectId} AND "organizationId" = ${input.organizationId} FOR SHARE`;
		if (!rows.length) {
			throw new ArtifactBrandingError("CLIENT_BRAND_MISSING");
		}
		if (rows[0]?.version !== input.expectedBrandVersion) {
			throw new ArtifactBrandingError("REVIEW_REQUIRED");
		}
	} else {
		let rows = await client.$queryRaw<
			Array<{ version: number }>
		>`SELECT version FROM organization_brand_kit WHERE "organizationId" = ${input.organizationId} FOR SHARE`;
		if (!rows.length) {
			// No child row exists to lock. The parent FOR UPDATE conflicts with
			// the FK KEY SHARE lock taken by a concurrent first brand-kit insert.
			await client.$queryRaw`SELECT id FROM organization WHERE id = ${input.organizationId} FOR UPDATE`;
			rows = await client.$queryRaw<
				Array<{ version: number }>
			>`SELECT version FROM organization_brand_kit WHERE "organizationId" = ${input.organizationId} FOR SHARE`;
		}
		if ((rows[0]?.version ?? 0) !== input.expectedBrandVersion) {
			throw new ArtifactBrandingError("REVIEW_REQUIRED");
		}
	}
}
