/**
 * Weave Dashboard Page
 *
 * Overview of all weave plans and executions for a project
 */

import { WeaveDashboard } from "@saas/weave/components";
import { notFound } from "next/navigation";

interface WeavePageProps {
	params: Promise<{ id: string }>;
}

export default async function WeavePage({ params }: WeavePageProps) {
	const { id: projectId } = await params;

	if (!projectId) {
		notFound();
	}

	return (
		<div className="container mx-auto py-6 px-4">
			<WeaveDashboard projectId={projectId} />
		</div>
	);
}
