import { FrameViewer } from "@saas/frames/components/FrameViewer";

export default async function GenericFramePage({
	params,
}: {
	params: Promise<{ frameId: string }>;
}) {
	const { frameId } = await params;
	return <FrameViewer frameId={frameId} />;
}
