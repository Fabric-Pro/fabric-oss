"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { authClient } from "@repo/auth/client";
import { config } from "@repo/config";
import { EmailNotVerifiedAlert } from "@saas/auth/components/EmailNotVerifiedAlert";
import { LoginModeSwitch } from "@saas/auth/components/LoginModeSwitch";
import { PasswordSuggestions } from "@saas/auth/components/PasswordSuggestions";
import { SocialSigninButton } from "@saas/auth/components/SocialSigninButton";
import { TurnstileWidget } from "@saas/auth/components/TurnstileWidget";
import {
	type OAuthProvider,
	oAuthProviders,
} from "@saas/auth/constants/oauth-providers";
import { useAuthErrorMessages } from "@saas/auth/hooks/errors-messages";
import {
	acceptProjectInvitationAction,
	declineProjectInvitationAction,
	signUpForProjectInvitationAction,
} from "@saas/projects/lib/project-invitation-actions";
import { useRouter } from "@shared/hooks/router";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@ui/components/form";
import { Input } from "@ui/components/input";
import {
	AlertTriangleIcon,
	ArrowRightIcon,
	CheckIcon,
	ClockIcon,
	EyeIcon,
	EyeOffIcon,
	FolderIcon,
	KeyIcon,
	LogInIcon,
	MailboxIcon,
	XIcon,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { withQuery } from "ufo";
import { z } from "zod";

export type ProjectInvitationState =
	| { type: "pending" }
	| { type: "expired" }
	| { type: "accepted" }
	| { type: "declined" }
	| { type: "needs_signup"; invitationId: string; email: string }
	| { type: "needs_login"; invitationId: string; email: string }
	| {
			type: "email_mismatch";
			invitationEmail: string;
			currentEmail: string;
	  };

const signUpSchema = z.object({
	name: z.string().trim().min(1, "Please enter your name"),
	password: z.string().min(12, "Password must be at least 12 characters"),
	acceptTerms: z.boolean(),
});

const signInSchema = z.discriminatedUnion("mode", [
	z.object({
		mode: z.literal("password"),
		email: z.string().email("Enter a valid email"),
		password: z.string().min(1, "Enter your password"),
	}),
	z.object({
		mode: z.literal("magic-link"),
		email: z.string().email("Enter a valid email"),
	}),
]);

type SignInFormValues = z.infer<typeof signInSchema>;

function formatRole(role: string): string {
	return role
		.toLowerCase()
		.split("_")
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}

export function ProjectInvitationModal({
	invitationId,
	projectId,
	projectName,
	organizationSlug,
	role,
	state,
}: {
	invitationId: string;
	projectId: string;
	projectName: string;
	organizationSlug: string | null;
	role: string;
	state: ProjectInvitationState;
}) {
	const t = useTranslations();
	const router = useRouter();
	const [submitting, setSubmitting] = useState<false | "accept" | "decline">(
		false,
	);
	const [switching, setSwitching] = useState(false);

	const onSwitchAccount = () => {
		setSwitching(true);
		authClient.signOut({
			fetchOptions: {
				onSuccess: () => {
					window.location.href = new URL(
						`/project-invitation/${invitationId}`,
						window.location.origin,
					).toString();
				},
				onError: () => {
					setSwitching(false);
					toast.error(t("auth.projectInvitation.errorGeneric"));
				},
			},
		});
	};

	const projectHref = organizationSlug
		? `/app/${organizationSlug}/projects/${projectId}`
		: `/app/projects/${projectId}`;

	const onSelectAnswer = async (accept: boolean) => {
		setSubmitting(accept ? "accept" : "decline");
		try {
			const result = accept
				? await acceptProjectInvitationAction(invitationId)
				: await declineProjectInvitationAction(invitationId);

			if (!result.success) {
				if (result.code === "INVITATION_NOT_FOUND") {
					toast.error(t("auth.projectInvitation.invitationNotFound"));
				} else if (result.code === "UNAUTHENTICATED") {
					toast.error(t("auth.projectInvitation.signInRequired"));
				} else {
					toast.error(t("auth.projectInvitation.errorGeneric"));
				}
				return;
			}

			if (accept) {
				router.replace(projectHref);
			} else {
				router.replace("/app");
			}
		} finally {
			setSubmitting(false);
		}
	};

	const projectCard = (
		<div className="mb-6 flex items-center gap-3 rounded-lg border p-3">
			<div className="flex size-12 items-center justify-center rounded-md bg-muted">
				<FolderIcon className="size-6 text-muted-foreground" />
			</div>
			<div>
				<div className="font-medium text-lg">{projectName}</div>
				<div className="text-muted-foreground text-sm">
					{t("auth.projectInvitation.role", {
						role: formatRole(role),
					})}
				</div>
			</div>
		</div>
	);

	if (state.type === "expired") {
		return (
			<div>
				<h1 className="font-bold text-xl md:text-2xl">
					{t("auth.projectInvitation.expiredTitle")}
				</h1>
				<p className="mt-1 mb-6 text-foreground/60">
					{t.rich("auth.projectInvitation.expiredMessage", {
						projectName: () => <strong>{projectName}</strong>,
					})}
				</p>
				{projectCard}
				<div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-destructive text-sm">
					<ClockIcon className="size-4 shrink-0" />
					<span>{t("auth.projectInvitation.expiredNotice")}</span>
				</div>
			</div>
		);
	}

	if (state.type === "accepted") {
		return (
			<div>
				<h1 className="font-bold text-xl md:text-2xl">
					{t("auth.projectInvitation.acceptedTitle")}
				</h1>
				<p className="mt-1 mb-6 text-foreground/60">
					{t.rich("auth.projectInvitation.acceptedMessage", {
						projectName: () => <strong>{projectName}</strong>,
					})}
				</p>
				{projectCard}
				<Button
					className="w-full"
					onClick={() => router.replace(projectHref)}
				>
					{t("auth.projectInvitation.openProject")}
					<ArrowRightIcon className="ml-1.5 size-4" />
				</Button>
			</div>
		);
	}

	if (state.type === "declined") {
		return (
			<div>
				<h1 className="font-bold text-xl md:text-2xl">
					{t("auth.projectInvitation.declinedTitle")}
				</h1>
				<p className="mt-1 mb-6 text-foreground/60">
					{t.rich("auth.projectInvitation.declinedMessage", {
						projectName: () => <strong>{projectName}</strong>,
					})}
				</p>
				{projectCard}
				<Button
					className="w-full"
					variant="light"
					onClick={() => router.replace("/app")}
				>
					{t("auth.projectInvitation.goToDashboard")}
					<ArrowRightIcon className="ml-1.5 size-4" />
				</Button>
			</div>
		);
	}

	if (state.type === "needs_signup" || state.type === "needs_login") {
		const initialMode: "signup" | "login" =
			state.type === "needs_signup" ? "signup" : "login";
		const seedEmail = state.email;
		return (
			<NeedsAuthBranch
				invitationId={state.invitationId}
				seedEmail={seedEmail}
				projectName={projectName}
				projectHref={projectHref}
				projectCard={projectCard}
				initialMode={initialMode}
			/>
		);
	}

	if (state.type === "email_mismatch") {
		return (
			<div>
				<h1 className="font-bold text-xl md:text-2xl">
					{t("auth.projectInvitation.emailMismatchTitle")}
				</h1>
				<p className="mt-1 mb-6 text-foreground/60">
					{t.rich("auth.projectInvitation.emailMismatchMessage", {
						invitationEmail: () => (
							<strong>{state.invitationEmail}</strong>
						),
						currentEmail: () => (
							<strong>{state.currentEmail}</strong>
						),
					})}
				</p>
				{projectCard}
				<Button
					className="w-full"
					variant="light"
					onClick={onSwitchAccount}
					disabled={switching}
					loading={switching}
				>
					<LogInIcon className="mr-1.5 size-4" />
					{switching
						? t("auth.projectInvitation.signingOut")
						: t("auth.projectInvitation.signInWithInvitedEmail", {
								email: state.invitationEmail,
							})}
				</Button>
				<p className="mt-4 text-foreground/60 text-sm">
					{t("auth.projectInvitation.providerHint", {
						currentEmail: state.currentEmail,
					})}
				</p>
			</div>
		);
	}

	// Pending + authenticated with matching email
	return (
		<div>
			<h1 className="font-bold text-xl md:text-2xl">
				{t("auth.projectInvitation.pendingTitle")}
			</h1>
			<p className="mt-1 mb-6 text-foreground/60">
				{t.rich("auth.projectInvitation.pendingMessage", {
					role: () => <strong>{formatRole(role)}</strong>,
					projectName: () => <strong>{projectName}</strong>,
				})}
			</p>
			{projectCard}
			<div className="flex gap-2">
				<Button
					className="flex-1"
					variant="light"
					onClick={() => onSelectAnswer(false)}
					disabled={!!submitting}
					loading={submitting === "decline"}
				>
					<XIcon className="mr-1.5 size-4" />
					{t("auth.projectInvitation.decline")}
				</Button>
				<Button
					className="flex-1"
					onClick={() => onSelectAnswer(true)}
					disabled={!!submitting}
					loading={submitting === "accept"}
				>
					<CheckIcon className="mr-1.5 size-4" />
					{t("auth.projectInvitation.accept")}
				</Button>
			</div>
		</div>
	);
}

function NeedsAuthBranch({
	invitationId,
	seedEmail,
	projectName,
	projectHref,
	projectCard,
	initialMode,
}: {
	invitationId: string;
	seedEmail: string | null;
	projectName: string;
	projectHref: string;
	projectCard: ReactNode;
	initialMode: "signup" | "login";
}) {
	const [mode, setMode] = useState<"signup" | "login">(initialMode);
	const [captchaToken, setCaptchaToken] = useState<string | null>(null);
	const [captchaResetKey, setCaptchaResetKey] = useState(0);

	const resetCaptcha = () => {
		setCaptchaToken(null);
		setCaptchaResetKey((k) => k + 1);
	};

	if (mode === "signup") {
		return (
			<NeedsSignupForm
				invitationId={invitationId}
				email={seedEmail ?? ""}
				projectName={projectName}
				projectCard={projectCard}
				captchaToken={captchaToken}
				captchaResetKey={captchaResetKey}
				setCaptchaToken={setCaptchaToken}
				resetCaptcha={resetCaptcha}
				onSwitchMode={setMode}
			/>
		);
	}

	return (
		<NeedsLoginForm
			invitationId={invitationId}
			projectName={projectName}
			projectHref={projectHref}
			projectCard={projectCard}
			prefillEmail={seedEmail ?? ""}
			captchaToken={captchaToken}
			captchaResetKey={captchaResetKey}
			setCaptchaToken={setCaptchaToken}
			resetCaptcha={resetCaptcha}
			onSwitchMode={setMode}
		/>
	);
}

function NeedsSignupForm({
	invitationId,
	email,
	projectName,
	projectCard,
	captchaToken,
	captchaResetKey,
	setCaptchaToken,
	resetCaptcha,
	onSwitchMode,
}: {
	invitationId: string;
	email: string;
	projectName: string;
	projectCard: ReactNode;
	captchaToken: string | null;
	captchaResetKey: number;
	setCaptchaToken: (token: string | null) => void;
	resetCaptcha: () => void;
	onSwitchMode: (mode: "signup" | "login") => void;
}) {
	const t = useTranslations();
	const { getAuthErrorMessage } = useAuthErrorMessages();
	const [showPassword, setShowPassword] = useState(false);
	const [passwordSuggestions, setPasswordSuggestions] = useState<
		string[] | null
	>(null);
	// Set after a successful signup: the account exists but is unverified.
	// The user must click the verification link we just emailed; verifying
	// triggers invite reconciliation server-side (the invitation is accepted
	// automatically) and signs them in, returning them to this page.
	const [verificationSentTo, setVerificationSentTo] = useState<string | null>(
		null,
	);

	const isCaptchaRequired =
		config.auth.captcha.enabled && Boolean(config.auth.captcha.siteKey);

	const form = useForm<z.infer<typeof signUpSchema>>({
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		resolver: zodResolver(signUpSchema as any),
		mode: "onBlur",
		reValidateMode: "onBlur",
		defaultValues: { name: "", password: "", acceptTerms: false },
	});

	const acceptTerms = form.watch("acceptTerms");
	const nameValue = form.watch("name");
	const passwordValue = form.watch("password");
	const isFormIncomplete =
		nameValue.trim().length === 0 || passwordValue.trim().length === 0;

	const onSubmit = form.handleSubmit(
		async ({ name, password, acceptTerms }) => {
			if (!acceptTerms) {
				form.setError("acceptTerms", {
					message: t("auth.signup.acceptTermsError"),
				});
				return;
			}
			form.clearErrors("root");
			setPasswordSuggestions(null);
			try {
				const signUp = await signUpForProjectInvitationAction({
					invitationId,
					name,
					password,
					captchaToken: captchaToken ?? undefined,
				});
				resetCaptcha();
				if (!signUp.success) {
					if (signUp.code === "PASSWORD_TOO_WEAK") {
						setPasswordSuggestions(signUp.suggestions ?? []);
						form.setError("password", {
							message:
								signUp.message ??
								getAuthErrorMessage("PASSWORD_TOO_SHORT"),
						});
					} else if (signUp.code === "CAPTCHA_FAILED") {
						form.setError("root", {
							message: getAuthErrorMessage("CAPTCHA_FAILED"),
						});
					} else if (signUp.code === "USER_EXISTS") {
						form.setError("root", {
							message: getAuthErrorMessage("USER_ALREADY_EXISTS"),
						});
					} else {
						form.setError("root", {
							message: getAuthErrorMessage(
								"FAILED_TO_CREATE_USER",
							),
						});
					}
					return;
				}

				// Account created (unverified). Show the check-your-email
				// state — verification + invitation acceptance complete
				// server-side once the user clicks the emailed link.
				setVerificationSentTo(signUp.email);
			} catch (_e) {
				resetCaptcha();
				form.setError("root", {
					message: getAuthErrorMessage(undefined),
				});
			}
		},
	);

	const rootErrorMessage = form.formState.errors.root?.message;

	if (verificationSentTo) {
		return (
			<div>
				<h1 className="font-bold text-xl md:text-2xl">
					{t("auth.projectInvitation.verifyEmailSentTitle")}
				</h1>
				<p className="mt-1 mb-6 text-foreground/60">
					{t.rich("auth.projectInvitation.verifyEmailSentMessage", {
						email: () => <strong>{verificationSentTo}</strong>,
						projectName: () => <strong>{projectName}</strong>,
					})}
				</p>
				{projectCard}
				<Alert variant="success" role="status">
					<MailboxIcon />
					<AlertTitle>
						{t("auth.signup.hints.verifyEmail")}
					</AlertTitle>
					<AlertDescription>
						{t("auth.projectInvitation.verifyEmailSentSpamHint")}
					</AlertDescription>
				</Alert>
				<div className="mt-4">
					<EmailNotVerifiedAlert
						variant="inline"
						email={verificationSentTo}
						startCooldownOnMount
					/>
				</div>
			</div>
		);
	}

	return (
		<div>
			<h1 className="font-bold text-xl md:text-2xl">
				{t("auth.projectInvitation.signupTitle")}
			</h1>
			<p className="mt-1 mb-6 text-foreground/60">
				{t.rich("auth.projectInvitation.signupMessage", {
					projectName: () => <strong>{projectName}</strong>,
				})}
			</p>
			{projectCard}
			<Form {...form}>
				<form className="flex flex-col gap-4" onSubmit={onSubmit}>
					{form.formState.isSubmitted && rootErrorMessage && (
						<Alert variant="error">
							<AlertTriangleIcon />
							<AlertDescription>
								{rootErrorMessage}
							</AlertDescription>
						</Alert>
					)}
					<FormItem>
						<FormLabel>{t("auth.signup.email")}</FormLabel>
						<FormControl>
							<Input
								type="email"
								value={email}
								readOnly
								disabled
								autoComplete="email"
							/>
						</FormControl>
					</FormItem>
					<FormField
						control={form.control}
						name="name"
						render={({ field }) => (
							<FormItem>
								<FormLabel>
									{t("auth.projectInvitation.fullName")}
								</FormLabel>
								<FormControl>
									<Input
										{...field}
										autoFocus
										autoComplete="name"
									/>
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>
					<FormField
						control={form.control}
						name="password"
						render={({ field }) => (
							<FormItem>
								<FormLabel>
									{t("auth.signup.password")}
								</FormLabel>
								<FormControl>
									<div className="relative">
										<Input
											type={
												showPassword
													? "text"
													: "password"
											}
											className="pr-10"
											{...field}
											autoComplete="new-password"
										/>
										<button
											type="button"
											onClick={() =>
												setShowPassword(!showPassword)
											}
											aria-label={t(
												"auth.signup.password",
											)}
											className="absolute inset-y-0 right-0 flex items-center pr-4 text-primary text-xl"
										>
											{showPassword ? (
												<EyeOffIcon className="size-4" />
											) : (
												<EyeIcon className="size-4" />
											)}
										</button>
									</div>
								</FormControl>
								<FormMessage />
								{passwordSuggestions &&
									passwordSuggestions.length > 0 && (
										<PasswordSuggestions
											suggestions={passwordSuggestions}
										/>
									)}
							</FormItem>
						)}
					/>
					<FormField
						control={form.control}
						name="acceptTerms"
						render={({ field }) => (
							<FormItem className="space-y-2">
								<div className="flex items-start gap-2">
									<FormControl>
										<Checkbox
											checked={field.value}
											onCheckedChange={(checked) =>
												field.onChange(checked === true)
											}
										/>
									</FormControl>
									<FormLabel className="font-normal text-sm leading-5">
										{t("auth.signup.acceptTermsPrefix")}{" "}
										<Link
											href="/legal/terms"
											target="_blank"
											rel="noreferrer"
											className="underline"
										>
											{t("auth.signup.termsOfService")}
										</Link>{" "}
										{t("auth.signup.and")}{" "}
										<Link
											href="/legal/privacy-policy"
											target="_blank"
											rel="noreferrer"
											className="underline"
										>
											{t("auth.signup.privacyPolicy")}
										</Link>
										.
									</FormLabel>
								</div>
								<FormMessage />
							</FormItem>
						)}
					/>
					<TurnstileWidget
						onSuccess={setCaptchaToken}
						onError={() => setCaptchaToken(null)}
						onExpire={() => setCaptchaToken(null)}
						resetKey={captchaResetKey}
					/>
					<Button
						type="submit"
						loading={form.formState.isSubmitting}
						disabled={
							!acceptTerms ||
							isFormIncomplete ||
							form.formState.isSubmitting ||
							(isCaptchaRequired && !captchaToken)
						}
					>
						{t("auth.projectInvitation.createAccountAndJoin")}
						<ArrowRightIcon className="ml-1.5 size-4" />
					</Button>
				</form>
			</Form>

			{config.auth.enableSignup && config.auth.enableSocialLogin && (
				<>
					<div className="relative my-6 h-4">
						<hr className="relative top-2" />
						<p className="-translate-x-1/2 absolute top-0 left-1/2 mx-auto inline-block h-4 bg-card px-2 text-center font-medium text-foreground/60 text-sm leading-tight">
							{t("auth.login.continueWith")}
						</p>
					</div>

					<div className="grid grid-cols-1 items-stretch gap-2 sm:grid-cols-2">
						{Object.keys(oAuthProviders).map((providerId) => (
							<SocialSigninButton
								key={providerId}
								provider={providerId as OAuthProvider}
								disabled={!acceptTerms}
								callbackURL={`/project-invitation/${invitationId}`}
							/>
						))}
					</div>
				</>
			)}

			<div className="mt-6 text-center text-sm">
				<span className="text-foreground/60">
					{t("auth.signup.alreadyHaveAccount")}{" "}
				</span>
				<button
					type="button"
					onClick={() => onSwitchMode("login")}
					className="text-primary underline-offset-2 hover:underline"
				>
					{t("auth.signup.signIn")}
					<ArrowRightIcon className="ml-1 inline size-4 align-middle" />
				</button>
			</div>
		</div>
	);
}

function NeedsLoginForm({
	invitationId,
	projectName,
	projectHref,
	projectCard,
	prefillEmail,
	captchaToken,
	captchaResetKey,
	setCaptchaToken,
	resetCaptcha,
	onSwitchMode,
}: {
	invitationId: string;
	projectName: string;
	projectHref: string;
	projectCard: ReactNode;
	prefillEmail: string;
	captchaToken: string | null;
	captchaResetKey: number;
	setCaptchaToken: (token: string | null) => void;
	resetCaptcha: () => void;
	onSwitchMode: (mode: "signup" | "login") => void;
}) {
	const t = useTranslations();
	const { getAuthErrorMessage } = useAuthErrorMessages();
	const router = useRouter();
	const [showPassword, setShowPassword] = useState(false);
	const [authErrorCode, setAuthErrorCode] = useState<string | null>(null);
	const [isLockedOut, setIsLockedOut] = useState(false);

	const isCaptchaRequired =
		config.auth.captcha.enabled && Boolean(config.auth.captcha.siteKey);

	const form = useForm<SignInFormValues>({
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		resolver: zodResolver(signInSchema as any),
		mode: "onBlur",
		reValidateMode: "onBlur",
		defaultValues: {
			mode: config.auth.enablePasswordLogin ? "password" : "magic-link",
			email: prefillEmail,
			password: "",
		},
	});

	const signinMode = form.watch("mode");
	const emailValue = form.watch("email") ?? "";
	const passwordValue = form.watch("password") ?? "";
	const hasEmailError = Boolean(form.formState.errors.email);
	const isSignInDisabled =
		emailValue.trim().length === 0 ||
		(signinMode === "password" && passwordValue.trim().length === 0) ||
		isLockedOut;

	const onSubmit = form.handleSubmit(async (values) => {
		setAuthErrorCode(null);
		try {
			if (values.mode === "password") {
				const { data, error } = await authClient.signIn.email({
					email: values.email,
					password: values.password,
					captchaToken: captchaToken ?? undefined,
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
				} as any);

				if (error) {
					throw error;
				}

				setIsLockedOut(false);

				if (
					(data as { twoFactorRedirect?: boolean })
						?.twoFactorRedirect === true
				) {
					router.replace(
						withQuery("/auth/verify", {
							redirectTo: `/project-invitation/${invitationId}`,
						}),
					);
					return;
				}

				const accept =
					await acceptProjectInvitationAction(invitationId);
				if (!accept.success) {
					if (accept.code === "INVITATION_NOT_FOUND") {
						form.setError("root", {
							message: t(
								"auth.projectInvitation.invitationInvalidGenericLogin",
							),
						});
					} else {
						form.setError("root", {
							message: t(
								"auth.projectInvitation.acceptInvitationFailed",
							),
						});
					}
					return;
				}

				toast.success(
					t("auth.projectInvitation.welcomeToast", { projectName }),
				);
				router.replace(projectHref);
			} else {
				const { error } = await authClient.signIn.magicLink({
					email: values.email,
					callbackURL: `/project-invitation/${invitationId}`,
					captchaToken: captchaToken ?? undefined,
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
				} as any);
				if (error) {
					throw error;
				}
			}
		} catch (e) {
			resetCaptcha();
			const rawCode =
				e && typeof e === "object" && "code" in e
					? (e.code as string)
					: undefined;
			const bodyCode =
				e && typeof e === "object" && "body" in e
					? ((e as { body?: { code?: string } }).body?.code as
							| string
							| undefined)
					: undefined;
			const errorCode = bodyCode ?? rawCode;
			setAuthErrorCode(errorCode ?? null);

			if (errorCode === "ACCOUNT_LOCKED") {
				setIsLockedOut(true);
			}
			form.setError("root", {
				message: getAuthErrorMessage(errorCode),
			});
		}
	});

	const signInWithPasskey = async () => {
		setAuthErrorCode(null);
		try {
			const result = await authClient.signIn.passkey();
			// The passkey client resolves with `{ data: null, error }` instead
			// of throwing (it fetches with `throw: false` and catches WebAuthn
			// errors itself) — funnel failures into the catch below so a
			// rejected sign-in never proceeds to invitation acceptance without
			// a session.
			if (result?.error) {
				throw result.error;
			}
			const accept = await acceptProjectInvitationAction(invitationId);
			if (!accept.success) {
				// The passkey may have authenticated a different account than the
				// invite targets. Reload the invite page so the server re-evaluates
				// the session and renders the email_mismatch screen (with the
				// switch-account CTA) when appropriate, instead of stranding the
				// user on this form signed in as the wrong account.
				window.location.href = new URL(
					`/project-invitation/${invitationId}`,
					window.location.origin,
				).toString();
				return;
			}
			toast.success(
				t("auth.projectInvitation.welcomeToast", { projectName }),
			);
			router.replace(projectHref);
		} catch (e) {
			const errorCode =
				e && typeof e === "object" && "code" in e
					? (e.code as string)
					: undefined;
			setAuthErrorCode(errorCode ?? null);
			form.setError("root", {
				message: getAuthErrorMessage(errorCode),
			});
		}
	};

	const rootErrorMessage = form.formState.errors.root?.message;

	if (form.formState.isSubmitSuccessful && signinMode === "magic-link") {
		return (
			<div>
				<h1 className="font-bold text-xl md:text-2xl">
					{t("auth.projectInvitation.loginTitle")}
				</h1>
				<p className="mt-1 mb-6 text-foreground/60">
					{t.rich("auth.projectInvitation.loginMessage", {
						projectName: () => <strong>{projectName}</strong>,
					})}
				</p>
				{projectCard}
				<Alert variant="success" role="status">
					<MailboxIcon />
					<AlertTitle>
						{t("auth.login.hints.linkSent.title")}
					</AlertTitle>
					<AlertDescription>
						{t("auth.login.hints.linkSent.message")}
					</AlertDescription>
				</Alert>
			</div>
		);
	}

	return (
		<div>
			<h1 className="font-bold text-xl md:text-2xl">
				{t("auth.projectInvitation.loginTitle")}
			</h1>
			<p className="mt-1 mb-6 text-foreground/60">
				{t.rich("auth.projectInvitation.loginMessage", {
					projectName: () => <strong>{projectName}</strong>,
				})}
			</p>
			{projectCard}
			<Form {...form}>
				<form className="space-y-4" onSubmit={onSubmit}>
					{config.auth.enableMagicLink &&
						config.auth.enablePasswordLogin && (
							<LoginModeSwitch
								activeMode={signinMode}
								onChange={(nextMode) =>
									form.setValue(
										"mode",
										nextMode as typeof signinMode,
									)
								}
							/>
						)}

					{isLockedOut && (
						<Alert variant="error">
							<AlertTriangleIcon />
							<AlertTitle>
								{t("auth.errors.accountLocked")}
							</AlertTitle>
							<AlertDescription>
								<Link
									href="/auth/forgot-password"
									prefetch={false}
									className="text-primary underline"
								>
									{t("auth.login.resetToUnlock")}
								</Link>
							</AlertDescription>
						</Alert>
					)}

					{!isLockedOut &&
						form.formState.isSubmitted &&
						rootErrorMessage &&
						(authErrorCode === "EMAIL_NOT_VERIFIED" ? (
							<EmailNotVerifiedAlert email={emailValue} />
						) : (
							<Alert variant="error">
								<AlertTriangleIcon />
								<AlertTitle>{rootErrorMessage}</AlertTitle>
							</Alert>
						))}

					<FormField
						control={form.control}
						name="email"
						render={({ field }) => (
							<FormItem>
								<FormLabel>{t("auth.signup.email")}</FormLabel>
								<FormControl>
									<Input
										{...field}
										type="email"
										autoFocus
										autoComplete="email"
									/>
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>

					{config.auth.enablePasswordLogin &&
						signinMode === "password" && (
							<FormField
								control={form.control}
								name="password"
								render={({ field }) => (
									<FormItem>
										<div className="flex justify-between gap-4">
											<FormLabel>
												{t("auth.signup.password")}
											</FormLabel>
											<Link
												href="/auth/forgot-password"
												prefetch={false}
												className="text-foreground/60 text-xs"
											>
												{t("auth.login.forgotPassword")}
											</Link>
										</div>
										<FormControl>
											<div className="relative">
												<Input
													type={
														showPassword
															? "text"
															: "password"
													}
													className="pr-10"
													{...field}
													value={field.value ?? ""}
													autoComplete="current-password"
												/>
												<button
													type="button"
													onClick={() =>
														setShowPassword(
															!showPassword,
														)
													}
													aria-label={t(
														"auth.signup.password",
													)}
													className="absolute inset-y-0 right-0 flex items-center pr-4 text-primary text-xl"
												>
													{showPassword ? (
														<EyeOffIcon className="size-4" />
													) : (
														<EyeIcon className="size-4" />
													)}
												</button>
											</div>
										</FormControl>
									</FormItem>
								)}
							/>
						)}

					<TurnstileWidget
						onSuccess={setCaptchaToken}
						onError={() => setCaptchaToken(null)}
						onExpire={() => setCaptchaToken(null)}
						resetKey={captchaResetKey}
					/>

					<Button
						className="w-full"
						type="submit"
						loading={form.formState.isSubmitting}
						disabled={
							isSignInDisabled ||
							hasEmailError ||
							(isCaptchaRequired && !captchaToken)
						}
						aria-disabled={isLockedOut ? true : undefined}
					>
						<LogInIcon className="mr-1.5 size-4" />
						{signinMode === "magic-link"
							? t("auth.login.sendMagicLink")
							: t("auth.projectInvitation.signInAndJoin")}
					</Button>
				</form>
			</Form>

			{(config.auth.enablePasskeys ||
				(config.auth.enableSignup &&
					config.auth.enableSocialLogin)) && (
				<>
					<div className="relative my-6 h-4">
						<hr className="relative top-2" />
						<p className="-translate-x-1/2 absolute top-0 left-1/2 mx-auto inline-block h-4 bg-card px-2 text-center font-medium text-foreground/60 text-sm leading-tight">
							{t("auth.login.continueWith")}
						</p>
					</div>

					<div className="grid grid-cols-1 items-stretch gap-2 sm:grid-cols-2">
						{config.auth.enableSignup &&
							config.auth.enableSocialLogin &&
							Object.keys(oAuthProviders).map((providerId) => (
								<SocialSigninButton
									key={providerId}
									provider={providerId as OAuthProvider}
									callbackURL={`/project-invitation/${invitationId}`}
								/>
							))}

						{config.auth.enablePasskeys && (
							<Button
								type="button"
								variant="light"
								className="w-full sm:col-span-2"
								onClick={() => signInWithPasskey()}
							>
								<KeyIcon className="mr-1.5 size-4 text-primary" />
								{t("auth.login.loginWithPasskey")}
							</Button>
						)}
					</div>
				</>
			)}

			{config.auth.enableSignup && (
				<div className="mt-6 text-center text-sm">
					<span className="text-foreground/60">
						{t("auth.login.dontHaveAnAccount")}{" "}
					</span>
					<button
						type="button"
						onClick={() => onSwitchMode("signup")}
						className="text-primary underline-offset-2 hover:underline"
					>
						{t("auth.login.createAnAccount")}
						<ArrowRightIcon className="ml-1 inline size-4 align-middle" />
					</button>
				</div>
			)}
		</div>
	);
}
