import { AiUsageLimitReached } from "../emails/AiUsageLimitReached";
import { AiUsageLimitWarning } from "../emails/AiUsageLimitWarning";
import { EmailChangeRequest } from "../emails/EmailChangeRequest";
import { EmailVerification } from "../emails/EmailVerification";
import { ForgotPassword } from "../emails/ForgotPassword";
import { MagicLink } from "../emails/MagicLink";
import { NewsletterApprovalPending } from "../emails/NewsletterApprovalPending";
import { NewsletterConfirm } from "../emails/NewsletterConfirm";
import { NewsletterSignup } from "../emails/NewsletterSignup";
import { NewUser } from "../emails/NewUser";
import { OrganizationInvitation } from "../emails/OrganizationInvitation";
import { ProjectInvitation } from "../emails/ProjectInvitation";
import { PublishingTopicsReady } from "../emails/PublishingTopicsReady";
import { ReadinessHelpRequested } from "../emails/ReadinessHelpRequested";
import { ReleaseNotesNewsletter } from "../emails/ReleaseNotesNewsletter";
import { ReportExecutionFailed } from "../emails/ReportExecutionFailed";
import { ReportExecutionReady } from "../emails/ReportExecutionReady";
import { SignupAttemptNotice } from "../emails/SignupAttemptNotice";
import { Welcome } from "../emails/Welcome";

export const mailTemplates = {
	aiUsageLimitReached: AiUsageLimitReached,
	aiUsageLimitWarning: AiUsageLimitWarning,
	emailChangeRequest: EmailChangeRequest,
	magicLink: MagicLink,
	forgotPassword: ForgotPassword,
	newUser: NewUser,
	newsletterApprovalPending: NewsletterApprovalPending,
	newsletterConfirm: NewsletterConfirm,
	newsletterSignup: NewsletterSignup,
	organizationInvitation: OrganizationInvitation,
	emailVerification: EmailVerification,
	projectInvitation: ProjectInvitation,
	publishingTopicsReady: PublishingTopicsReady,
	readinessHelpRequested: ReadinessHelpRequested,
	releaseNotesNewsletter: ReleaseNotesNewsletter,
	reportExecutionReady: ReportExecutionReady,
	reportExecutionFailed: ReportExecutionFailed,
	signupAttemptNotice: SignupAttemptNotice,
	welcome: Welcome,
} as const;
