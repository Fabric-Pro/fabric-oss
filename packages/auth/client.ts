import { passkeyClient } from "@better-auth/passkey/client";
import {
	adminClient,
	inferAdditionalFields,
	magicLinkClient,
	organizationClient,
	twoFactorClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

// better-auth 1.6.x can't infer additionalFields through `<typeof auth>`
// because the auth instance's Options["plugins"] is widened to
// `BetterAuthPlugin[]`, collapsing the schema inference. Pass the fields
// explicitly so `authClient.updateUser({ onboardingComplete, locale, ... })`
// type-checks again. Keep this in sync with `user.additionalFields` in
// packages/auth/auth.ts.
export const authClient = createAuthClient({
	plugins: [
		inferAdditionalFields({
			user: {
				onboardingComplete: { type: "boolean", required: false },
				locale: { type: "string", required: false },
				mustChangePassword: { type: "boolean", required: false },
			},
		}),
		magicLinkClient(),
		organizationClient(),
		adminClient(),
		passkeyClient(),
		twoFactorClient(),
	],
});

export type AuthClientErrorCodes = typeof authClient.$ERROR_CODES & {
	INVALID_INVITATION: string;
	ACCOUNT_LOCKED: string;
	LOGIN_BACKOFF: string;
	RATE_LIMITED: string;
	CAPTCHA_FAILED: string;
	// Two-factor codes
	INVALID_CODE: string;
	OTP_NOT_ENABLED: string;
	OTP_HAS_EXPIRED: string;
	TOTP_NOT_ENABLED: string;
	TWO_FACTOR_NOT_ENABLED: string;
	BACKUP_CODES_NOT_ENABLED: string;
	INVALID_BACKUP_CODE: string;
	TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: string;
	INVALID_TWO_FACTOR_COOKIE: string;
	// Raised by this repo's own step-up gate on the 2FA management endpoints
	// (packages/auth/lib/two-factor-management-step-up.ts), not by better-auth.
	STEP_UP_REQUIRED: string;
	// Passkey codes
	CHALLENGE_NOT_FOUND: string;
	FAILED_TO_VERIFY_REGISTRATION: string;
	PASSKEY_NOT_FOUND: string;
	AUTHENTICATION_FAILED: string;
	UNABLE_TO_CREATE_SESSION: string;
	FAILED_TO_UPDATE_PASSKEY: string;
	YOU_ARE_NOT_ALLOWED_TO_REGISTER_THIS_PASSKEY: string;
	// Base code
	USER_ALREADY_HAS_PASSWORD: string;
};
