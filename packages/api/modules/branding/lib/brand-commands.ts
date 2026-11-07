import { ORPCError } from "@orpc/server";
import {
	db,
	getBrandKit,
	getRecipientBrand,
	trustedOrganizationLogoKey,
} from "@repo/database";
import type { z } from "zod";
import type { RecordAuditFromRequestInput } from "../../../lib/audit";
import {
	assertProjectPermission,
	authorizeInputOrganization,
	Permissions,
} from "../../../orpc/procedures";
import { updateCompanyBrandCommand } from "../../organizations/procedures/brand-kit/update-brand-kit";
import { assertGlossyOrProposalArtifactEnabledForOrganization } from "../../projects/lib/proposal-artifact-feature";
import { loadRecipientBrandProject } from "../../projects/lib/recipient-brand";
import { updateClientBrandCommand } from "../../projects/procedures/recipient-brand/update-recipient-brand";

import type {
	artifactBrandReadSchema,
	BrandActor,
	clientBrandSaveSchema,
	companyBrandSaveSchema,
} from "./brand-contracts";

export {
	artifactBrandReadSchema,
	type BrandActor,
	clientBrandSaveSchema,
	companyBrandSaveSchema,
} from "./brand-contracts";

/** Read reviewed brand records only; fetched suggestions and storage URLs are never instructions or output. */
export async function getArtifactBrandCommand(
	actor: BrandActor,
	input: z.infer<typeof artifactBrandReadSchema>,
) {
	if (input.projectId) {
		const authorized = await assertProjectPermission(
			input.projectId,
			actor.userId,
			Permissions.DOCUMENT_READ,
		);
		if (authorized.organizationId !== actor.organizationId) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}
		await loadRecipientBrandProject({
			projectId: input.projectId,
			userId: actor.userId,
			write: false,
		});
	} else {
		await authorizeInputOrganization(
			Permissions.ORG_READ,
			actor.organizationId,
			{ user: { id: actor.userId }, session: {} },
			{ requireOrganization: true },
		);
		await assertGlossyOrProposalArtifactEnabledForOrganization(
			actor.organizationId,
		);
	}
	const [organization, kit, row] = await Promise.all([
		db.organization.findUnique({
			where: { id: actor.organizationId },
			select: { name: true, logo: true, deletedAt: true },
		}),
		getBrandKit(actor.organizationId),
		input.projectId ? getRecipientBrand(input.projectId) : null,
	]);
	if (!organization || organization.deletedAt) {
		throw new ORPCError("NOT_FOUND", { message: "Organization not found" });
	}
	const client = row?.organizationId === actor.organizationId ? row : null;
	return {
		company: {
			name: organization.name,
			primaryColor: kit?.primaryColor ?? null,
			accentColors: kit?.accentColors ?? [],
			guidance: kit?.guidance ?? null,
			website: kit?.website ?? null,
			displayFontFamily: kit?.displayFontFamily ?? null,
			bodyFontFamily: kit?.bodyFontFamily ?? null,
			hasLogo: Boolean(
				trustedOrganizationLogoKey(
					organization.logo,
					actor.organizationId,
				),
			),
			version: kit?.version ?? 0,
		},
		client: client
			? {
					name: client.name,
					website: client.website,
					colors: client.colors,
					displayFontFamily: client.displayFontFamily ?? null,
					bodyFontFamily: client.bodyFontFamily ?? null,
					coverStyle: client.coverStyle ?? "DARK",
					hasLogo: Boolean(client.logoKey),
					version: client.version,
				}
			: null,
		clientVersion: client?.version ?? 0,
		missingClientFields: [
			...(!client?.name ? ["name"] : []),
			...(!client?.colors.length ? ["colors"] : []),
			...(!client?.logoKey ? ["logo"] : []),
		],
		guidance:
			"The company is the author (prepared by); the project client is the recipient (prepared for). Ask which visual brand to use. Collect missing brand information without inventing logos or colors. Review changes before saving. Use the saved project recipient brand and document Style for styled proposal exports. Logo/font uploads and website suggestions are reviewed in the Brand kit or project client-brand form.",
	};
}

/** Text edits share the Portal's CAS, live authorization, audit and asset-preservation pipeline. */
export async function saveCompanyBrandCommand(
	actor: BrandActor,
	input: z.infer<typeof companyBrandSaveSchema>,
	audit: (event: RecordAuditFromRequestInput) => unknown,
) {
	await authorizeInputOrganization(
		Permissions.ORG_UPDATE,
		actor.organizationId,
		{ user: { id: actor.userId }, session: {} },
		{ requireOrganization: true },
	);
	const current = await getBrandKit(actor.organizationId);
	const result = await updateCompanyBrandCommand(
		actor,
		{
			organizationId: actor.organizationId,
			expectedVersion: input.expectedVersion,
			accentColors: input.accentColors ?? current?.accentColors ?? [],
			guidance:
				input.guidance === undefined
					? (current?.guidance ?? null)
					: input.guidance,
			primaryColor: input.primaryColor,
			website: input.website,
		},
		audit,
	);
	if (result.outcome !== "applied") {
		throw new ORPCError("BAD_REQUEST", {
			message: "Brand could not be saved",
		});
	}
	return { outcome: "applied" as const, version: result.brandKit.version };
}
export async function saveClientBrandCommand(
	actor: BrandActor,
	input: z.infer<typeof clientBrandSaveSchema>,
	audit: (event: RecordAuditFromRequestInput) => unknown,
) {
	const authorized = await assertProjectPermission(
		input.projectId,
		actor.userId,
		Permissions.DOCUMENT_UPDATE,
	);
	if (authorized.organizationId !== actor.organizationId) {
		throw new ORPCError("NOT_FOUND", { message: "Project not found" });
	}
	return updateClientBrandCommand(
		actor,
		{ ...input, logo: { action: "keep" } },
		audit,
	);
}
