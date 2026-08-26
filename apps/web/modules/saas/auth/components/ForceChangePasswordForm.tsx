"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { authClient } from "@repo/auth/client";
import { PasswordSuggestions } from "@saas/auth/components/PasswordSuggestions";
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
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

export function ForceChangePasswordForm() {
	const t = useTranslations("changePassword");
	const [passwordSuggestions, setPasswordSuggestions] = useState<
		string[] | null
	>(null);

	const formSchema = z
		.object({
			currentPassword: z.string().min(1),
			newPassword: z.string().min(12, t("notifications.minLength")),
			confirmPassword: z.string().min(1),
		})
		.refine((data) => data.newPassword === data.confirmPassword, {
			message: t("notifications.mismatch"),
			path: ["confirmPassword"],
		});

	type FormValues = z.infer<typeof formSchema>;

	const form = useForm<FormValues>({
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		resolver: zodResolver(formSchema as any),
		mode: "onBlur",
		reValidateMode: "onBlur",
		defaultValues: {
			currentPassword: "",
			newPassword: "",
			confirmPassword: "",
		},
	});

	const onSubmit = form.handleSubmit(async (values) => {
		const { error } = await authClient.changePassword({
			currentPassword: values.currentPassword,
			newPassword: values.newPassword,
			revokeOtherSessions: true,
		});

		if (error) {
			const body =
				error && typeof error === "object" && "body" in error
					? // eslint-disable-next-line @typescript-eslint/no-explicit-any
						(error as any).body
					: undefined;
			const bodyCode = body?.code as string | undefined;
			if (bodyCode === "PASSWORD_TOO_WEAK") {
				setPasswordSuggestions(body?.suggestions ?? []);
				form.setError("newPassword", {
					message: body?.message ?? "Password is too weak.",
				});
			} else {
				setPasswordSuggestions(null);
				const serverMessage =
					(body?.message as string | undefined) ??
					(error as { message?: string } | undefined)?.message;
				form.setError("newPassword", {
					message: serverMessage ?? t("notifications.error"),
				});
				toast.error(serverMessage ?? t("notifications.error"));
			}
			return;
		}

		setPasswordSuggestions(null);
		toast.success(t("notifications.success"));
		await authClient.signOut();
		window.location.href = "/auth/login";
	});

	const onLogout = async () => {
		await authClient.signOut();
		window.location.href = "/auth/login";
	};

	return (
		<div>
			<div className="mb-6 text-center">
				<h1 className="font-serif text-2xl">{t("title")}</h1>
				<p className="mt-2 text-sm text-muted-foreground">
					{t("subtitle")}
				</p>
			</div>

			<Form {...form}>
				<form onSubmit={onSubmit}>
					<div className="grid grid-cols-1 gap-4">
						<FormField
							control={form.control}
							name="currentPassword"
							render={({ field }) => (
								<FormItem>
									<FormLabel>
										{t("currentPassword")}
									</FormLabel>
									<FormControl>
										<PasswordInput
											autoComplete="current-password"
											{...field}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="newPassword"
							render={({ field }) => (
								<FormItem>
									<FormLabel>{t("newPassword")}</FormLabel>
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

						<FormField
							control={form.control}
							name="confirmPassword"
							render={({ field }) => (
								<FormItem>
									<FormLabel>
										{t("confirmPassword")}
									</FormLabel>
									<FormControl>
										<PasswordInput
											autoComplete="new-password"
											{...field}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>

						<Button
							className="w-full"
							type="submit"
							loading={form.formState.isSubmitting}
							disabled={
								!form.watch("currentPassword").trim() ||
								!form.watch("newPassword").trim() ||
								!form.watch("confirmPassword").trim()
							}
						>
							{t("submit")}
						</Button>
					</div>
				</form>
			</Form>

			<div className="mt-4 text-center">
				<button
					type="button"
					onClick={onLogout}
					className="text-sm text-muted-foreground underline transition-colors hover:text-foreground"
				>
					{t("logout")}
				</button>
			</div>
		</div>
	);
}
