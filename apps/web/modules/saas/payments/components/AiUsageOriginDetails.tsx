import Link from "next/link";
import { type AiUsageOrigin, aiUsageOriginLinks } from "../lib/ai-usage-origin";

export function AiUsageOriginDetails({ origin }: { origin: AiUsageOrigin }) {
	const links = aiUsageOriginLinks(origin);
	const entries = [
		{ label: "Feature", value: origin.featureKey },
		{
			label: "Workspace / artifact",
			value: origin.frameId,
			href: links.frame,
		},
		{ label: "Workflow", value: origin.workflowId, href: links.workflow },
		{ label: "Workflow run", value: origin.workflowExecutionId },
		{ label: "Prompt version", value: origin.promptVersionId },
	].filter((entry) => entry.value);
	if (entries.length === 0) {
		return null;
	}
	return (
		<dl className="space-y-2 text-sm" aria-label="AI usage origin">
			{entries.map((entry) => (
				<div key={entry.label} className="flex justify-between gap-4">
					<dt className="text-muted-foreground">{entry.label}</dt>
					<dd className="min-w-0 break-all text-right">
						{entry.href ? (
							<Link
								className="text-primary underline"
								href={entry.href}
							>
								{entry.value}
								<span className="sr-only">
									{" "}
									(open {entry.label})
								</span>
							</Link>
						) : (
							entry.value
						)}
					</dd>
				</div>
			))}
		</dl>
	);
}
