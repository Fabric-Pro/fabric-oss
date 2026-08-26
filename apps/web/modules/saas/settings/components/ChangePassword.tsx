"use client";
import { zodResolver } from "@hookform/resolvers/zod";
import { authClient } from "@repo/auth/client";
import { PasswordSuggestions } from "@saas/auth/components/PasswordSuggestions";
import { SettingsItem } from "@saas/shared/components/SettingsItem";
import { useRouter } from "@shared/hooks/router";
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

const formSchema = z.object({
	currentPassword: z.string().min(1),
	newPassword: z.string().min(12, "Password must be at least 12 characters"),
});

export function ChangePasswordForm() {
	const t = useTranslations();
	const router = useRouter();
	const [passwordSuggestions, setPasswordSuggestions] = useState<
		string[] | null
	>(null);

	const form = useForm<z.infer<typeof formSchema>>({
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		resolver: zodResolver(formSchema as any),
		defaultValues: {
			currentPassword: "",
			newPassword: "",
		},
	});

	const onSubmit = form.handleSubmit(async (values) => {
		const { error } = await authClient.changePassword({
			...values,
			revokeOtherSessions: true,
		});

		if (error) {
			const body =
				error && typeof error === "object" && "body" in error
					? (error as any).body
					: undefined;
			const bodyCode = body?.code as string | undefined;
			if (bodyCode === "PASSWORD_TOO_WEAK") {
				setPasswordSuggestions(body?.suggestions ?? []);
				form.setError("newPassword", {
					message: body?.message ?? "Password is too weak.",
				});
			} else {
				setPasswordSuggestions(null);
				toast.error(
					t(
						"settings.account.security.changePassword.notifications.error",
					),
				);
			}
			return;
		}

		setPasswordSuggestions(null);
		toast.success(
			t("settings.account.security.changePassword.notifications.success"),
		);
		form.reset({});
		router.refresh();
	});

	return (
		<SettingsItem
			title={t("settings.account.security.changePassword.title")}
		>
			<Form {...form}>
				<form onSubmit={onSubmit}>
					<div className="grid grid-cols-1 gap-4">
						<FormField
							control={form.control}
							name="currentPassword"
							render={({ field }) => (
								<FormItem>
									<FormLabel>
										{t(
											"settings.account.security.changePassword.currentPassword",
										)}
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
									<FormLabel>
										{t(
											"settings.account.security.changePassword.newPassword",
										)}
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
						<div className="flex justify-end">
							<Button
								className="w-full sm:w-auto"
								type="submit"
								loading={form.formState.isSubmitting}
								disabled={
									!(
										form.formState.isValid &&
										Object.keys(form.formState.dirtyFields)
											.length
									)
								}
							>
								{t("settings.save")}
							</Button>
						</div>
					</div>
				</form>
			</Form>
		</SettingsItem>
	);
}
