import { getSession } from "@saas/auth/lib/server";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { SkillEditor } from "@saas/skills/components/SkillEditor";
import { redirect } from "next/navigation";

export default async function NewSkillPage() {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	return (
		<div className="min-h-screen">
			<div className="w-full py-6 px-6 space-y-6">
				<TopRightControls />
				<PageBreadcrumbs
					items={[
						{ label: "Skills", href: "/app/skills" },
						{ label: "New Skill" },
					]}
				/>
			</div>
			<SkillEditor />
		</div>
	);
}
