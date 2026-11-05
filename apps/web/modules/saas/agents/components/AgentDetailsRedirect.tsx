"use client";
import { buildAgentDetailsHref } from "@saas/agents/lib/fabric-agent-links";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Preserve old agent links while inspection moves into the directory drawer. */
export function AgentDetailsRedirect({
	basePath,
	instanceId,
}: {
	basePath: string;
	instanceId: string;
}) {
	const router = useRouter();
	useEffect(() => {
		router.replace(
			buildAgentDetailsHref({
				basePath,
				instanceId,
				view:
					window.location.hash === "#agent-runs"
						? "runs"
						: "overview",
			}),
			{ scroll: false },
		);
	}, [router, basePath, instanceId]);
	return (
		<p className="p-6 text-sm text-muted-foreground" role="status">
			Opening agent details…
		</p>
	);
}
