import type { AuthClientErrorCodes } from "@repo/auth/client";
import { useTranslations } from "next-intl";

export function useAuthErrorMessages() {
	const t = useTranslations();

	const authErrorMessages: Partial<
		Record<keyof AuthClientErrorCodes, string>
	> = {
		INVALID_EMAIL_OR_PASSWORD: t("auth.errors.invalidEmailOrPassword"),
		USER_NOT_FOUND: t("auth.errors.invalidEmailOrPassword"),
		FAILED_TO_CREATE_USER: t("auth.errors.failedToCreateUser"),
		FAILED_TO_CREATE_SESSION: t("auth.errors.failedToCreateSession"),
		FAILED_TO_UPDATE_USER: t("auth.errors.failedToUpdateUser"),
		FAILED_TO_GET_SESSION: t("auth.errors.failedToGetSession"),
		INVALID_PASSWORD: t("auth.errors.invalidEmailOrPassword"),
		INVALID_EMAIL: t("auth.errors.invalidEmail"),
		INVALID_TOKEN: t("auth.errors.invalidToken"),
		CREDENTIAL_ACCOUNT_NOT_FOUND: t("auth.errors.invalidEmailOrPassword"),
		EMAIL_CAN_NOT_BE_UPDATED: t("auth.errors.emailCanNotBeUpdated"),
		EMAIL_NOT_VERIFIED: t("auth.errors.emailNotVerified"),
		FAILED_TO_GET_USER_INFO: t("auth.errors.failedToGetUserInfo"),
		ID_TOKEN_NOT_SUPPORTED: t("auth.errors.idTokenNotSupported"),
		PASSWORD_TOO_LONG: t("auth.errors.passwordTooLong"),
		PASSWORD_TOO_SHORT: t("auth.errors.passwordTooShort"),
		PROVIDER_NOT_FOUND: t("auth.errors.providerNotFound"),
		SOCIAL_ACCOUNT_ALREADY_LINKED: t(
			"auth.errors.socialAccountAlreadyLinked",
		),
		USER_EMAIL_NOT_FOUND: t("auth.errors.invalidEmailOrPassword"),
		USER_ALREADY_EXISTS: t("auth.errors.userAlreadyExists"),
		USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: t(
			"auth.errors.userAlreadyExists",
		),
		INVALID_INVITATION: t("auth.errors.invalidInvitation"),
		SESSION_EXPIRED: t("auth.errors.sessionExpired"),
		FAILED_TO_UNLINK_LAST_ACCOUNT: t(
			"auth.errors.failedToUnlinkLastAccount",
		),
		ACCOUNT_NOT_FOUND: t("auth.errors.invalidEmailOrPassword"),
		ACCOUNT_LOCKED: t("auth.errors.accountLocked"),
		RATE_LIMITED: t("auth.errors.rateLimited"),
		CAPTCHA_FAILED: t("auth.errors.captchaFailed"),
		// Two-factor error codes
		INVALID_CODE: t("auth.errors.twoFactor.invalidCode"),
		OTP_NOT_ENABLED: t("auth.errors.twoFactor.otpNotEnabled"),
		OTP_HAS_EXPIRED: t("auth.errors.twoFactor.otpExpired"),
		TOTP_NOT_ENABLED: t("auth.errors.twoFactor.totpNotEnabled"),
		TWO_FACTOR_NOT_ENABLED: t("auth.errors.twoFactor.notEnabled"),
		BACKUP_CODES_NOT_ENABLED: t(
			"auth.errors.twoFactor.backupCodesNotEnabled",
		),
		INVALID_BACKUP_CODE: t("auth.errors.twoFactor.invalidBackupCode"),
		TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: t(
			"auth.errors.twoFactor.tooManyAttempts",
		),
		INVALID_TWO_FACTOR_COOKIE: t("auth.errors.twoFactor.invalidSession"),
		ACCOUNT_TEMPORARILY_LOCKED: t(
			"auth.errors.twoFactor.accountTemporarilyLocked",
		),
		STEP_UP_REQUIRED: t("auth.errors.twoFactor.stepUpRequired"),
		// Passkey error codes
		CHALLENGE_NOT_FOUND: t("auth.errors.passkey.challengeNotFound"),
		FAILED_TO_VERIFY_REGISTRATION: t(
			"auth.errors.passkey.registrationFailed",
		),
		PASSKEY_NOT_FOUND: t("auth.errors.passkey.notFound"),
		AUTHENTICATION_FAILED: t("auth.errors.passkey.authenticationFailed"),
		UNABLE_TO_CREATE_SESSION: t("auth.errors.passkey.sessionFailed"),
		FAILED_TO_UPDATE_PASSKEY: t("auth.errors.passkey.updateFailed"),
		YOU_ARE_NOT_ALLOWED_TO_REGISTER_THIS_PASSKEY: t(
			"auth.errors.passkey.notAllowed",
		),
		// Base error codes
		USER_ALREADY_HAS_PASSWORD: t("auth.errors.userAlreadyHasPassword"),
	};

	const getAuthErrorMessage = (errorCode: string | undefined) => {
		return (
			authErrorMessages[errorCode as keyof typeof authErrorMessages] ||
			t("auth.errors.unknown")
		);
	};

	return {
		getAuthErrorMessage,
	};
}
