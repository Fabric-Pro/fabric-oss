import { auth } from "@repo/auth";
import { getTemplateInstanceArtifact } from "@repo/database";
import { type NextRequest, NextResponse } from "next/server";

export async function GET(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		const session = await auth.api.getSession({ headers: request.headers });
		if (!session?.user) {
			return NextResponse.json(
				{ error: "Unauthorized" },
				{ status: 401 },
			);
		}

		const { id } = await params;
		const artifact = await getTemplateInstanceArtifact(id);

		if (!artifact) {
			return NextResponse.json(
				{ error: "Artifact not found" },
				{ status: 404 },
			);
		}

		// Verify ownership
		if (artifact.userId !== session.user.id) {
			return NextResponse.json(
				{ error: "Access denied" },
				{ status: 403 },
			);
		}

		// Return content if stored in database
		if (artifact.content) {
			const headers = new Headers();
			headers.set("Content-Type", artifact.mimeType);
			headers.set(
				"Content-Disposition",
				`attachment; filename="${artifact.name}"`,
			);

			return new NextResponse(artifact.content, { headers });
		}

		// If stored in S3, redirect to signed URL (TODO: implement S3 signed URL)
		if (artifact.s3Path && artifact.s3Bucket) {
			return NextResponse.json(
				{ error: "S3 download not yet implemented" },
				{ status: 501 },
			);
		}

		return NextResponse.json(
			{ error: "No content available for this artifact" },
			{ status: 404 },
		);
	} catch (error) {
		console.error("Artifact download error:", error);
		return NextResponse.json(
			{ error: "Failed to download artifact" },
			{ status: 500 },
		);
	}
}
