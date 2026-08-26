/**
 * Database queries for organization brand color
 * The brand color is stored in the organization's metadata JSON field
 */

import { db } from "../client";

interface OrganizationMetadata {
	brandColor?: string;
	[key: string]: unknown;
}

/**
 * Parse organization metadata safely
 */
function parseMetadata(metadata: string | null): OrganizationMetadata {
	if (!metadata) {
		return {};
	}
	try {
		return JSON.parse(metadata) as OrganizationMetadata;
	} catch {
		return {};
	}
}

/**
 * Get organization's brand color from metadata
 */
export async function getOrganizationBrandColor(
	organizationId: string,
): Promise<string | null> {
	const org = await db.organization.findUnique({
		where: { id: organizationId },
		select: {
			id: true,
			metadata: true,
		},
	});

	if (!org) {
		return null;
	}

	const metadata = parseMetadata(org.metadata);
	return metadata.brandColor || null;
}

/**
 * Update organization's brand color in metadata
 */
export async function updateOrganizationBrandColor({
	organizationId,
	brandColor,
}: {
	organizationId: string;
	brandColor: string | null;
}): Promise<{ id: string; brandColor: string | null }> {
	// First get existing metadata
	const org = await db.organization.findUnique({
		where: { id: organizationId },
		select: { metadata: true },
	});

	const existingMetadata = parseMetadata(org?.metadata || null);

	// Update or remove the brandColor
	const newMetadata: OrganizationMetadata = {
		...existingMetadata,
	};

	if (brandColor) {
		newMetadata.brandColor = brandColor;
	} else {
		delete newMetadata.brandColor;
	}

	// Update the organization
	const updated = await db.organization.update({
		where: { id: organizationId },
		data: {
			metadata: JSON.stringify(newMetadata),
		},
		select: {
			id: true,
			metadata: true,
		},
	});

	const updatedMetadata = parseMetadata(updated.metadata);
	return {
		id: updated.id,
		brandColor: updatedMetadata.brandColor || null,
	};
}
