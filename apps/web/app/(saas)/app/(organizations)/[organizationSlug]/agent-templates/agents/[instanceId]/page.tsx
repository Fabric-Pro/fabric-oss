import { getSession } from "@saas/auth/lib/server";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{
		organizationSlug: string;
		instanceId: string;
	}>;
};

export const metadata = {
	title: "Agent Details - Fabric",
	description: "View and manage your agent configuration",
};

export default async function AgentInstanceDetailPage({ params }: Props) {
	const session = await getSession();
	const { organizationSlug, instanceId } = await params;

	if (!session) {
		redirect("/auth/login");
	}

	redirect(
		`/app/${organizationSlug}/agents?agentId=${encodeURIComponent(instanceId)}`,
	);
}
