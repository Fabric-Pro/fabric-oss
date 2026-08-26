"use client";
import { authClient } from "@repo/auth/client";
import { useAuthErrorMessages } from "@saas/auth/hooks/errors-messages";
import { useSession } from "@saas/auth/hooks/use-session";
import { useUserAccountsQuery } from "@saas/auth/lib/api";
import { SettingsItem } from "@saas/shared/components/SettingsItem";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
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
import {
	ArrowRightIcon,
	CheckIcon,
	ShieldCheckIcon,
	TabletSmartphoneIcon,
	XIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import QRCode from "react-qr-code";
import { toast } from "sonner";
import { BackupCodesDisplay } from "./BackupCodesDisplay";
import { BackupCodesPanel } from "./BackupCodesPanel";

export function TwoFactorBlock() {
	const t = useTranslations();
	const { user, reloadSession } = useSession();
	const { getAuthErrorMessage } = useAuthErrorMessages();
	const queryClient = useQueryClient();

	// The code can arrive top-level or under body.code depending on the flow,
	// so check both, like LoginForm/SignupForm do.
	const getErrorCode = (error: unknown) => {
		const e = error as {
			code?: string;
			body?: { code?: string };
		} | null;
		return e?.code ?? e?.body?.code;
	};

	// Two codes carry a reason the generic "wrong password / wrong code" toast
	// would actively mislead the user about:
	//  - ACCOUNT_TEMPORARILY_LOCKED (#2819) — telling a locked-out user to keep
	//    trying is the opposite of what they should do;
	//  - STEP_UP_REQUIRED (#2827) — the server refused because the verification
	//    that authorized this change has expired or was already spent, so the
	//    fix is to verify again rather than to re-check the password.
	const MAPPED_ERROR_CODES = [
		"ACCOUNT_TEMPORARILY_LOCKED",
		"STEP_UP_REQUIRED",
	];
	const isMappedError = (error: unknown) =>
		MAPPED_ERROR_CODES.includes(getErrorCode(error) ?? "");

	const [dialogOpen, setDialogOpen] = useState(false);
	const [dialogView, setDialogView] = useState<
		"password" | "totp-url" | "backup-codes"
	>("password");
	const [totpURI, setTotpURI] = useState("");
	const [password, setPassword] = useState("");
	const [totpCode, setTotpCode] = useState("");
	const [backupCodes, setBackupCodes] = useState<string[]>([]);
	const [backupCodesSaved, setBackupCodesSaved] = useState(false);

	const { data: accounts } = useUserAccountsQuery();

	useEffect(() => {
		// Drop password + plaintext backup codes from React state on dismiss
		// so they don't linger in memory after the dialog closes.
		if (!dialogOpen) {
			setPassword("");
			setTotpCode("");
			setBackupCodes([]);
			setBackupCodesSaved(false);
		}
	}, [dialogOpen]);

	const totpURISecret = useMemo(() => {
		if (!totpURI) {
			return null;
		}

		const url = new URL(totpURI);
		return url.searchParams.get("secret") || null;
	}, [totpURI]);

	const verifyPassword = async () => {
		setDialogView("password");
		setDialogOpen(true);
	};

	const enableTwoFactorMutation = useMutation({
		mutationKey: ["enableTwoFactor"],
		mutationFn: async () => {
			const { data, error } = await authClient.twoFactor.enable({
				password,
			});

			if (error) {
				throw error;
			}

			const fresh = data.backupCodes ?? [];
			setTotpURI(data.totpURI);
			setBackupCodes(fresh);
			setDialogView("totp-url");
			queryClient.setQueryData(["backupCodesStatus"], {
				remaining: fresh.length,
				total: 10,
			});
		},

		onError: () => {
			toast.error(
				t(
					"settings.account.security.twoFactor.notifications.enable.error.title",
				),
			);
		},
	});

	const disableTwoFactorMutation = useMutation({
		mutationKey: ["disableTwoFactor"],
		mutationFn: async () => {
			// Verify first: the server now REQUIRES it (#2827). A successful
			// verification mints a single-use, five-minute step-up grant, and
			// /two-factor/disable refuses without one — so this is the flow
			// that satisfies the gate, not merely client-side sequencing.
			// Better Auth formats backup codes as "xxxxx-xxxxx" (hyphenated);
			// TOTPs are pure digits, so we route on format rather than asking
			// the user to pick.
			const isBackupCode = totpCode.includes("-");
			const { error: verifyError } = isBackupCode
				? await authClient.twoFactor.verifyBackupCode({
						code: totpCode,
						disableSession: true,
					})
				: await authClient.twoFactor.verifyTotp({
						code: totpCode,
					});

			if (verifyError) {
				throw verifyError;
			}

			const { error } = await authClient.twoFactor.disable({
				password,
			});

			if (error) {
				throw error;
			}

			setDialogOpen(false);

			toast.success(
				t(
					"settings.account.security.twoFactor.notifications.disable.success.title",
				),
			);

			reloadSession();
		},

		onError: (error) => {
			toast.error(
				isMappedError(error)
					? getAuthErrorMessage(getErrorCode(error))
					: t(
							"settings.account.security.twoFactor.notifications.enable.error.title",
						),
			);
		},
	});

	const verifyTwoFactorMutation = useMutation({
		mutationKey: ["verifyTwoFactor"],
		mutationFn: async () => {
			const { error } = await authClient.twoFactor.verifyTotp({
				code: totpCode,
			});

			if (error) {
				throw error;
			}

			// Reload session so twoFactorEnabled is updated in the UI while the
			// user is still on the backup-codes step.
			reloadSession();
			setBackupCodesSaved(false);
			setDialogView("backup-codes");
		},

		onError: (error) => {
			if (isMappedError(error)) {
				toast.error(getAuthErrorMessage(getErrorCode(error)));
			}
		},
	});

	const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();

		if (user?.twoFactorEnabled) {
			disableTwoFactorMutation.mutate();
			return;
		}

		if (dialogView === "password") {
			enableTwoFactorMutation.mutate();
			return;
		}

		verifyTwoFactorMutation.mutate();
	};

	if (!accounts?.some((account) => account.providerId === "credential")) {
		return null;
	}

	return (
		<SettingsItem
			title={t("settings.account.security.twoFactor.title")}
			description={t("settings.account.security.twoFactor.description")}
		>
			{user?.twoFactorEnabled ? (
				<div className="flex items-start flex-col gap-4">
					<div className="flex items-center gap-1.5">
						<ShieldCheckIcon className="size-6 text-success" />
						<p className="text-sm text-foreground">
							{t("settings.account.security.twoFactor.enabled")}
						</p>
					</div>
					<Button variant="light" onClick={verifyPassword}>
						<XIcon className="mr-1.5 size-4" />
						{t("settings.account.security.twoFactor.disable")}
					</Button>
					<BackupCodesPanel
						twoFactorEnabled={!!user?.twoFactorEnabled}
					/>
				</div>
			) : (
				<div className="flex justify-start">
					<Button variant="light" onClick={verifyPassword}>
						<TabletSmartphoneIcon className="mr-1.5 size-4" />
						{t("settings.account.security.twoFactor.enable")}
					</Button>
				</div>
			)}

			<Dialog
				open={dialogOpen}
				onOpenChange={(open) => {
					// Block Escape / backdrop dismiss in the backup-codes view
					// until the user confirms saving — otherwise they can lose
					// the codes forever.
					if (
						!open &&
						dialogView === "backup-codes" &&
						!backupCodesSaved
					) {
						return;
					}
					setDialogOpen(open);
				}}
			>
				<DialogContent hideCloseButton={dialogView === "backup-codes"}>
					<DialogHeader>
						<DialogTitle>
							{dialogView === "password"
								? t(
										"settings.account.security.twoFactor.dialog.password.title",
									)
								: dialogView === "totp-url"
									? t(
											"settings.account.security.twoFactor.dialog.totpUrl.title",
										)
									: t(
											"settings.account.security.twoFactor.backupCodes.saveDialog.title",
										)}
						</DialogTitle>
					</DialogHeader>

					{dialogView === "password" ? (
						<form onSubmit={handleSubmit}>
							<div className="grid grid-cols-1 gap-4">
								<p className="text-sm text-foreground/60">
									{t(
										"settings.account.security.twoFactor.dialog.password.description",
									)}
								</p>

								<FormItem>
									<Label className="block">
										{t(
											"settings.account.security.twoFactor.dialog.password.label",
										)}
									</Label>
									<PasswordInput
										value={password}
										onChange={(value) => setPassword(value)}
									/>
								</FormItem>

								{user?.twoFactorEnabled && (
									<FormItem>
										<Label className="block">
											{t(
												"settings.account.security.twoFactor.dialog.totpUrl.code",
											)}
										</Label>
										<Input
											value={totpCode}
											autoComplete="one-time-code"
											onChange={(e) =>
												setTotpCode(e.target.value)
											}
										/>
									</FormItem>
								)}
							</div>
							<div className="mt-4">
								<Button
									type="submit"
									variant="secondary"
									className="w-full"
									loading={
										enableTwoFactorMutation.isPending ||
										disableTwoFactorMutation.isPending
									}
									disabled={
										password.trim().length === 0 ||
										(!!user?.twoFactorEnabled &&
											totpCode.trim().length === 0)
									}
								>
									{t("common.actions.continue")}
									<ArrowRightIcon className="ml-1.5 size-4" />
								</Button>
							</div>
						</form>
					) : dialogView === "totp-url" ? (
						<form onSubmit={handleSubmit}>
							<div className="grid grid-cols-1 gap-4">
								<p className="text-sm text-foreground/60">
									{t(
										"settings.account.security.twoFactor.dialog.totpUrl.description",
									)}
								</p>
								<Card className="flex flex-col items-center gap-4 p-6">
									<QRCode title={totpURI} value={totpURI} />

									{totpURISecret && (
										<p className="text-xs text-muted-foreground text-center">
											{totpURISecret}
										</p>
									)}
								</Card>

								<hr />

								<div className="grid grid-cols-1 gap-4">
									<FormItem>
										<Label className="block">
											{t(
												"settings.account.security.twoFactor.dialog.totpUrl.code",
											)}
										</Label>
										<Input
											value={totpCode}
											onChange={(e) =>
												setTotpCode(e.target.value)
											}
										/>
									</FormItem>
								</div>
							</div>
							<div className="mt-4">
								<Button
									type="submit"
									variant="secondary"
									className="w-full"
									loading={verifyTwoFactorMutation.isPending}
								>
									<CheckIcon className="mr-1.5 size-4" />
									{t("common.actions.verify")}
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
								codes={backupCodes}
								saved={backupCodesSaved}
								onSavedChange={setBackupCodesSaved}
							/>

							<Button
								type="button"
								variant="secondary"
								className="w-full"
								disabled={!backupCodesSaved}
								onClick={() => {
									setDialogOpen(false);
									toast.success(
										t(
											"settings.account.security.twoFactor.notifications.verify.success.title",
										),
									);
								}}
							>
								{t(
									"settings.account.security.twoFactor.backupCodes.saveDialog.done",
								)}
							</Button>
						</div>
					)}
				</DialogContent>
			</Dialog>
		</SettingsItem>
	);
}
