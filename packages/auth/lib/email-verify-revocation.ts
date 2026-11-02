import { APIError } from "better-auth/api";
import { jwtVerify } from "jose";
import {
	getEmailChangeRevocationStatus,
	getEmailVerifyJWTBlockStatus,
} from "./email-verify-blocklist";

const REVOKED_MESSAGE = "This verification link has been revoked.";
const UNAVAILABLE_MESSAGE =
	"Email verification is temporarily unavailable. Please try again.";

function revokedError(): APIError {
	return new APIError("BAD_REQUEST", { message: REVOKED_MESSAGE });
}

function unavailableError(): APIError {
	return new APIError("SERVICE_UNAVAILABLE", {
		message: UNAVAILABLE_MESSAGE,
	});
}

export async function assertEmailVerifyNotRevoked(
	token: string,
	secret: string | undefined,
): Promise<void> {
	if (!secret) {
		// validateAuthBootEnv refuses a production runtime without either
		// BETTER_AUTH_SECRET or AUTH_SECRET. Better Auth's default-secret path is
		// therefore reachable here only in local development and tests.
		return;
	}

	let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
	try {
		({ payload } = await jwtVerify(
			token,
			new TextEncoder().encode(secret),
			{ algorithms: ["HS256"] },
		));
	} catch {
		// Better Auth owns the canonical response for invalid or expired JWTs.
		return;
	}

	const exactStatus = await getEmailVerifyJWTBlockStatus(token);
	if (exactStatus === "revoked") {
		throw revokedError();
	}

	const updateTo =
		typeof payload.updateTo === "string" ? payload.updateTo : undefined;
	if (!updateTo) {
		// Plain signup verification keeps its existing fail-open behavior.
		return;
	}

	if (exactStatus === "unavailable") {
		throw unavailableError();
	}

	const email = typeof payload.email === "string" ? payload.email : undefined;
	if (!email) {
		// Better Auth rejects the malformed payload after this hook.
		return;
	}

	const tupleStatus = await getEmailChangeRevocationStatus(email, updateTo);
	if (tupleStatus === "revoked") {
		throw revokedError();
	}
	if (tupleStatus === "unavailable") {
		throw unavailableError();
	}
}
