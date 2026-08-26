import { getSession } from "@saas/auth/lib/server";
import { PromptGovernanceDashboard } from "@saas/prompts/components/PromptGovernanceDashboard";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { redirect } from "next/navigation";

export default async function PromptGovernancePage({
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
					{ label: "Org Overrides" },
				]}
			/>

			<div className="space-y-2">
				<h1 className="font-serif text-3xl">Org Overrides</h1>
				<p className="text-muted-foreground">
					Which actions this organization has set its own prompt for,
					and which are still using the Fabric default.
				</p>
			</div>

			<PromptGovernanceDashboard />
		</div>
	);
}
