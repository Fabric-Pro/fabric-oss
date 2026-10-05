/**
 * Which CLI this deployment serves.
 *
 * `/cli/fabric-<version>-<build>.tgz` is the CLI built from this deployment's
 * own source (see `packages/cli/scripts/pack-deployment.mjs`), so what a person
 * runs with `npx` is always written for the server they are talking to. The
 * document says where the tarball is, which version it is, its integrity, the
 * oldest CLI version this deployment still accepts, and the origin the tarball
 * was built for (the address it signs in at unless given `--base-url`), or null
 * when the build did not know it.
 *
 * Public and identical for every caller, hence the open CORS header, and a
 * short cache: a new deployment replaces the tarball under a new name, and a
 * pinned URL in somebody's shell history is answered by `app/cli/[file]` with a
 * redirect to the current one.
 */

import { discoveryDocumentFor } from "@saas/cli-distribution/lib/cli-discovery";
import { readPackedCliManifest } from "@saas/cli-distribution/lib/read-packed-cli-manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS_HEADERS = { "Access-Control-Allow-Origin": "*" } as const;

const HOST_LITERAL = /^[A-Za-z0-9.-]+(?::\d{1,5})?$/;

/**
 * The origin the client asked at. `request.url` names the address the server
 * is bound to (`0.0.0.0:3001` under the dev server, an internal host behind a
 * proxy), so the proxy's forwarded headers come first, then the `Host` the
 * client sent; a value that is not a plain host literal is ignored.
 */
function askedOrigin(request: Request): string {
	const url = new URL(request.url);
	const proto = request.headers
		.get("x-forwarded-proto")
		?.split(",")[0]
		?.trim();
	const host = (
		request.headers.get("x-forwarded-host") ?? request.headers.get("host")
	)
		?.split(",")[0]
		?.trim();
	const scheme =
		proto === "http" || proto === "https"
			? proto
			: url.protocol.replace(/:$/, "");
	return host && HOST_LITERAL.test(host) ? `${scheme}://${host}` : url.origin;
}

export async function GET(request: Request) {
	const manifest = await readPackedCliManifest();
	if (!manifest) {
		return Response.json(
			{
				error: "cli_not_served",
				message:
					"This deployment does not serve the Fabric CLI. The build that produced it did not run the pack step.",
			},
			{
				status: 404,
				headers: { ...CORS_HEADERS, "Cache-Control": "no-store" },
			},
		);
	}

	// The host that was asked, not a configured base URL: on Vercel the build
	// does not know the address it will be served at, and a preview or staging
	// deployment answers on its own.
	return Response.json(discoveryDocumentFor(manifest, askedOrigin(request)), {
		headers: { ...CORS_HEADERS, "Cache-Control": "public, max-age=60" },
	});
}

export function OPTIONS() {
	return new Response(null, {
		status: 204,
		headers: {
			...CORS_HEADERS,
			"Access-Control-Allow-Methods": "GET, OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type",
		},
	});
}
