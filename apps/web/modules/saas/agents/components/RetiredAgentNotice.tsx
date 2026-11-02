import { Button } from "@ui/components/button";
import Link from "next/link";

export function RetiredAgentNotice({ basePath }: { basePath: string }) {
	return (
		<div className="space-y-4 p-6">
			<h1 className="text-xl font-semibold">Agent unavailable</h1>
			<p className="text-muted-foreground">
				This system agent has been retired and can no longer be started.
			</p>
			<Button asChild variant="outline">
				<Link href={`${basePath}/agents`}>Back to Agents</Link>
			</Button>
		</div>
	);
}
