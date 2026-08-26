"use client";

import { useActiveOrganization } from "@saas/organizations/hooks/use-active-organization";
import { SettingsItem } from "@saas/shared/components/SettingsItem";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Switch } from "@ui/components/switch";
import { AlertCircle, ShieldCheckIcon, ShieldIcon } from "lucide-react";
import { toast } from "sonner";

const queryKeyFor = (organizationId: string) =>
	["organizationRequireTwoFactor", organizationId] as const;

/**
 * Org-wide MFA enforcement toggle (SOC 2 CC6.1). Admins/owners can require every
 * member to have two-factor authentication enabled; members without it are
 * redirected to enroll before they can access the organization. Default off.
 */
export function RequireTwoFactorForm() {
	const queryClient = useQueryClient();
	const { activeOrganization } = useActiveOrganization();
	const organizationId = activeOrganization?.id;

	const { data, isLoading, error } = useQuery({
		queryKey: queryKeyFor(organizationId ?? ""),
		queryFn: async () =>
			orpcClient.organizations.requireTwoFactor.get({
				organizationId: organizationId as string,
			}),
		enabled: !!organizationId,
		retry: 1,
	});

	const updateMutation = useMutation({
		mutationFn: async (requireTwoFactor: boolean) =>
			orpcClient.organizations.requireTwoFactor.update({
				organizationId: organizationId as string,
				requireTwoFactor,
			}),
		onSuccess: (result) => {
			toast.success(
				result.requireTwoFactor
					? "Two-factor authentication is now required"
					: "Two-factor authentication requirement removed",
				{
					description: result.requireTwoFactor
						? "Members without 2FA will be asked to enable it before they can access this organization."
						: "Members are no longer required to have 2FA to access this organization.",
				},
			);
			if (organizationId) {
				queryClient.invalidateQueries({
					queryKey: queryKeyFor(organizationId),
				});
			}
		},
		onError: () => {
			toast.error("Failed to update the two-factor requirement");
		},
	});

	if (isLoading) {
		return (
			<SettingsItem
				title="Require two-factor authentication"
				description="Require every member to enable 2FA to access this organization"
			>
				<div className="text-muted-foreground text-sm">Loading...</div>
			</SettingsItem>
		);
	}

	if (error) {
		return (
			<SettingsItem
				title="Require two-factor authentication"
				description="Require every member to enable 2FA to access this organization"
			>
				<div className="flex items-center gap-2 text-destructive text-sm">
					<AlertCircle className="size-4" />
					<span>Failed to load the two-factor requirement</span>
				</div>
			</SettingsItem>
		);
	}

	const requireTwoFactor = data?.requireTwoFactor ?? false;

	return (
		<SettingsItem
			title="Require two-factor authentication"
			description="Require every member to enable two-factor authentication (2FA) before they can access this organization"
		>
			<div className="space-y-4">
				<div className="flex flex-row items-center justify-between rounded-lg border p-4">
					<div className="flex-1 space-y-0.5">
						<div className="flex items-center gap-2">
							{requireTwoFactor ? (
								<ShieldCheckIcon className="size-4 text-secondary" />
							) : (
								<ShieldIcon className="size-4 text-muted-foreground" />
							)}
							<span className="font-medium text-base">
								{requireTwoFactor
									? "2FA is required for members"
									: "2FA is optional for members"}
							</span>
						</div>
						<p className="text-muted-foreground text-sm">
							{requireTwoFactor
								? "Members without 2FA are redirected to enroll before they can use this organization."
								: "Members can access this organization whether or not they have 2FA enabled."}
						</p>
					</div>
					<Switch
						checked={requireTwoFactor}
						onCheckedChange={(checked) =>
							updateMutation.mutate(checked)
						}
						disabled={updateMutation.isPending || !organizationId}
						aria-label="Require two-factor authentication for all members"
					/>
				</div>

				{requireTwoFactor && (
					<div className="rounded-md border border-highlight/40 bg-highlight/10 p-4">
						<div className="flex items-start gap-3">
							<ShieldCheckIcon className="mt-0.5 size-5 text-highlight" />
							<div className="flex-1 space-y-1 text-sm">
								<p className="font-medium text-foreground">
									Enforcement is active
								</p>
								<p className="text-foreground/70 text-xs">
									Any member (including you) who has not
									enabled two-factor authentication will be
									redirected to set it up the next time they
									open this organization. They are guided to
									enroll — they are not locked out.
								</p>
							</div>
						</div>
					</div>
				)}
			</div>
		</SettingsItem>
	);
}
