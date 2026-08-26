import { db, getFrameByShareToken } from "@repo/database";
import { NextResponse } from "next/server";

export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ token: string }> },
) {
	const { token } = await params;
	const frame = await getFrameByShareToken(token);

	if (!frame) {
		return NextResponse.json({ error: "Frame not found" }, { status: 404 });
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
	const sharePath = `/share/frame/${token}`;
	const shareEmbedPath = `${sharePath}/embed`;

	// Public endpoint — do not return tenant identifiers (`organizationId`,
	// `userId`, or a composite `workspaceId`). Knowing a share token should
	// not let a caller fingerprint the owning tenant.
	return NextResponse.json({
		shareUrl: `${appUrl}${sharePath}`,
		embedUrl: `${appUrl}${shareEmbedPath}`,
		vizUrl: `${appUrl}${shareEmbedPath}`,
		title: frame.title,
		workspaceName,
		frameId: frame.id,
		contentType: frame.contentType,
		kind: frame.kind,
	});
}
