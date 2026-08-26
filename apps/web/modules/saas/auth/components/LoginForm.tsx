"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { authClient } from "@repo/auth/client";
import { config } from "@repo/config";
import { useAuthErrorMessages } from "@saas/auth/hooks/errors-messages";
import { sessionQueryKey } from "@saas/auth/lib/api";
import { isInviteAccountMismatch } from "@saas/auth/lib/invite-account-mismatch";
import { safeRelativePath } from "@shared/lib/safe-redirect";
import { OrganizationInvitationAlert } from "@saas/organizations/components/OrganizationInvitationAlert";
import { useRouter } from "@shared/hooks/router";
import { useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
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
	EyeIcon,
	EyeOffIcon,
	KeyIcon,
	MailboxIcon,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SubmitHandler } from "react-hook-form";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { withQuery } from "ufo";
import { z } from "zod";
import {
	type OAuthProvider,
	oAuthProviders,
} from "../constants/oauth-providers";
import { useSession } from "../hooks/use-session";
import { EmailNotVerifiedAlert } from "./EmailNotVerifiedAlert";
import { LoginModeSwitch } from "./LoginModeSwitch";
import { SocialSigninButton } from "./SocialSigninButton";
import { TurnstileWidget } from "./TurnstileWidget";

const formSchema = z.union([
	z.object({
		mode: z.literal("magic-link"),
		email: z.string().email(),
	}),
	z.object({
		mode: z.literal("password"),
		email: z.string().email(),
		password: z.string().min(1),
	}),
]);

type FormValues = z.infer<typeof formSchema>;

interface LoginFormProps {
	invitationId?: string;
	email?: string;
}

