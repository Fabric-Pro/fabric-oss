import { getBackupCodesStatus } from "./procedures/get-backup-codes-status";
import { resendVerificationEmail } from "./procedures/resend-verification-email";
import { revokeEmailChange } from "./procedures/revoke-email-change";

export const authRouter = {
	resendVerificationEmail,
	revokeEmailChange,
	getBackupCodesStatus,
};
