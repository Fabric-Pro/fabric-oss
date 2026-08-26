import { getSession } from "@saas/auth/lib/server";
import { MyOverridesList } from "@saas/prompts/components/MyOverridesList";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { redirect } from "next/navigation";

export default async function MyOverridesPage({
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
					{ label: "My Overrides" },
				]}
			/>

			<div className="space-y-2">
				<h1 className="font-serif text-3xl">My Overrides</h1>
				<p className="text-muted-foreground">
					Every action where your own default prompt is in force.
					Personal defaults follow you across organizations.
				</p>
			</div>

			<MyOverridesList basePath={`/app/${organizationSlug}`} />
		</div>
	);
}
