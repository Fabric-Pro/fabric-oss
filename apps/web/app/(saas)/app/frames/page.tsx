import { getSession } from "@saas/auth/lib/server";
import { FramesList } from "@saas/frames/components/FramesList";
import { PageHeader } from "@saas/shared/components/PageHeader";
import { redirect } from "next/navigation";

export const metadata = {
	title: "Frames",
	description: "Manage your interactive visual artifacts",
};

export default async function FramesPage() {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	return (
		<div className="container max-w-6xl py-6">
			<PageHeader
				title="Frames"
				subtitle="Interactive visual artifacts created by AI agents"
			/>
			<div className="mt-6">
				<FramesList organizationId={null} />
			</div>
		</div>
	);
}
