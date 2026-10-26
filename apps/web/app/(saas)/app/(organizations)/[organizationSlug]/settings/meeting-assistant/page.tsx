import { isOrganizationAdmin } from "@repo/auth/lib/helper";
import { isFeatureEnabled } from "@repo/database";
import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { MeetingAssistantSettings } from "@saas/parlume/components/MeetingAssistantSettings";
import { SettingsHero } from "@saas/settings/components/SettingsHero";
import { SettingsList } from "@saas/shared/components/SettingsList";
import { notFound, redirect } from "next/navigation";

export async function generateMetadata() {
	return {
		title: "Meeting assistant",
	};
}

/**
 * Parlume's organization settings. Exists only while the `PARLUME_MEETINGS`
 * rollout gate is on for this organization, like the Parlume page itself;
 * read-only for members who are not admins, as the procedures enforce.
 */
export default async function MeetingAssistantSettingsPage({
	params,
}: {
	params: Promise<{ organizationSlug: string }>;
}) {
	const session = await getSession();
	const { organizationSlug } = await params;
	const organization = await getActiveOrganization(organizationSlug);

	if (!organization) {
		redirect("/app");
	}
	if (!(await isFeatureEnabled("PARLUME_MEETINGS", organization.id))) {
		notFound();
	}

	return (
		<>
			<SettingsHero
				title="Meeting assistant"
				label="Parlume"
				description="Set up the meeting bot and the voice Parlume uses when it joins your Teams meetings."
			/>
			<SettingsList>
				<MeetingAssistantSettings
					organizationId={organization.id}
					aiProvidersHref={`/app/${organizationSlug}/settings/ai-providers`}
					readOnly={!isOrganizationAdmin(organization, session?.user)}
				/>
			</SettingsList>
		</>
	);
}
