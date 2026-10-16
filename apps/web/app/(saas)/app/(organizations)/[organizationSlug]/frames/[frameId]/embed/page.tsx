import { auth } from "@repo/auth";
import { getAccessibleFrameById, getFrameById } from "@repo/database";
import { getActiveOrganization } from "@saas/auth/lib/server";
import {
	type FrameDocumentView,
	FrameRenderer,
} from "@saas/frames/components/FrameRenderer";
import {
	isUnattendedFrame,
	usesStrictSandbox,
} from "@saas/frames/lib/strict-sandbox";
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

	// The frame's creator, the members of its project, and the organization's
	// members for a frame shared with the organization may open it; the lookup
	// never leaves the organization named by the URL.
	const frame = organization
		? await getAccessibleFrameById({
				id: frameId,
				userId: session.user.id,
				userEmail: session.user.email,
				organizationId: organization.id,
			})
		: await getFrameById({ id: frameId, userId: session.user.id });

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
			strictSandbox={usesStrictSandbox(frame, session.user.id)}
			allowScripts={!isUnattendedFrame(frame)}
		/>
	);
}
