import { db, getFrameByShareToken } from "@repo/database";
import type { FrameDocumentView } from "@saas/frames/components/FrameRenderer";
import { FrameVizShell } from "@saas/frames/components/FrameVizShell";
import { notFound } from "next/navigation";

export default async function SharedFramePage({
	params,
}: {
	params: Promise<{ token: string }>;
}) {
	const { token } = await params;
	const frame = await getFrameByShareToken(token);

	if (!frame) {
		notFound();
	}

	let workspaceName = "Fabric";
	if (frame.organizationId) {
		const org = await db.organization.findUnique({
			where: { id: frame.organizationId },
			select: { name: true },
		});
		workspaceName = org?.name || workspaceName;
	} else {
		const user = await db.user.findUnique({
			where: { id: frame.userId },
			select: { name: true },
		});
		workspaceName = user?.name || workspaceName;
	}

	const appUrl =
		process.env.NEXT_PUBLIC_SITE_URL ||
		process.env.APP_URL ||
		"http://localhost:3001";
	const shareUrl = `${appUrl}/share/frame/${token}`;
	const embedUrl = `/share/frame/${token}/embed`;

	return (
		<div className="mx-auto max-w-7xl p-6">
			<FrameVizShell
				title={frame.title}
				description={frame.description ?? undefined}
				kind={frame.kind}
				contentType={frame.contentType}
				frameDocument={frame.document as FrameDocumentView}
				embedUrl={embedUrl}
				shareUrl={shareUrl}
				headerMode="public"
				workspaceName={workspaceName}
				isPublic
			/>
		</div>
	);
}
