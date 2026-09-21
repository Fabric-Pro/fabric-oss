"use client";
import { isOrganizationAdmin } from "@repo/auth/lib/helper";
import { useSession } from "@saas/auth/hooks/use-session";
import { useFullOrganizationQuery } from "@saas/organizations/lib/api";
import { SettingsItem } from "@saas/shared/components/SettingsItem";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { InviteMemberForm } from "./InviteMemberForm";
import { OrganizationContactsList } from "./OrganizationContactsList";
import { OrganizationInvitationsList } from "./OrganizationInvitationsList";
import { OrganizationMembersList } from "./OrganizationMembersList";

export function OrganizationMembersBlock({
	organizationId,
}: {
	organizationId: string;
}) {
	const t = useTranslations();
	const [activeTab, setActiveTab] = useState("members");
	const { user } = useSession();
	const { data: organization } = useFullOrganizationQuery(organizationId);
	// The contact register holds third-party names and contact details across
	// every project, and adding to it is the same kind of act as inviting
	// someone in — so it is gated on exactly the permission that gates the
	// invite form, not merely on being able to see the members list.
	const canInvite = isOrganizationAdmin(organization, user);

	return (
		<>
			{canInvite && (
				<InviteMemberForm
					organizationId={organizationId}
					onSwitchToPendingTab={() => setActiveTab("invitations")}
				/>
			)}
			<SettingsItem
				title={t("organizations.settings.members.title")}
				description={t("organizations.settings.members.description")}
			>
				<Tabs
					value={activeTab}
					onValueChange={(tab) => setActiveTab(tab)}
				>
					{/*
					 * `flex-wrap` because a third trigger is what tips this
					 * list past a phone-width settings column: the list is an
					 * `inline-flex` of `whitespace-nowrap` triggers, so
					 * without it the page gains a horizontal scrollbar rather
					 * than the tabs giving way.
					 */}
					<TabsList className="mb-4 max-w-full flex-wrap">
						<TabsTrigger value="members">
							{t("organizations.settings.members.activeMembers")}
						</TabsTrigger>
						<TabsTrigger value="invitations">
							{t(
								"organizations.settings.members.pendingInvitations",
							)}
						</TabsTrigger>
						{canInvite && (
							<TabsTrigger value="contacts">
								{t(
									"organizations.settings.members.contacts.tab",
								)}
							</TabsTrigger>
						)}
					</TabsList>
					<TabsContent value="members">
						<OrganizationMembersList
							organizationId={organizationId}
						/>
					</TabsContent>
					<TabsContent value="invitations">
						<OrganizationInvitationsList
							organizationId={organizationId}
						/>
					</TabsContent>
					{canInvite && (
						<TabsContent value="contacts">
							<OrganizationContactsList
								organizationId={organizationId}
							/>
						</TabsContent>
					)}
				</Tabs>
			</SettingsItem>
		</>
	);
}
