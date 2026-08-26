import { getSession } from "@saas/auth/lib/server";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { SkillViewLoader } from "@saas/skills/components/SkillViewLoader";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{
		id: string;
	}>;
};

export default async function ViewSkillPage({ params }: Props) {
	const session = await getSession();
	const { id } = await params;

	if (!session) {
		redirect("/auth/login");
	}

	return (
		<div className="w-full py-6 space-y-6">
			<TopRightControls />
			<PageBreadcrumbs
				items={[
					{ label: "Skills", href: "/app/skills" },
					{ label: "View Skill" },
				]}
			/>
			<SkillViewLoader skillId={id} />
		</div>
	);
}
