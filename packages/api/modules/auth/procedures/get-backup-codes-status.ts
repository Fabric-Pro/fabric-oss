import { ORPCError } from "@orpc/server";
import { auth } from "@repo/auth";
import { logger } from "@repo/logs";
import { protectedProcedure } from "../../../orpc/procedures";

const TOTAL_BACKUP_CODES = 10;

// Better Auth's `viewBackupCodes` throws `APIError` with this exact message
// when the user has no `TwoFactor` row. Matching on the string lets us return
// `{ remaining: 0 }` for that legitimate case and surface real infra failures
// (DB down, decryption error) as errors instead. Brittle if Better Auth
// changes the wording — see better-auth/plugins/two-factor/error-code.mjs.
const BACKUP_CODES_NOT_ENABLED_MESSAGE = "Backup codes aren't enabled";

// We call `auth.api.viewBackupCodes` server-side rather than hitting the HTTP
// route at /two-factor/view-backup-codes — the route lacks session middleware
// as of Better Auth v1.4.9.
export interface GetBackupCodesStatusDeps {
	viewBackupCodes: (args: {
		body: { userId: string };
	}) => Promise<{ backupCodes: string[] }>;
}

// Duck-type detection: the `APIError` class lives in `better-call`, a transitive
// dep we don't want to import. Some call paths surface the message on `body`
// and others on the Error itself.
function isBackupCodesNotEnabledError(err: unknown): boolean {
	if (typeof err !== "object" || err === null) {
		return false;
	}
	const candidate = err as {
		body?: { message?: unknown };
		message?: unknown;
	};
	if (candidate.body?.message === BACKUP_CODES_NOT_ENABLED_MESSAGE) {
		return true;
	}
	return candidate.message === BACKUP_CODES_NOT_ENABLED_MESSAGE;
}

export async function getBackupCodesStatusHandler(
	userId: string,
	deps: GetBackupCodesStatusDeps,
): Promise<{ remaining: number; total: number }> {
	try {
		const result = await deps.viewBackupCodes({ body: { userId } });
		return {
			remaining: result.backupCodes?.length ?? 0,
			total: TOTAL_BACKUP_CODES,
		};
	} catch (err) {
		if (isBackupCodesNotEnabledError(err)) {
			return { remaining: 0, total: TOTAL_BACKUP_CODES };
		}
		logger.error(
			{ event: "backup_codes_status.read_failed", err },
			"Failed to read backup codes status",
		);
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			message: "Could not read backup codes status. Please try again.",
		});
	}
}

export const getBackupCodesStatus = protectedProcedure.handler(({ context }) =>
	getBackupCodesStatusHandler(context.user.id, {
		viewBackupCodes: auth.api.viewBackupCodes,
	}),
);
