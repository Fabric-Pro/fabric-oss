"use client";

import { authClient } from "@repo/auth/client";
import { useUserAccountsQuery } from "@saas/auth/lib/api";
import { SettingsItem } from "@saas/shared/components/SettingsItem";
import { useMutation } from "@tanstack/react-query";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@ui/components/alert-dialog";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";

export function DeleteAccountForm() {
	const t = useTranslations();
	const [open, setOpen] = useState(false);
	const [password, setPassword] = useState("");
	const [passwordError, setPasswordError] = useState<string | null>(null);

	const { data: accounts, isLoading: isAccountsLoading } =
		useUserAccountsQuery();
	const hasCredentialAccount = accounts?.some(
		(account) => account.providerId === "credential",
	);

	const deleteUserMutation = useMutation({
		mutationFn: async (passwordValue: string | undefined) => {
			const { error } = await authClient.deleteUser({
				...(passwordValue ? { password: passwordValue } : {}),
			});

			if (error) {
				throw error;
			}
		},
		onSuccess: () => {
			window.location.href = "/auth/login";
		},
		onError: (error) => {
			const errorCode = (error as { code?: string })?.code;
			if (errorCode === "INVALID_PASSWORD") {
				setPasswordError(
					t(
						"settings.account.deleteAccount.passwordField.invalidPassword",
					),
				);
			} else {
				toast.error(
					t("settings.account.deleteAccount.notifications.error"),
				);
			}
		},
	});

	const handleOpenChange = (nextOpen: boolean) => {
		setOpen(nextOpen);
		if (!nextOpen) {
			setPassword("");
			setPasswordError(null);
		}
	};

	const handleConfirm = async (e: React.MouseEvent) => {
		e.preventDefault();
		setPasswordError(null);
		try {
			await deleteUserMutation.mutateAsync(
				hasCredentialAccount ? password : undefined,
			);
		} catch {
			// Error is already handled by the mutation's onError callback.
			// Catch here to prevent unhandled promise rejection from the onClick handler.
		}
	};

	const isConfirmDisabled =
		isAccountsLoading ||
		(hasCredentialAccount && password.length === 0) ||
		deleteUserMutation.isPending;

	return (
		<SettingsItem
			danger
			title={t("settings.account.deleteAccount.title")}
			description={t("settings.account.deleteAccount.description")}
		>
			<div className="mt-4 flex justify-end">
				<AlertDialog open={open} onOpenChange={handleOpenChange}>
					<AlertDialogTrigger asChild>
						<Button variant="error">
							{t("settings.account.deleteAccount.submit")}
						</Button>
					</AlertDialogTrigger>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>
								{t("settings.account.deleteAccount.title")}
							</AlertDialogTitle>
							<AlertDialogDescription>
								{t(
									"settings.account.deleteAccount.confirmation",
								)}
							</AlertDialogDescription>
						</AlertDialogHeader>

						{hasCredentialAccount && (
							<div className="grid gap-2 py-2">
								<Label htmlFor="delete-account-password">
									{t(
										"settings.account.deleteAccount.passwordField.label",
									)}
								</Label>
								<Input
									id="delete-account-password"
									type="password"
									autoComplete="current-password"
									placeholder={t(
										"settings.account.deleteAccount.passwordField.placeholder",
									)}
									value={password}
									onChange={(e) => {
										setPassword(e.target.value);
										if (passwordError) {
											setPasswordError(null);
										}
									}}
									aria-invalid={!!passwordError}
									aria-describedby={
										passwordError
											? "delete-password-error"
											: undefined
									}
								/>
								{passwordError && (
									<p
										id="delete-password-error"
										className="text-sm text-destructive"
									>
										{passwordError}
									</p>
								)}
							</div>
						)}

						<AlertDialogFooter>
							<AlertDialogCancel>
								{t("common.confirmation.cancel")}
							</AlertDialogCancel>
							<AlertDialogAction
								disabled={isConfirmDisabled}
								variant="destructive"
								onClick={handleConfirm}
							>
								{deleteUserMutation.isPending
									? "..."
									: t(
											"settings.account.deleteAccount.submit",
										)}
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</div>
		</SettingsItem>
	);
}
