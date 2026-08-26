import { getSession } from "@saas/auth/lib/server";
import { PromptCatalog } from "@saas/prompts/components/PromptCatalog";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { redirect } from "next/navigation";

export default async function OrgPromptCatalogPage({
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
					{ label: "Catalog" },
				]}
			/>

			<div className="space-y-2">
				<h1 className="font-serif text-3xl">Prompt catalog</h1>
				<p className="text-muted-foreground">
					Browse by the action you are trying to perform, and see
					which prompt runs it today.
				</p>
			</div>

			<PromptCatalog />
		</div>
	);
}
