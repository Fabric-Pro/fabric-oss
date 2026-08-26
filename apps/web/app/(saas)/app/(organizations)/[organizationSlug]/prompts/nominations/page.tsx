import { getSession } from "@saas/auth/lib/server";
import { NominationQueue } from "@saas/prompts/components/NominationQueue";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { redirect } from "next/navigation";

export default async function PromptNominationsPage({
	params,
}: {
	params: Promise<{ organizationSlug: string }>;
}) {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	const { organizationSlug } = await params;

	return (
		<div className="w-full space-y-6 py-6">
			<TopRightControls />
			<PageBreadcrumbs
				items={[
					{
						label: "Prompts",
						href: `/app/${organizationSlug}/prompts`,
					},
					{ label: "Proposed defaults" },
				]}
			/>

			<div className="space-y-2">
				<h1 className="font-serif text-3xl">Proposed defaults</h1>
				<p className="text-muted-foreground">
					Prompts members have proposed as a default, grouped by the
					action they would run.
				</p>
			</div>

			<NominationQueue />
		</div>
	);
}
