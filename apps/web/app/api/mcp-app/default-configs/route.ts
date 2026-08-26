/**
 * Lists the tenant's managed-default MCP configs.
 *
 * The frontend hook `useDefaultMcpFrontendActions` calls this on
 * mount to learn which `configId` to pass to `/api/mcp-app/invoke`
 * for each known managed-default server (today: Excalidraw). We can't
 * hardcode the configId because it's tenant-scoped and varies per
 * user/org — the auth-hook seeds a fresh row for each tenant.
 *
 * Tenant XOR mirrors the chat-side `loadDefaultMcpActions` and the
 * agent's `state.copilotkit.actions` path: same filter (managed-default
 * + defaultEnabled + isSystemProvided), so the frontend hook surfaces
 * exactly the servers that would have been surfaced via the now-
 * defunct backend-actions route.
 */

import { auth } from "@repo/auth";
import { db } from "@repo/database";
import { headers } from "next/headers";
import type { NextRequest } from "next/server";

interface DefaultConfigEntry {
	configId: string;
	serverKey: string;
}

export async function GET(req: NextRequest) {
	const headersList = await headers();
	const session = await auth.api.getSession({ headers: headersList });
	if (!session?.user) {
		return new Response(JSON.stringify({ error: "Unauthorized" }), {
			status: 401,
			headers: { "Content-Type": "application/json" },
		});
	}

	const url = new URL(req.url);
	const organizationId = url.searchParams.get("organizationId");

	// Tenant XOR — never OR. Personal context requires organizationId: null.
	const configs = await db.mCPConfig.findMany({
		where: {
			userId: session.user.id,
			organizationId: organizationId ?? null,
			enabled: true,
			isManagedDefault: true,
			mcpServer: {
				defaultEnabled: true,
				isSystemProvided: true,
			},
		},
		select: {
			id: true,
			mcpServer: { select: { key: true } },
		},
	});

	const entries: DefaultConfigEntry[] = configs.map((c) => ({
		configId: c.id,
		serverKey: c.mcpServer.key,
	}));

	return new Response(JSON.stringify({ configs: entries }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}
