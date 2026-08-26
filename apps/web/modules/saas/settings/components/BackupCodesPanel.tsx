"use client";

import { authClient } from "@repo/auth/client";
import { useAuthErrorMessages } from "@saas/auth/hooks/errors-messages";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { FormItem } from "@ui/components/form";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { PasswordInput } from "@ui/components/password-input";
import { RefreshCwIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { BackupCodesDisplay } from "./BackupCodesDisplay";

interface BackupCodesPanelProps {
	twoFactorEnabled: boolean;
}

export function BackupCodesPanel({ twoFactorEnabled }: BackupCodesPanelProps) {
	const t = useTranslations();
	const queryClient = useQueryClient();
	const { getAuthErrorMessage } = useAuthErrorMessages();

	const [dialogOpen, setDialogOpen] = useState(false);
	const [dialogView, setDialogView] = useState<"password" | "codes">(
		"password",
	);
	const [password, setPassword] = useState("");
	const [verificationCode, setVerificationCode] = useState("");
	const [newCodes, setNewCodes] = useState<string[]>([]);
	const [codesSaved, setCodesSaved] = useState(false);

	// Drop password + code + plaintext codes from React state on dismiss so
	// they don't linger in memory after the dialog closes.
	useEffect(() => {
		if (!dialogOpen) {
			setPassword("");
			setVerificationCode("");
			setNewCodes([]);
			setCodesSaved(false);
		}
	}, [dialogOpen]);

	const {
		data: status,
		isError: statusIsError,
		isLoading: statusIsLoading,
	} = useQuery({
		queryKey: ["backupCodesStatus"],
		queryFn: () => orpcClient.auth.getBackupCodesStatus({}),
		enabled: twoFactorEnabled,
	});

	const regenerateMutation = useMutation({
		mutationFn: async () => {
			// Verify the second factor first: regenerating invalidates every
			// existing backup code, so a stolen session plus a phished password
			// could otherwise both lock the real owner out and hand the attacker
			// ten fresh single-use credentials. The server enforces this (#2827)
			// — a successful verification mints the single-use step-up grant
			// that /two-factor/generate-backup-codes requires.
			//
			// Better Auth formats backup codes as "xxxxx-xxxxx" (hyphenated) and
			// TOTPs are pure digits, so the format routes the call rather than
			// asking the user to pick — the same rule as the disable dialog.
			const isBackupCode = verificationCode.includes("-");
			const { error: verifyError } = isBackupCode
				? await authClient.twoFactor.verifyBackupCode({
						code: verificationCode,
						disableSession: true,
					})
				: await authClient.twoFactor.verifyTotp({
						code: verificationCode,
					});

			if (verifyError) {
				throw verifyError;
			}

			const { data, error } =
				await authClient.twoFactor.generateBackupCodes({ password });
			if (error) {
				throw error;
			}
			return data;
		},
		onSuccess: (data) => {
			const fresh = data.backupCodes ?? [];
			setNewCodes(fresh);
			setDialogView("codes");
			queryClient.setQueryData(["backupCodesStatus"], {
				remaining: fresh.length,
				total: 10,
			});
		},
		onError: (error) => {
			// Same two codes the 2FA block surfaces verbatim: telling a
			// locked-out user to retry, or blaming the password when the step-up
			// grant expired, both send them down the wrong path.
			const code = (
				error as { code?: string; body?: { code?: string } } | null
			)?.code;
			const bodyCode = (error as { body?: { code?: string } } | null)
				?.body?.code;
			const resolved = code ?? bodyCode;
			toast.error(
				resolved === "ACCOUNT_TEMPORARILY_LOCKED" ||
					resolved === "STEP_UP_REQUIRED"
					? getAuthErrorMessage(resolved)
					: t(
							"settings.account.security.twoFactor.backupCodes.notifications.regenerate.error.title",
						),
			);
		},
	});

	const handleOpenDialog = () => {
		setNewCodes([]);
		setCodesSaved(false);
		setVerificationCode("");
		setDialogView("password");
		setDialogOpen(true);
	};

	const handleDone = () => {
		setDialogOpen(false);
		toast.success(
			t(
				"settings.account.security.twoFactor.backupCodes.notifications.regenerate.success.title",
			),
		);
	};

	if (!twoFactorEnabled) {
		return null;
	}

	const remaining = status?.remaining ?? 0;
	const total = status?.total ?? 10;

	return (
		<div className="flex flex-col gap-3 mt-4">
			<div>
				<p className="text-sm font-medium">
					{t("settings.account.security.twoFactor.backupCodes.title")}
				</p>
				{statusIsError ? (
					<p className="text-sm text-destructive">
						{t(
							"settings.account.security.twoFactor.backupCodes.statusError",
						)}
					</p>
				) : statusIsLoading ? (
					<p className="text-sm text-muted-foreground">
						{t(
							"settings.account.security.twoFactor.backupCodes.statusLoading",
						)}
					</p>
				) : (
					<p className="text-sm text-muted-foreground">
						{t(
							"settings.account.security.twoFactor.backupCodes.remaining",
							{
								remaining,
								total,
							},
						)}
					</p>
				)}
			</div>

			<Button variant="light" size="sm" onClick={handleOpenDialog}>
				<RefreshCwIcon className="mr-1.5 size-4" />
				{t(
					"settings.account.security.twoFactor.backupCodes.regenerate",
				)}
			</Button>

			<Dialog
				open={dialogOpen}
				onOpenChange={(open) => {
					// Block Escape / backdrop dismiss in the codes view until
					// the user confirms saving — otherwise they can lose the
					// codes forever.
					if (!open && dialogView === "codes" && !codesSaved) {
						return;
					}
					setDialogOpen(open);
				}}
			>
				<DialogContent hideCloseButton={dialogView === "codes"}>
					<DialogHeader>
						<DialogTitle>
							{dialogView === "password"
								? t(
										"settings.account.security.twoFactor.backupCodes.regenerateDialog.title",
									)
								: t(
										"settings.account.security.twoFactor.backupCodes.saveDialog.title",
									)}
						</DialogTitle>
					</DialogHeader>

					{dialogView === "password" ? (
						<form
							onSubmit={(e) => {
								e.preventDefault();
								regenerateMutation.mutate();
							}}
						>
							<div className="grid grid-cols-1 gap-4">
								<p className="text-sm text-foreground/60">
									{t(
										"settings.account.security.twoFactor.backupCodes.regenerateDialog.description",
									)}
								</p>

								<FormItem>
									<Label className="block">
										{t(
											"settings.account.security.twoFactor.backupCodes.regenerateDialog.passwordLabel",
										)}
									</Label>
									<PasswordInput
										value={password}
										onChange={(value) => setPassword(value)}
									/>
								</FormItem>

								<FormItem>
									<Label className="block">
										{t(
											"settings.account.security.twoFactor.backupCodes.regenerateDialog.codeLabel",
										)}
									</Label>
									<Input
										value={verificationCode}
										autoComplete="one-time-code"
										onChange={(e) =>
											setVerificationCode(e.target.value)
										}
									/>
								</FormItem>
							</div>

							<div className="mt-4">
								<Button
									type="submit"
									variant="secondary"
									className="w-full"
									loading={regenerateMutation.isPending}
									disabled={
										password.trim().length === 0 ||
										verificationCode.trim().length === 0
									}
								>
									{t(
										"settings.account.security.twoFactor.backupCodes.regenerate",
									)}
								</Button>
							</div>
						</form>
					) : (
						<div className="flex flex-col gap-4">
							<p className="text-sm text-foreground/60">
								{t(
									"settings.account.security.twoFactor.backupCodes.saveDialog.description",
								)}
							</p>

							<BackupCodesDisplay
								codes={newCodes}
								saved={codesSaved}
								onSavedChange={setCodesSaved}
							/>

							<Button
								type="button"
								variant="secondary"
								className="w-full"
								disabled={!codesSaved}
								onClick={handleDone}
							>
								{t(
									"settings.account.security.twoFactor.backupCodes.saveDialog.done",
								)}
							</Button>
						</div>
					)}
				</DialogContent>
			</Dialog>
		</div>
	);
}