export function LoginForm({
	invitationId: invitationIdProp,
	email: emailProp,
}: LoginFormProps = {}) {
	const t = useTranslations();
	const { getAuthErrorMessage } = useAuthErrorMessages();
	const router = useRouter();
	const queryClient = useQueryClient();
	const searchParams = useSearchParams();
	const { user, loaded: sessionLoaded } = useSession();

	const [showPassword, setShowPassword] = useState(false);
	const [mounted, setMounted] = useState(false);
	const verifiedShownRef = useRef(false);
	const [authErrorCode, setAuthErrorCode] = useState<string | null>(null);
	const [isLockedOut, setIsLockedOut] = useState(false);
	const [captchaToken, setCaptchaToken] = useState<string | null>(null);
	const [captchaResetKey, setCaptchaResetKey] = useState(0);
	const invitationId = invitationIdProp ?? searchParams.get("invitationId");
	const email = emailProp ?? searchParams.get("email");
	const redirectTo = safeRelativePath(searchParams.get("redirectTo"));
	const errorParam = searchParams.get("error");
	const invalidInvitation = errorParam === "invalid_invitation";

	// Exclude prop-injected invitationId/email from the link to /auth/signup
	// so they don't leak back into the URL.
	const forwardedParams = useMemo(() => {
		const out: Record<string, string> = {};
		for (const [k, v] of searchParams.entries()) {
			if (invitationIdProp && k === "invitationId") {
				continue;
			}
			if (emailProp && k === "email") {
				continue;
			}
			out[k] = v;
		}
		return out;
	}, [searchParams, invitationIdProp, emailProp]);

	const form = useForm<FormValues>({
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		resolver: zodResolver(formSchema as any),
		mode: "onBlur",
		reValidateMode: "onBlur",
		defaultValues: {
			email: email ?? "",
			password: "",
			mode: config.auth.enablePasswordLogin ? "password" : "magic-link",
		},
	});

	const redirectPath = invitationId
		? `/organization-invitation/${invitationId}`
		: (redirectTo ?? config.auth.redirectAfterSignIn);

	const inviteAccountMismatch = isInviteAccountMismatch(user?.email, email);

	const [isSwitching, setIsSwitching] = useState(false);

	const onSwitchAccount = () => {
		setIsSwitching(true);
		authClient.signOut({
			fetchOptions: {
				onSuccess: () => window.location.reload(),
				onError: () => {
					setIsSwitching(false);
					toast.error(getAuthErrorMessage(undefined));
				},
			},
		});
	};

	useEffect(() => {
		setMounted(true);
	}, []);

	useEffect(() => {
		if (verifiedShownRef.current) {
			return;
		}
		if (searchParams.get("verified") === "1") {
			verifiedShownRef.current = true;
			toast.success(t("auth.verification.confirmed"));
		}
	}, [searchParams, t]);

	useEffect(() => {
		if (
			sessionLoaded &&
			user &&
			!isInviteAccountMismatch(user.email, email)
		) {
			router.replace(redirectPath);
		}
	}, [user, sessionLoaded, email, redirectPath]);

	const onSubmit: SubmitHandler<FormValues> = async (values) => {
		setAuthErrorCode(null);
		try {
			if (values.mode === "password") {
				const { data, error } = await authClient.signIn.email({
					...values,
					captchaToken: captchaToken ?? undefined,
				} as any);

				if (error) {
					throw error;
				}

				setIsLockedOut(false);

				if ((data as any).twoFactorRedirect) {
					// Pass `redirectTo: redirectPath` so OtpForm resumes the
					// invitation flow after 2FA without leaking invitationId
					// back into the URL.
					router.replace(
						withQuery("/auth/verify", {
							...forwardedParams,
							redirectTo: redirectPath,
						}),
					);
					return;
				}

				queryClient.invalidateQueries({
					queryKey: sessionQueryKey,
				});

				router.replace(redirectPath);
			} else {
				const { error } = await authClient.signIn.magicLink({
					...values,
					callbackURL: redirectPath,
					captchaToken: captchaToken ?? undefined,
				} as any);

				if (error) {
					throw error;
				}
			}
		} catch (e) {
			setCaptchaToken(null);
			setCaptchaResetKey((k) => k + 1);
			// Better Auth auto-generates codes from the error message.
			// Custom brute force codes are in the error body, so check body.code first.
			const rawCode =
				e && typeof e === "object" && "code" in e
					? (e.code as string)
					: undefined;
			const bodyCode =
				e && typeof e === "object" && "body" in e
					? ((e as any).body?.code as string | undefined)
					: undefined;
			const errorCode = bodyCode ?? rawCode;
			setAuthErrorCode(errorCode ?? null);

			if (process.env.NODE_ENV === "development") {
				console.warn("[auth] Login error code:", errorCode);
			}

			if (errorCode === "ACCOUNT_LOCKED") {
				setIsLockedOut(true);
			}
			form.setError("root", {
				message: getAuthErrorMessage(errorCode),
			});
		}
	};

	const signInWithPasskey = async () => {
		try {
			const result = await authClient.signIn.passkey();
			// The passkey client resolves with `{ data: null, error }` instead
			// of throwing (it fetches with `throw: false` and catches WebAuthn
			// errors itself) — funnel failures into the catch below so a
			// rejected sign-in (cancelled dialog, or an assertion without user
			// verification) never redirects as success.
			if (result?.error) {
				throw result.error;
			}

			router.replace(redirectPath);
		} catch (e) {
			const errorCode =
				e && typeof e === "object" && "code" in e
					? (e.code as string)
					: undefined;
			setAuthErrorCode(errorCode ?? null);

			if (process.env.NODE_ENV === "development") {
				console.warn("[auth] Passkey error code:", errorCode);
			}

			form.setError("root", {
				message: getAuthErrorMessage(errorCode),
			});
		}
	};

	const signinMode = form.watch("mode");
	const emailValue = form.watch("email");
	const passwordValue = form.watch("password");
	const hasEmailError = Boolean(form.formState.errors.email);
	const isCaptchaRequired =
		config.auth.captcha.enabled && Boolean(config.auth.captcha.siteKey);
	const isSignInDisabled =
		emailValue.trim().length === 0 ||
		(signinMode === "password" && passwordValue.trim().length === 0) ||
		isLockedOut;

	// Defer form render until after mount to avoid Radix UI hydration mismatch
	// (useId generates different IDs on server vs client)
	if (!mounted) {
		return (
			<div>
				<h1 className="font-bold text-xl md:text-2xl">
					{t("auth.login.title")}
				</h1>
				<p className="mt-1 mb-6 text-foreground/60">
					{t("auth.login.subtitle")}
				</p>
				<div className="space-y-4 animate-pulse">
					<div className="h-10 rounded-md bg-muted" />
					<div className="h-10 rounded-md bg-muted" />
					<div className="h-10 rounded-md bg-muted" />
				</div>
			</div>
		);
	}

	if (sessionLoaded && user && inviteAccountMismatch) {
		return (
			<div>
				<h1 className="font-bold text-xl md:text-2xl">
					{t("auth.login.accountMismatch.title")}
				</h1>
				<p className="mt-1 mb-6 text-foreground/60">
					{t("auth.login.accountMismatch.description", {
						currentEmail: user.email,
						// `email` is non-null here (the panel only renders when
						// inviteAccountMismatch is true, which requires a truthy
						// email), but TS can't narrow across the helper call.
						invitationEmail: email ?? "",
					})}
				</p>
				<Button
					className="w-full"
					onClick={onSwitchAccount}
					disabled={isSwitching}
					loading={isSwitching}
				>
					<ArrowRightIcon className="mr-1.5 size-4" />
					{isSwitching
						? t("auth.login.accountMismatch.switching")
						: t("auth.login.accountMismatch.switchAccount")}
				</Button>
				<p className="mt-4 text-foreground/60 text-sm">
					{t("auth.login.accountMismatch.providerHint")}
				</p>
			</div>
		);
	}

	return (
		<div>
			<h1 className="font-bold text-xl md:text-2xl">
				{t("auth.login.title")}
			</h1>
			<p className="mt-1 mb-6 text-foreground/60">
				{t("auth.login.subtitle")}
			</p>

			{form.formState.isSubmitSuccessful &&
			signinMode === "magic-link" ? (
				<Alert variant="success">
					<MailboxIcon />
					<AlertTitle>
						{t("auth.login.hints.linkSent.title")}
					</AlertTitle>
					<AlertDescription>
						{t("auth.login.hints.linkSent.message")}
					</AlertDescription>
				</Alert>
			) : (
				<>
					{invitationId && (
						<OrganizationInvitationAlert className="mb-6" />
					)}

					{invalidInvitation && (
						<Alert variant="error" className="mb-6">
							<AlertTriangleIcon />
							<AlertTitle>
								{getAuthErrorMessage("INVALID_INVITATION")}
							</AlertTitle>
						</Alert>
					)}

					<Form {...form}>
						<form
							className="space-y-4"
							onSubmit={form.handleSubmit(onSubmit)}
						>
							{config.auth.enableMagicLink &&
								config.auth.enablePasswordLogin && (
									<LoginModeSwitch
										activeMode={signinMode}
										onChange={(mode) =>
											form.setValue(
												"mode",
												mode as typeof signinMode,
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
								form.formState.errors.root?.message &&
								(authErrorCode === "EMAIL_NOT_VERIFIED" ? (
									<EmailNotVerifiedAlert email={emailValue} />
								) : (
									<Alert variant="error">
										<AlertTriangleIcon />
										<AlertTitle>
											{form.formState.errors.root.message}
										</AlertTitle>
									</Alert>
								))}

							<FormField
								control={form.control}
								name="email"
								render={({ field }) => (
									<FormItem>
										<FormLabel>
											{t("auth.signup.email")}
										</FormLabel>
										<FormControl>
											<Input
												{...field}
												type="email"
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
														{t(
															"auth.signup.password",
														)}
													</FormLabel>

													<Link
														href="/auth/forgot-password"
														prefetch={false}
														className="text-foreground/60 text-xs"
													>
														{t(
															"auth.login.forgotPassword",
														)}
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
															autoComplete="current-password"
														/>
														<button
															type="button"
															onClick={() =>
																setShowPassword(
																	!showPassword,
																)
															}
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
								variant="secondary"
								loading={form.formState.isSubmitting}
								disabled={
									isSignInDisabled ||
									hasEmailError ||
									(isCaptchaRequired && !captchaToken)
								}
								aria-disabled={isLockedOut ? true : undefined}
							>
								{signinMode === "magic-link"
									? t("auth.login.sendMagicLink")
									: t("auth.login.submit")}
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
									Object.keys(oAuthProviders).map(
										(providerId) => (
											<SocialSigninButton
												key={providerId}
												provider={
													providerId as OAuthProvider
												}
											/>
										),
									)}

								{config.auth.enablePasskeys && (
									<Button
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
							<Link
								href={withQuery(
									"/auth/signup",
									forwardedParams,
								)}
								prefetch={false}
							>
								{t("auth.login.createAnAccount")}
								<ArrowRightIcon className="ml-1 inline size-4 align-middle" />
							</Link>
						</div>
					)}
				</>
			)}
		</div>
	);
}
