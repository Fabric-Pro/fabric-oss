/**
 * Google Docs Picker session
 *
 * Returns the credentials a browser needs to open the Google Picker for
 * selecting Google Docs:
 *   - the caller's own OAuth access token (drive.file scope),
 *   - the public developer API key (Cloud Console "API key"),
 *   - the Cloud project number (Picker `appId`),
 *   - an expiry instant so the client can re-fetch before the token dies.
 *
 * The Picker is browser-only by design, so the user's access token has to
 * cross the wire. This is acceptable because:
 *   1. Tenant XOR is enforced before issuing (the helper looks up the calling
 *      user's row only — never another member's).
 *   2. The granted scope is `drive.file`, which limits the token to files the
 *      user explicitly opens with our app via the Picker (plus what our app
 *      itself creates). The blast radius is intentionally narrow.
 *   3. The token expires; the procedure surfaces `expiresAt` so the client can
 *      refresh on demand instead of holding a long-lived secret.
 *
 * If the user is connected under the legacy `drive.readonly` scope (pre-swap),
 * we return `requiresReconnect: true` so the dialog can prompt re-consent
 * rather than failing in the Picker with an opaque auth error.
 */

import { db, hasProjectAccess } from "@repo/database";
import { logger } from "@repo/logs";
import { decryptApiKey } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	GoogleDriveNotConnectedError,
	GoogleDriveTokenExpiredError,
	getGoogleDriveAccessToken,
} from "../../../integrations/lib/google-drive-token";

const REQUIRED_SCOPE = "https://www.googleapis.com/auth/drive.file";

export const googleDocsPickerSessionProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.CONTEXT_CREATE))
	.route({
		method: "GET",
		path: "/projects/:projectId/contexts/google-docs/picker-session",
		tags: ["Projects", "Contexts", "Integrations"],
		summary: "Get Google Picker session credentials",
		description:
			"Returns the access token + developer key + app ID needed to open the Google Picker for selecting Google Docs.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			isConnected: z.boolean(),
			requiresReconnect: z.boolean(),
			accessToken: z.string().nullable(),
			developerKey: z.string().nullable(),
			appId: z.string().nullable(),
			expiresAt: z.number().nullable(),
			error: z.string().nullable(),
		}),
	)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const hasAccess = await hasProjectAccess(
			input.projectId,
			userId,
			organizationId,
		);
		if (!hasAccess) {
			return {
				isConnected: false,
				requiresReconnect: false,
				accessToken: null,
				developerKey: null,
				appId: null,
				expiresAt: null,
				error: "You don't have access to this project.",
			};
		}

		const developerKey = process.env.GOOGLE_PICKER_DEVELOPER_KEY ?? null;
		const appId = process.env.GOOGLE_PICKER_APP_ID ?? null;
		if (!developerKey || !appId) {
			return {
				isConnected: false,
				requiresReconnect: false,
				accessToken: null,
				developerKey: null,
				appId: null,
				expiresAt: null,
				error: "Google Picker is not configured on this server. Set GOOGLE_PICKER_DEVELOPER_KEY and GOOGLE_PICKER_APP_ID.",
			};
		}

		// Read the row first so we can both surface the granted scope set and
		// reuse the same `expires_at` we hand to the client. The token helper
		// re-runs the same lookup, which is fine — both calls are user-scoped.
		const row = await db.workflowIntegration.findFirst({
			where: {
				userId,
				provider: "GOOGLE_DRIVE",
				isActive: true,
				organizationId: organizationId ?? null,
			},
		});
		if (!row?.credentials) {
			return {
				isConnected: false,
				requiresReconnect: false,
				accessToken: null,
				developerKey: null,
				appId: null,
				expiresAt: null,
				error: "Google account not connected. Connect it in Settings → Integrations.",
			};
		}

		let grantedScope: string | undefined;
		try {
			const parsed = JSON.parse(decryptApiKey(row.credentials)) as {
				scope?: string;
			};
			grantedScope = parsed.scope;
		} catch (error) {
			// Treat undecryptable credentials as "not connected" — same UX as
			// `getGoogleDriveAccessToken` does. Log so a real crypto regression
			// doesn't manifest as every user silently appearing disconnected.
			logger.error(
				`[GoogleDocsPickerSession] Failed to decrypt credentials for integration ${row.id} (user=${userId}, org=${organizationId ?? "personal"}): ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return {
				isConnected: false,
				requiresReconnect: false,
				accessToken: null,
				developerKey: null,
				appId: null,
				expiresAt: null,
				error: "Google account not connected. Connect it in Settings → Integrations.",
			};
		}

		const scopes = (grantedScope ?? "").split(/\s+/).filter(Boolean);
		if (!scopes.includes(REQUIRED_SCOPE)) {
			return {
				isConnected: true,
				requiresReconnect: true,
				accessToken: null,
				developerKey: null,
				appId: null,
				expiresAt: null,
				error: "Reconnect your Google account to grant the new picker permission.",
			};
		}

		let accessToken: string;
		try {
			accessToken = await getGoogleDriveAccessToken({
				userId,
				organizationId,
			});
		} catch (error) {
			if (error instanceof GoogleDriveNotConnectedError) {
				return {
					isConnected: false,
					requiresReconnect: false,
					accessToken: null,
					developerKey: null,
					appId: null,
					expiresAt: null,
					error: "Google account not connected. Connect it in Settings → Integrations.",
				};
			}
			if (error instanceof GoogleDriveTokenExpiredError) {
				return {
					isConnected: false,
					requiresReconnect: true,
					accessToken: null,
					developerKey: null,
					appId: null,
					expiresAt: null,
					error: "Google session expired. Reconnect your account in Settings → Integrations.",
				};
			}
			// Unexpected error path — log before re-throwing so the resulting
			// ORPC error has a traceable origin (network/DNS failure on the
			// token endpoint, Prisma transient, etc.).
			logger.error(
				`[GoogleDocsPickerSession] Unexpected token error for integration ${row.id} (user=${userId}, org=${organizationId ?? "personal"}): ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			throw error;
		}

		// `getGoogleDriveAccessToken` may have refreshed the row; re-read the
		// settings mirror to get the new ISO `tokenExpiresAt` for the client.
		const fresh = await db.workflowIntegration.findUnique({
			where: { id: row.id },
			select: { settings: true },
		});
		const expiresAtIso =
			(fresh?.settings as { tokenExpiresAt?: string | null } | null)
				?.tokenExpiresAt ?? null;
		const expiresAt = expiresAtIso ? Date.parse(expiresAtIso) : null;

		return {
			isConnected: true,
			requiresReconnect: false,
			accessToken,
			developerKey,
			appId,
			expiresAt: Number.isFinite(expiresAt ?? Number.NaN)
				? expiresAt
				: null,
			error: null,
		};
	});
