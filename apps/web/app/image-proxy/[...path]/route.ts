import { config } from "@repo/config";
import { getSignedUrl } from "@repo/storage";
import {
	NEWSLETTER_PUBLIC_IMAGE_PREFIX,
	newsletterPublicImageContentType,
} from "@repo/utils/newsletter-public-image";
import { NextResponse } from "next/server";

const ONE_HOUR_SECONDS = 60 * 60;

function redirectToSignedUrl(signedUrl: string) {
	return NextResponse.redirect(signedUrl, {
		headers: { "Cache-Control": "max-age=3600" },
	});
}

export const GET = async (
	_req: Request,
	{ params }: { params: Promise<{ path: string[] }> },
) => {
	const { path } = await params;

	const [bucket, filePath] = path;

	if (!(bucket && filePath)) {
		return new Response("Invalid path", { status: 400 });
	}

	if (bucket === config.storage.bucketNames.avatars) {
		return redirectToSignedUrl(
			await getSignedUrl(filePath, {
				bucket,
				expiresIn: ONE_HOUR_SECONDS,
			}),
		);
	}

	// Published release-notes images, linked from emails and public pages.
	// Exactly `<bucket>/newsletter-public/<file>` with a published file name;
	// nothing else in this bucket is reachable without authentication.
	if (
		bucket === config.storage.bucketNames.projectContexts &&
		path.length === 3 &&
		filePath === NEWSLETTER_PUBLIC_IMAGE_PREFIX
	) {
		const fileName = path[2];
		const contentType = newsletterPublicImageContentType(fileName);
		if (contentType) {
			const key = `${NEWSLETTER_PUBLIC_IMAGE_PREFIX}/${fileName}`;
			return redirectToSignedUrl(
				await getSignedUrl(key, {
					bucket,
					expiresIn: ONE_HOUR_SECONDS,
					responseContentType: contentType,
					responseContentDisposition: "inline",
				}),
			);
		}
	}

	return new Response("Not found", {
		status: 404,
	});
};
