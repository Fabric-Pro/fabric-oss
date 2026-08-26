"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { authClient } from "@repo/auth/client";
import { config } from "@repo/config";
import { useAuthErrorMessages } from "@saas/auth/hooks/errors-messages";
import { useSession } from "@saas/auth/hooks/use-session";
import { useRouter } from "@shared/hooks/router";
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
import { PasswordInput } from "@ui/components/password-input";
import {
	AlertTriangleIcon,
	ArrowLeftIcon,
	ClockIcon,
	MailboxIcon,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";
import * as z from "zod";
import { PasswordSuggestions } from "./PasswordSuggestions";

const formSchema = z.object({
	password: z.string().min(12, "Password must be at least 12 characters"),
});

type FormValues = z.infer<typeof formSchema>;

export function ResetPasswordForm() {
	const t = useTranslations();
	const { user } = useSession();
	const router = useRouter();
	const { getAuthErrorMessage } = useAuthErrorMessages();
	const searchParams = useSearchParams();
	const token = searchParams.get("token");
	const error = searchParams.get("error");
	const [passwordSuggestions, setPasswordSuggestions] = useState<
		string[] | null
	>(null);

	const form = useForm<FormValues>({
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		resolver: zodResolver(formSchema as any),
		defaultValues: {
			password: "",
		},
	});

	const onSubmit = form.handleSubmit(async ({ password }) => {
		try {
			const { error } = await authClient.resetPassword({
				token: token ?? undefined,
				newPassword: password,
			});

			if (error) {
				throw error;
			}

			if (user) {
				router.push(config.auth.redirectAfterSignIn);
			}
		} catch (e) {
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
					message: getAuthErrorMessage(
						bodyCode ??
							(e && typeof e === "object" && "code" in e
								? (e.code as string)
								: undefined),
					),
				});
			}
		}
	});

	if (error && !token) {
		return (
			<>
				<h1 className="font-bold text-xl md:text-2xl">
					{t("auth.resetPassword.title")}
				</h1>
				<p className="mt-1 mb-6 text-foreground/60">
					{t("auth.resetPassword.message")}{" "}
				</p>

				<Alert variant="error">
					<ClockIcon />
					<AlertTitle>
						{t("auth.resetPassword.hints.linkExpired.title")}
					</AlertTitle>
					<AlertDescription>
						{t("auth.resetPassword.hints.linkExpired.message")}
					</AlertDescription>
				</Alert>

				<div className="mt-4">
					<Button asChild className="w-full">
						<Link href="/auth/forgot-password">
							{t(
								"auth.resetPassword.hints.linkExpired.requestNewLink",
							)}
						</Link>
					</Button>
				</div>

				<div className="mt-6 text-center text-sm">
					<Link href="/auth/login">
						<ArrowLeftIcon className="mr-1 inline size-4 align-middle" />
						{t("auth.resetPassword.backToSignin")}
					</Link>
				</div>
			</>
		);
	}

	return (
		<>
			<h1 className="font-bold text-xl md:text-2xl">
				{t("auth.resetPassword.title")}
			</h1>
			<p className="mt-1 mb-6 text-foreground/60">
				{t("auth.resetPassword.message")}{" "}
			</p>

			{form.formState.isSubmitSuccessful ? (
				<Alert variant="success">
					<MailboxIcon />
					<AlertTitle>
						{t("auth.resetPassword.hints.success")}
					</AlertTitle>
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
							name="password"
							render={({ field }) => (
								<FormItem>
									<FormLabel>
										{t("auth.resetPassword.newPassword")}
									</FormLabel>
									<FormControl>
										<PasswordInput
											autoComplete="new-password"
											{...field}
										/>
									</FormControl>
									<FormMessage />
									{passwordSuggestions &&
										passwordSuggestions.length > 0 && (
											<PasswordSuggestions
												suggestions={
													passwordSuggestions
												}
											/>
										)}
								</FormItem>
							)}
						/>

						<Button loading={form.formState.isSubmitting}>
							{t("auth.resetPassword.submit")}
						</Button>
					</form>
				</Form>
			)}

			<div className="mt-6 text-center text-sm">
				<Link href="/auth/login">
					<ArrowLeftIcon className="mr-1 inline size-4 align-middle" />
					{t("auth.resetPassword.backToSignin")}
				</Link>
			</div>
		</>
	);
}
