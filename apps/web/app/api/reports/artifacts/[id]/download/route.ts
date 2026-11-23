import { auth } from "@repo/auth";
import { getTemplateInstanceArtifactForMember } from "@repo/database";
import { downloadFile } from "@repo/storage";
import { type NextRequest, NextResponse } from "next/server";

/**
 * A report run's artifact, for the report's page to view or download. It is
 * read in the report's own organization, not the session's active one, so a
 * page left open keeps working after another tab switches workspace; the
 * caller must still be a member there who may read the report.
 */
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
		const userId = session.user.id;
		const artifact = await getTemplateInstanceArtifactForMember(id, userId);

		if (!artifact) {
			return NextResponse.json(
				{ error: "Artifact not found" },
				{ status: 404 },
			);
		}

		const headers = new Headers();
		headers.set("Content-Type", artifact.mimeType);
		headers.set(
			"Content-Disposition",
			`attachment; filename*=UTF-8''${encodeURIComponent(artifact.name).replace(/'/g, "%27")}`,
		);
		headers.set("Cache-Control", "private, no-store");
		if (
			artifact.content !== null &&
			artifact.content !== undefined &&
			!artifact.s3Path
		) {
			return new NextResponse(artifact.content, { headers });
		}
		if (artifact.s3Path && artifact.s3Bucket) {
			const { data } = await downloadFile(artifact.s3Path, {
				bucket: artifact.s3Bucket,
			});
			if (!(await getTemplateInstanceArtifactForMember(id, userId))) {
				return NextResponse.json(
					{ error: "Artifact not found" },
					{ status: 404 },
				);
			}
			return new NextResponse(new Uint8Array(data), { headers });
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
