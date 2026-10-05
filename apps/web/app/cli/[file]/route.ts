/**
 * A tarball name this deployment no longer serves.
 *
 * `/cli/fabric-<version>-<build>.tgz` names a build, so a new deployment serves
 * a new name and the old one is gone. Without an answer, `npx -y <old url>`
 * prints npm's "is not in this registry" error, which says nothing about what
 * happened. A name of that shape is sent to the current tarball instead
 * (`FABRIC_CLI_TARBALL`, from the pack step's manifest); anything else under
 * `/cli` is a plain 404.
 *
 * Only reached for a path `public/cli` does not hold: the current tarball and
 * `manifest.json` are static files, served before this route is asked.
 */

import { CLI_TARBALL_PATH } from "@saas/cli-distribution/lib/cli-discovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
	params: Promise<{ file: string }>;
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(_request: Request, { params }: RouteParams) {
	const { file } = await params;
	const current = process.env.FABRIC_CLI_TARBALL;
	if (!current || !CLI_TARBALL_PATH.test(current)) {
		return Response.json(
			{
				error: "cli_not_served",
				message:
					"This deployment does not serve the Fabric CLI. The build that produced it did not run the pack step.",
			},
			{ status: 404, headers: NO_STORE },
		);
	}
	if (!CLI_TARBALL_PATH.test(`/cli/${file}`)) {
		return Response.json(
			{
				error: "not_found",
				message: "There is no such file under /cli.",
			},
			{ status: 404, headers: NO_STORE },
		);
	}
	return new Response(null, {
		status: 307,
		headers: { ...NO_STORE, Location: current },
	});
}
