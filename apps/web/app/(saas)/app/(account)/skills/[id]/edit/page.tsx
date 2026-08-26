import { getSession } from "@saas/auth/lib/server";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { SkillEditLoader } from "@saas/skills/components/SkillEditLoader";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{
		id: string;
	}>;
};

export default async function EditSkillPage({ params }: Props) {
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
					{ label: "Edit Skill" },
				]}
			/>
			<SkillEditLoader skillId={id} />
		</div>
	);
}
