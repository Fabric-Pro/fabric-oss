"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { authClient } from "@repo/auth/client";
import { OrganizationRoleSelect } from "@saas/organizations/components/OrganizationRoleSelect";
import {
	fullOrganizationQueryKey,
	orgInvitationsQueryKey,
} from "@saas/organizations/lib/api";
import { SettingsItem } from "@saas/shared/components/SettingsItem";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
} from "@ui/components/form";
import { Input } from "@ui/components/input";
import { MailIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { SubmitHandler } from "react-hook-form";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

const formSchema = z.object({
	email: z.string().email(),
	role: z.enum(["member", "admin"]),
});

type FormValues = z.infer<typeof formSchema>;

function isDuplicateInviteError(message: string): boolean {
	return (
		message === "User is already invited to this organization" ||
		message.toLowerCase().includes("already invited") ||
		message.toLowerCase().includes("already a member") ||
		message.toLowerCase().includes("pending")
	);
}

export function InviteMemberForm({
	organizationId,
	onSwitchToPendingTab,
}: {
	organizationId: string;
	onSwitchToPendingTab?: () => void;
}) {
	const t = useTranslations();
	const queryClient = useQueryClient();
	const [isDuplicateInvite, setIsDuplicateInvite] = useState(false);
	const [isResending, setIsResending] = useState(false);

	const form = useForm<FormValues>({
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		resolver: zodResolver(formSchema as any),
		defaultValues: {
			email: "",
			role: "member",
		},
	});

	const onResend = async () => {
		setIsResending(true);
		try {
			const values = form.getValues();
			const { error } = await authClient.organization.inviteMember({
				...values,
				organizationId,
				resend: true,
			});
			if (error) {
				throw error;
			}

			setIsDuplicateInvite(false);
			form.reset();

			queryClient.invalidateQueries({
				queryKey: orgInvitationsQueryKey(organizationId),
			});

			toast.success(
				t(
					"organizations.settings.members.inviteMember.duplicateInvite.resendSuccess",
				),
			);
		} catch {
			toast.error(
				t(
					"organizations.settings.members.inviteMember.duplicateInvite.resendError",
				),
			);
		} finally {
			setIsResending(false);
		}
	};

	const onSubmit: SubmitHandler<FormValues> = async (values) => {
		setIsDuplicateInvite(false);
		try {
			const { error } = await authClient.organization.inviteMember({
				...values,
				organizationId,
			});

			if (error) {
				throw error;
			}

			form.reset();

			queryClient.invalidateQueries({
				queryKey: fullOrganizationQueryKey(organizationId),
			});
			queryClient.invalidateQueries({
				queryKey: orgInvitationsQueryKey(organizationId),
			});

			toast.success(
				t(
					"organizations.settings.members.inviteMember.notifications.success.title",
				),
			);
		} catch (err) {
			const message = (err as { message?: string })?.message ?? "";
			if (isDuplicateInviteError(message)) {
				setIsDuplicateInvite(true);
			} else {
				toast.error(
					t(
						"organizations.settings.members.inviteMember.notifications.error.title",
					),
				);
			}
		}
	};

	return (
		<SettingsItem
			title={t("organizations.settings.members.inviteMember.title")}
			description={t(
				"organizations.settings.members.inviteMember.description",
			)}
		>
			<Form {...form}>
				<form
					onSubmit={form.handleSubmit(onSubmit)}
					className="@container"
				>
					<div className="flex @md:flex-row flex-col gap-2">
						<div className="flex-1">
							<FormField
								control={form.control}
								name="email"
								render={({ field }) => (
									<FormItem>
										<FormLabel>
											{t(
												"organizations.settings.members.inviteMember.email",
											)}
										</FormLabel>
										<FormControl>
											<Input
												type="email"
												{...field}
												onChange={(e) => {
													field.onChange(e);
													if (isDuplicateInvite) {
														setIsDuplicateInvite(
															false,
														);
													}
												}}
											/>
										</FormControl>
									</FormItem>
								)}
							/>
						</div>

						<div>
							<FormField
								control={form.control}
								name="role"
								render={({ field }) => (
									<FormItem>
										<FormLabel>
											{t(
												"organizations.settings.members.inviteMember.role",
											)}
										</FormLabel>
										<FormControl>
											<OrganizationRoleSelect
												value={field.value}
												onSelect={field.onChange}
												excludeRoles={["owner"]}
											/>
										</FormControl>
									</FormItem>
								)}
							/>
						</div>
					</div>

					{isDuplicateInvite && (
						<div className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
							<p className="text-foreground">
								{t(
									"organizations.settings.members.inviteMember.duplicateInvite.message",
								)}
							</p>
							<div className="mt-2 flex gap-2">
								<Button
									type="button"
									variant="outline"
									size="sm"
									loading={isResending}
									onClick={onResend}
								>
									<MailIcon className="mr-1.5 size-3.5" />
									{t(
										"organizations.settings.members.inviteMember.duplicateInvite.resend",
									)}
								</Button>
								{onSwitchToPendingTab && (
									<Button
										type="button"
										variant="ghost"
										size="sm"
										onClick={onSwitchToPendingTab}
									>
										{t(
											"organizations.settings.members.inviteMember.duplicateInvite.viewPending",
										)}
									</Button>
								)}
							</div>
						</div>
					)}

					<div className="mt-4 flex justify-end">
						<Button
							type="submit"
							loading={form.formState.isSubmitting}
						>
							{t(
								"organizations.settings.members.inviteMember.submit",
							)}
						</Button>
					</div>
				</form>
			</Form>
		</SettingsItem>
	);
}
