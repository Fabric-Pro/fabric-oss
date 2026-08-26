import { getFrameByShareToken } from "@repo/database";
import {
	type FrameDocumentView,
	FrameRenderer,
} from "@saas/frames/components/FrameRenderer";
import { notFound } from "next/navigation";

export default async function SharedFrameEmbedPage({
	params,
	searchParams,
}: {
	params: Promise<{ token: string }>;
	searchParams: Promise<{ slide?: string }>;
}) {
	const { token } = await params;
	const { slide } = await searchParams;
	const frame = await getFrameByShareToken(token);

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
