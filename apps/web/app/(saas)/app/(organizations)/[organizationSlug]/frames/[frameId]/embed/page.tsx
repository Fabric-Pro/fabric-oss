import { auth } from "@repo/auth";
import { getFrameById } from "@repo/database";
import { getActiveOrganization } from "@saas/auth/lib/server";
import {
	type FrameDocumentView,
	FrameRenderer,
} from "@saas/frames/components/FrameRenderer";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

export default async function OrganizationFrameEmbedPage({
	params,
	searchParams,
}: {
	params: Promise<{ organizationSlug: string; frameId: string }>;
	searchParams: Promise<{ slide?: string }>;
}) {
	const { organizationSlug, frameId } = await params;
	const { slide } = await searchParams;
	const session = await auth.api.getSession({ headers: await headers() });
	if (!session) {
		notFound();
	}

	// Derive the org from the URL slug (per-tab), not the shared
	// session.activeOrganizationId, so a frame opened in one tab resolves against
	// its own org even when other tabs are open in different org contexts.
	const organization = await getActiveOrganization(organizationSlug);

	const frame = await getFrameById({
		id: frameId,
		userId: session.user.id,
		organizationId: organization?.id ?? undefined,
	});

	if (!frame) {
		notFound();
	}

	const slideIndex = Number.isFinite(Number(slide))
		? Math.max(0, Number(slide))
		: undefined;

	return (
		<FrameRenderer
			frame={frame.document as FrameDocumentView}
			embedded
			slideIndex={slideIndex}
		/>
	);
}
