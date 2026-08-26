import { auth } from "@repo/auth";
import { getFrameById } from "@repo/database";
import {
	type FrameDocumentView,
	FrameRenderer,
} from "@saas/frames/components/FrameRenderer";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

export default async function FrameEmbedPage({
	params,
	searchParams,
}: {
	params: Promise<{ frameId: string }>;
	searchParams: Promise<{ slide?: string }>;
}) {
	const { frameId } = await params;
	const { slide } = await searchParams;
	const session = await auth.api.getSession({ headers: await headers() });
	if (!session) {
		notFound();
	}

	const frame = await getFrameById({
		id: frameId,
		userId: session.user.id,
		organizationId: session.session.activeOrganizationId ?? undefined,
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
