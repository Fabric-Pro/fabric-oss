"use client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { useTranslations } from "next-intl";
export function WorkflowReadiness({
	id,
	organizationId,
}: {
	id: string;
	organizationId: string;
}) {
	const t = useTranslations("workflows.authoring");
	const copy = (key: string, fallback: string) =>
		t.has(key) ? t(key) : fallback;
	const check = useQuery(
		orpc.workflows.readiness.queryOptions({
			input: { id, organizationId },
			staleTime: 0,
		}),
	);
	return (
		<section
			aria-label="Workflow configuration check"
			className="space-y-2 rounded-lg border p-3 text-sm"
		>
			<div className="flex items-center justify-between gap-2">
				<h3 className="font-medium">
					{copy("configuration", "Configuration check")}
				</h3>
				<Button
					size="sm"
					variant="ghost"
					disabled={check.isFetching}
					onClick={() => check.refetch()}
				>
					{copy("checkAgain", "Check again")}
				</Button>
			</div>
			{check.isPending ? (
				<p role="status">
					{copy("checking", "Checking saved configuration…")}
				</p>
			) : check.isError ? (
				<p role="alert">
					{copy(
						"checkFailed",
						"Could not check configuration. Try again before publishing.",
					)}
				</p>
			) : (
				<>
					<p role="status">
						{check.data.ready
							? copy(
									"noIssues",
									"No setup issues found in the checks below.",
								)
							: copy(
									"setupIssues",
									"Review these setup issues before publishing.",
								)}
					</p>
					{check.data.errors.map((e, i) => (
						<p key={`${i}-${e}`} className="text-destructive">
							{e}
						</p>
					))}
					<ul className="space-y-2">
						{check.data.checks.map((c) => (
							<li key={c.nodeId}>
								<p className="font-medium">
									{c.label} ·{" "}
									{c.status === "configured"
										? copy("configured", "Configured")
										: c.status === "needs-setup"
											? copy("needsSetup", "Needs setup")
											: copy(
													"runtimeCheck",
													"Checked at runtime",
												)}
								</p>
								<p className="text-xs text-muted-foreground">
									{c.message}
								</p>
							</li>
						))}
					</ul>
					<p className="text-xs text-muted-foreground">
						{check.data.limitation}
					</p>
				</>
			)}
		</section>
	);
}
