import { getSession } from "@saas/auth/lib/server";
import { SecurityAccessibilityPage } from "@saas/projects/components/security";
import { redirect } from "next/navigation";

interface Props {
	params: Promise<{ id: string }>;
}

export default async function ProjectSecurityPage({ params }: Props) {
	const session = await getSession();
	if (!session?.user) {
		redirect("/auth/login");
	}

	const { id } = await params;

	return (
		<div className="container mx-auto py-8 px-4">
			{/* Personal context — explicit null prevents any org-session fallback. */}
			<SecurityAccessibilityPage projectId={id} organizationId={null} />
		</div>
	);
}
