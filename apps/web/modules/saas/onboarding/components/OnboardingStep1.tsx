"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { authClient } from "@repo/auth/client";
import { useSession } from "@saas/auth/hooks/use-session";
import { useAccountOrganization } from "@saas/organizations/hooks/use-organization-context";
import { UserAvatarUpload } from "@saas/settings/components/UserAvatarUpload";
import { Button } from "@ui/components/button";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
} from "@ui/components/form";
import { Input } from "@ui/components/input";
import { ArrowRightIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import type { SubmitHandler } from "react-hook-form";
import { useForm } from "react-hook-form";
import { z } from "zod";

const formSchema = z.object({
	name: z.string(),
});

type FormValues = z.infer<typeof formSchema>;

export function OnboardingStep1({ onCompleted }: { onCompleted: () => void }) {
	const t = useTranslations();
	const { user } = useSession();
	// The organization every account now gets at signup (Fizzy #1875, FR1a).
	// Naming it here is the acceptance criterion, not decoration: an account
	// that silently gains a workspace leaves the person guessing whether they
	// made it, whether it is shared, and whether it is the thing they are
	// supposed to be in. Absent while the membership list loads — the step
	// renders without it rather than blocking on it.
	const workspace = useAccountOrganization();
	const form = useForm<FormValues>({
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		resolver: zodResolver(formSchema as any),
		defaultValues: {
			name: user?.name ?? "",
		},
	});

	useEffect(() => {
		if (user) {
			form.setValue("name", user.name ?? "");
		}
	}, [user]);

	const onSubmit: SubmitHandler<FormValues> = async ({ name }) => {
		form.clearErrors("root");

		try {
			await authClient.updateUser({
				name,
			});

			onCompleted();
		} catch {
			form.setError("root", {
				type: "server",
				message: t("onboarding.notifications.accountSetupFailed"),
			});
		}
	};

	return (
		<div>
			{workspace ? (
				<div className="mb-8 rounded-lg border border-border bg-muted/40 px-4 py-3">
					<p className="font-medium text-sm">
						{t("onboarding.account.workspaceReady", {
							name: workspace.name,
						})}
					</p>
					<p className="mt-1 text-muted-foreground text-sm">
						{t("onboarding.account.workspaceReadyHint")}
					</p>
				</div>
			) : null}

			<Form {...form}>
				<form
					className="flex flex-col items-stretch gap-8"
					onSubmit={form.handleSubmit(onSubmit)}
				>
					<FormField
						control={form.control}
						name="name"
						render={({ field }) => (
							<FormItem>
								<FormLabel>
									{t("onboarding.account.name")}
								</FormLabel>
								<FormControl>
									<Input {...field} />
								</FormControl>
							</FormItem>
						)}
					/>

					<FormItem className="flex items-center justify-between gap-4">
						<div>
							<FormLabel>
								{t("onboarding.account.avatar")}
							</FormLabel>

							<FormDescription>
								{t("onboarding.account.avatarDescription")}
							</FormDescription>
						</div>
						<FormControl>
							<UserAvatarUpload
								onSuccess={() => {
									return;
								}}
								onError={() => {
									return;
								}}
							/>
						</FormControl>
					</FormItem>

					<Button type="submit" loading={form.formState.isSubmitting}>
						{t("onboarding.continue")}
						<ArrowRightIcon className="ml-2 size-4" />
					</Button>
				</form>
			</Form>
		</div>
	);
}
