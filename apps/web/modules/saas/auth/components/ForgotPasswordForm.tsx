"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { authClient } from "@repo/auth/client";
import { config } from "@repo/config";
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
import { AlertTriangleIcon, ArrowLeftIcon, MailboxIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";
import * as z from "zod";
import { TurnstileWidget } from "./TurnstileWidget";

const formSchema = z.object({
	email: z.string().email(),
});

type FormValues = z.infer<typeof formSchema>;

export function ForgotPasswordForm() {
	const t = useTranslations();
	const form = useForm<FormValues>({
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		resolver: zodResolver(formSchema as any),
		mode: "onBlur",
		reValidateMode: "onBlur",
		defaultValues: {
			email: "",
		},
	});
	const [captchaToken, setCaptchaToken] = useState<string | null>(null);
	const [captchaResetKey, setCaptchaResetKey] = useState(0);
	const emailValue = form.watch("email");
	const hasEmailError = Boolean(form.formState.errors.email);
	const isCaptchaRequired =
		config.auth.captcha.enabled && Boolean(config.auth.captcha.siteKey);
	const isSubmitDisabled =
		emailValue.trim().length === 0 ||
		hasEmailError ||
		(isCaptchaRequired && !captchaToken);

	const onSubmit = form.handleSubmit(async ({ email }) => {
		try {
			const redirectTo = new URL(
				"/auth/reset-password",
				window.location.origin,
			).toString();

			const { error } = await authClient.requestPasswordReset({
				email,
				redirectTo,
				captchaToken: captchaToken ?? undefined,
			} as any);

			if (error) {
				setCaptchaToken(null);
				setCaptchaResetKey((k) => k + 1);
				if (process.env.NODE_ENV === "development") {
					console.warn(
						"[auth] Forgot password error code:",
						error.code,
					);
				}
			}
		} catch (e) {
			setCaptchaToken(null);
			setCaptchaResetKey((k) => k + 1);
			const code =
				e && typeof e === "object" && "code" in e
					? (e.code as string)
					: undefined;
			if (process.env.NODE_ENV === "development") {
				console.warn("[auth] Forgot password error code:", code);
			}
		}
		// Always show success -- form.formState.isSubmitSuccessful will be true
		// because no error was thrown or set via form.setError
	});

	return (
		<>
			<h1 className="font-bold text-xl md:text-2xl">
				{t("auth.forgotPassword.title")}
			</h1>
			<p className="mt-1 mb-6 text-foreground/60">
				{t("auth.forgotPassword.message")}{" "}
			</p>

			{form.formState.isSubmitSuccessful ? (
				<Alert variant="success">
					<MailboxIcon />
					<AlertTitle>
						{t("auth.forgotPassword.hints.linkSent.title")}
					</AlertTitle>
					<AlertDescription>
						{t("auth.forgotPassword.hints.linkSent.message")}
					</AlertDescription>
				</Alert>
			) : (
				<Form {...form}>
					<form
						className="flex flex-col items-stretch gap-4"
						onSubmit={onSubmit}
					>
						{form.formState.errors.root && (
							<Alert variant="error">
								<AlertTriangleIcon />
								<AlertTitle>
									{form.formState.errors.root.message}
								</AlertTitle>
							</Alert>
						)}

						<FormField
							control={form.control}
							name="email"
							render={({ field }) => (
								<FormItem>
									<FormLabel>
										{t("auth.forgotPassword.email")}
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

						<TurnstileWidget
							onSuccess={setCaptchaToken}
							onError={() => setCaptchaToken(null)}
							onExpire={() => setCaptchaToken(null)}
							resetKey={captchaResetKey}
						/>

						<Button
							loading={form.formState.isSubmitting}
							disabled={isSubmitDisabled}
						>
							{t("auth.forgotPassword.submit")}
						</Button>
					</form>
				</Form>
			)}

			<div className="mt-6 text-center text-sm">
				<Link href="/auth/login">
					<ArrowLeftIcon className="mr-1 inline size-4 align-middle" />
					{t("auth.forgotPassword.backToSignin")}
				</Link>
			</div>
		</>
	);
}
