/**
 * Weave Settings Page
 *
 * Configuration for fabric-weave multi-agent orchestration
 */

import { ProjectWeaveConfigSettings } from "@saas/weave/components";
import { notFound } from "next/navigation";

interface WeaveSettingsPageProps {
	params: Promise<{ id: string }>;
}

export default async function WeaveSettingsPage({
	params,
}: WeaveSettingsPageProps) {
	const { id: projectId } = await params;

	if (!projectId) {
		notFound();
	}

	return (
		<div className="container mx-auto py-6 px-4 max-w-4xl">
			<ProjectWeaveConfigSettings projectId={projectId} />
		</div>
	);
}
