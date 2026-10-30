import { aiConfigurationRefusalMessage } from "../../lib/ai-configuration-refusal";
import { isDatabaseError, prismaErrorCode } from "../../lib/database-error";

export { isDatabaseError, prismaErrorCode } from "../../lib/database-error";

/** An error's message, without throwing on an odd value. */
export function describeOrphanCause(error: unknown): string {
	try {
		return error instanceof Error ? error.message : String(error);
	} catch {
		return "unknown error";
	}
}

export function describeSyncErrorForUser(error: unknown): string {
	if (isDatabaseError(error)) {
		const code = prismaErrorCode(error);
		return code ? `database error ${code}` : "database error";
	}
	return aiConfigurationRefusalMessage(error) ?? describeOrphanCause(error);
}

export function redactDatabaseErrorText(
	message: string,
	errorClass?: string,
): string {
	if (
		isDatabaseError({ name: errorClass }) ||
		/(?:Invalid |in the )`[^`\r\n]{1,256}\.[^`\r\n]{1,256}\([^`\r\n]{0,256}\)` invocation\b/.test(
			message,
		)
	) {
		return "database error";
	}
	return message;
}
