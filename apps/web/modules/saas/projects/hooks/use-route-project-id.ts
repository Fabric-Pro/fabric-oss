"use client";

import { useParams, usePathname } from "next/navigation";

/**
 * The project id from the current route, or undefined outside a
 * `/projects/[id]` route.
 *
 * The MCP-App proxy routes (`/api/mcp-app/invoke`, `/api/mcp-app/call-tool`)
 * are plain Next.js handlers with no ambient project context, so the only way
 * the Read-only mode write-gate can know which project a diagram/tool write
 * belongs to is for the caller to pass this id in the request body. Reading it
 * from the route is robust: it is present exactly when the component is mounted
 * inside a project workspace, and `undefined` elsewhere (where there is no
 * project to gate). A wrong id in a non-project route is harmless — the gate's
 * lookup fails open.
 */
export function useRouteProjectId(): string | undefined {
	const params = useParams<{ id?: string }>();
	const pathname = usePathname();
	if (pathname?.includes("/projects/") && typeof params?.id === "string") {
		return params.id;
	}
	return undefined;
}
