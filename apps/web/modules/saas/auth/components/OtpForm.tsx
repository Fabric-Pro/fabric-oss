"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { authClient } from "@repo/auth/client";
import { config } from "@repo/config";
import { useAuthErrorMessages } from "@saas/auth/hooks/errors-messages";
import { safeRelativePath } from "@shared/lib/safe-redirect";
import { useRouter } from "@shared/hooks/router";
import { Alert, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@ui/components/form";
import {
	InputOTP,
	InputOTPGroup,
	InputOTPSeparator,
	InputOTPSlot,
} from "@ui/components/input-otp";
import { AlertTriangleIcon, ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useForm } from "react-hook-form";
import * as z from "zod";

const formSchema = z.object({
	code: z.string().min(6).max(6),
});

type FormValues = z.infer<typeof formSchema>;

export function OtpForm() {
	const t = useTranslations();
	const router = useRouter();
	const { getAuthErrorMessage } = useAuthErrorMessages();
	const searchParams = useSearchParams();

	const invitationId = searchParams.get("invitationId");
	// The 2FA challenge that lands users here carries the original post-login
	// destination in `redirectTo`. The server sanitizes it to a relative path
	// before writing the param (packages/auth/lib/two-factor-gate.ts), but this
	// value reaches the component straight off the URL bar, so it is validated
	// again here — the same check every other redirect hop applies — rather
	// than trusting where it came from.
	const redirectTo = safeRelativePath(searchParams.get("redirectTo"));

	const redirectPath = invitationId
		? `/organization-invitation/${invitationId}`
		: (redirectTo ?? config.auth.redirectAfterSignIn);

	const form = useForm<FormValues>({
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		resolver: zodResolver(formSchema as any),
		defaultValues: {
			code: "",
		},
	});

	const onSubmit = form.handleSubmit(async ({ code }) => {
		try {
			const { error } = await authClient.twoFactor.verifyTotp({
				code,
			});

			if (error) {
				throw error;
			}

			router.replace(redirectPath);
		} catch (e) {
			form.setError("root", {
				message: getAuthErrorMessage(
					e && typeof e === "object" && "code" in e
						? (e.code as string)
						: undefined,
				),
			});
		}
	});

	return (
		<>
			<h1 className="font-bold text-xl md:text-2xl">
				{t("auth.verify.title")}
			</h1>
			<p className="mt-1 mb-4 text-foreground/60">
				{t("auth.verify.message")}
			</p>

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
						name="code"
						render={({ field }) => (
							<FormItem>
								<FormLabel>{t("auth.verify.code")}</FormLabel>
								<FormControl>
									<InputOTP
										maxLength={6}
										{...field}
										autoComplete="one-time-code"
										onChange={(value) => {
											field.onChange(value);
											onSubmit();
										}}
									>
										<InputOTPGroup>
											<InputOTPSlot
												className="size-10 text-lg"
												index={0}
											/>
											<InputOTPSlot
												className="size-10 text-lg"
												index={1}
											/>
											<InputOTPSlot
												className="size-10 text-lg"
												index={2}
											/>
										</InputOTPGroup>
										<InputOTPSeparator className="opacity-40" />
										<InputOTPGroup>
											<InputOTPSlot
												className="size-10 text-lg"
												index={3}
											/>
											<InputOTPSlot
												className="size-10 text-lg"
												index={4}
											/>
											<InputOTPSlot
												className="size-10 text-lg"
												index={5}
											/>
										</InputOTPGroup>
									</InputOTP>
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>

					<Button loading={form.formState.isSubmitting}>
						{t("auth.verify.submit")}
					</Button>
				</form>
			</Form>

			<div className="mt-6 text-center text-sm">
				<Link href="/auth/login">
					<ArrowLeftIcon className="mr-1 inline size-4 align-middle" />
					{t("auth.verify.backToSignin")}
				</Link>
			</div>
		</>
	);
}
