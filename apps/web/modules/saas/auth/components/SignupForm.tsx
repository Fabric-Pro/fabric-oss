"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { authClient } from "@repo/auth/client";
import { config } from "@repo/config";
import { useAuthErrorMessages } from "@saas/auth/hooks/errors-messages";
import { safeRelativePath } from "@shared/lib/safe-redirect";
import { OrganizationInvitationAlert } from "@saas/organizations/components/OrganizationInvitationAlert";
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
	EyeIcon,
	EyeOffIcon,
	MailboxIcon,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { withQuery } from "ufo";
import { z } from "zod";
import {
	type OAuthProvider,
	oAuthProviders,
} from "../constants/oauth-providers";
import { EmailNotVerifiedAlert } from "./EmailNotVerifiedAlert";
import { PasswordSuggestions } from "./PasswordSuggestions";
import { SocialSigninButton } from "./SocialSigninButton";
import { TurnstileWidget } from "./TurnstileWidget";

const formSchema = z.object({
	email: z.string().email(),
	name: z.string().min(1),
	password: z.string().min(12, "Password must be at least 12 characters"),
	acceptTerms: z.boolean(),
});

interface SignupFormProps {
	invitationId?: string;
	email?: string;
}

export function SignupForm({
	invitationId: invitationIdProp,
	email: emailProp,
}: SignupFormProps = {}) {
	const t = useTranslations();
	const { getAuthErrorMessage } = useAuthErrorMessages();
	const searchParams = useSearchParams();

	const [showPassword, setShowPassword] = useState(false);
	const [captchaToken, setCaptchaToken] = useState<string | null>(null);
	const [captchaResetKey, setCaptchaResetKey] = useState(0);
	const [passwordSuggestions, setPasswordSuggestions] = useState<
		string[] | null
	>(null);
	const invitationId = invitationIdProp ?? searchParams.get("invitationId");
	const email = emailProp ?? searchParams.get("email");
	const redirectTo = safeRelativePath(searchParams.get("redirectTo"));
	const errorParam = searchParams.get("error");
	const invalidInvitation = errorParam === "invalid_invitation";

	// Exclude prop-injected invitationId/email from the link to /auth/login
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

	const form = useForm<z.infer<typeof formSchema>>({
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		resolver: zodResolver(formSchema as any),
		mode: "onBlur",
		reValidateMode: "onBlur",
		values: {
			name: "",
			email: email ?? "",
			password: "",
			acceptTerms: false,
		},
	});

	const acceptTerms = form.watch("acceptTerms");
	const nameValue = form.watch("name");
	const emailValue = form.watch("email");
	const passwordValue = form.watch("password");
	const hasEmailError = Boolean(form.formState.errors.email);
	const isCaptchaRequired =
		config.auth.captcha.enabled && Boolean(config.auth.captcha.siteKey);
	const isFormIncomplete =
		nameValue.trim().length === 0 ||
		emailValue.trim().length === 0 ||
		(config.auth.enablePasswordLogin && passwordValue.trim().length === 0);

	const redirectPath = invitationId
		? `/organization-invitation/${invitationId}`
		: (redirectTo ?? config.auth.redirectAfterSignIn);

	const onSubmit = form.handleSubmit(
		async ({ email, password, name, acceptTerms }) => {
			if (!acceptTerms) {
				form.setError("acceptTerms", {
					message: t("auth.signup.acceptTermsError"),
				});
				return;
			}

			try {
				const { error } = await (config.auth.enablePasswordLogin
					? await authClient.signUp.email({
							email,
							password,
							name,
							callbackURL: redirectPath,
							captchaToken: captchaToken ?? undefined,
						} as any)
					: authClient.signIn.magicLink({
							email,
							name,
							callbackURL: redirectPath,
							captchaToken: captchaToken ?? undefined,
						} as any));

				if (error) {
					const rawCode =
						error && typeof error === "object" && "code" in error
							? (error.code as string)
							: undefined;
					const bodyCode = (error as { body?: { code?: string } })
						.body?.code;
					// Silently treat duplicate-email signup as success — the
					// server has already sent a notice to the existing address,
					// and the "check your inbox" alert below renders identically
					// to the fresh-signup success path.
					if (
						rawCode === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" ||
						bodyCode === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"
					) {
						setPasswordSuggestions(null);
						return;
					}
					throw error;
				}
			} catch (e) {
				setCaptchaToken(null);
				setCaptchaResetKey((k) => k + 1);
				const rawCode =
					e && typeof e === "object" && "code" in e
						? (e.code as string)
						: undefined;
				const body =
					e && typeof e === "object" && "body" in e
						? (e as any).body
						: undefined;
				const bodyCode = body?.code as string | undefined;
				if (bodyCode === "PASSWORD_TOO_WEAK") {
					setPasswordSuggestions(body?.suggestions ?? []);
					form.setError("password", {
						message: body?.message ?? "Password is too weak.",
					});
				} else {
					setPasswordSuggestions(null);
					form.setError("root", {
						message: getAuthErrorMessage(bodyCode ?? rawCode),
					});
				}
			}
		},
	);

	return (
		<div>
			<h1 className="font-bold text-xl md:text-2xl">
				{t("auth.signup.title")}
			</h1>
			<p className="mt-1 mb-6 text-foreground/60">
				{t("auth.signup.message")}
			</p>

			{form.formState.isSubmitSuccessful ? (
				<>
					<Alert variant="success">
						<MailboxIcon />
						<AlertTitle>
							{t("auth.signup.hints.verifyEmail")}
						</AlertTitle>
					</Alert>
					<div className="mt-4">
						<EmailNotVerifiedAlert
							variant="inline"
							email={emailValue}
							startCooldownOnMount
						/>
					</div>
				</>
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
							className="flex flex-col items-stretch gap-4"
							onSubmit={onSubmit}
						>
							{form.formState.isSubmitted &&
								form.formState.errors.root && (
									<Alert variant="error">
										<AlertTriangleIcon />
										<AlertDescription>
											{form.formState.errors.root.message}
										</AlertDescription>
									</Alert>
								)}

							<FormField
								control={form.control}
								name="name"
								render={({ field }) => (
									<FormItem>
										<FormLabel>
											{t("auth.signup.name")}
										</FormLabel>
										<FormControl>
											<Input {...field} />
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>

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
												readOnly={!!emailProp}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>

							{config.auth.enablePasswordLogin && (
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
											<FormMessage />
											{passwordSuggestions &&
												passwordSuggestions.length >
													0 && (
													<PasswordSuggestions
														suggestions={
															passwordSuggestions
														}
													/>
												)}
										</FormItem>
									)}
								/>
							)}

							<FormField
								control={form.control}
								name="acceptTerms"
								render={({ field }) => (
									<FormItem className="space-y-2">
										<div className="flex items-start gap-2">
											<FormControl>
												<Checkbox
													checked={field.value}
													onCheckedChange={(
														checked,
													) =>
														field.onChange(
															checked === true,
														)
													}
												/>
											</FormControl>
											<FormLabel className="font-normal text-sm leading-5">
												{t(
													"auth.signup.acceptTermsPrefix",
												)}{" "}
												<Link
													href="/legal/terms"
													target="_blank"
													rel="noreferrer"
													className="underline"
												>
													{t(
														"auth.signup.termsOfService",
													)}
												</Link>{" "}
												{t("auth.signup.and")}{" "}
												<Link
													href="/legal/privacy-policy"
													target="_blank"
													rel="noreferrer"
													className="underline"
												>
													{t(
														"auth.signup.privacyPolicy",
													)}
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
								loading={form.formState.isSubmitting}
								disabled={
									!acceptTerms ||
									isFormIncomplete ||
									hasEmailError ||
									(isCaptchaRequired && !captchaToken)
								}
							>
								{t("auth.signup.submit")}
							</Button>
						</form>
					</Form>

					{config.auth.enableSignup &&
						config.auth.enableSocialLogin && (
							<>
								<div className="relative my-6 h-4">
									<hr className="relative top-2" />
									<p className="-translate-x-1/2 absolute top-0 left-1/2 mx-auto inline-block h-4 bg-card px-2 text-center font-medium text-foreground/60 text-sm leading-tight">
										{t("auth.login.continueWith")}
									</p>
								</div>

								<div className="grid grid-cols-1 items-stretch gap-2 sm:grid-cols-2">
									{Object.keys(oAuthProviders).map(
										(providerId) => (
											<SocialSigninButton
												key={providerId}
												provider={
													providerId as OAuthProvider
												}
												disabled={!acceptTerms}
											/>
										),
									)}
								</div>
							</>
						)}
				</>
			)}

			<div className="mt-6 text-center text-sm">
				<span className="text-foreground/60">
					{t("auth.signup.alreadyHaveAccount")}{" "}
				</span>
				<Link
					href={withQuery("/auth/login", forwardedParams)}
					prefetch={false}
				>
					{t("auth.signup.signIn")}
					<ArrowRightIcon className="ml-1 inline size-4 align-middle" />
				</Link>
			</div>
		</div>
	);
}
