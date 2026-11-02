"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { useTranslations } from "next-intl";

export function RemoteSessionConversation({
	codingRunId,
	organizationId,
	active = false,
}: {
	codingRunId: string;
	organizationId?: string | null;
	active?: boolean;
}) {
	const t = useTranslations("projects.remoteAgents");
	const query = useQuery({
		queryKey: ["remoteSessionMessages", codingRunId, organizationId],
		gcTime: 0,
		queryFn: () =>
			orpcClient.codingRuns.messages({ id: codingRunId, organizationId }),
		refetchInterval: active ? 5000 : false,
		retry: false,
	});
	return (
		<section
			className="space-y-3 border-t border-border pt-4"
			aria-label={t("conversation")}
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h3 className="text-sm font-medium">{t("conversation")}</h3>
				{query.data?.webUrl && (
					<Button asChild variant="outline" size="sm">
						<a
							href={query.data.webUrl}
							target="_blank"
							rel="noopener noreferrer"
						>
							{t("openBrowser")}
						</a>
					</Button>
				)}
			</div>
			<p className="text-xs text-muted-foreground">
				{t("conversationHelp")}
			</p>
			{query.isPending ? (
				<output>{t("loading")}</output>
			) : query.isError ? (
				<div role="alert" className="space-y-2">
					<p className="text-sm text-destructive">
						{query.error.message}
					</p>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => query.refetch()}
					>
						{t("retry")}
					</Button>
				</div>
			) : !query.data?.messages.length ? (
				<p className="text-sm text-muted-foreground">
					{t("noMessages")}
				</p>
			) : (
				<ol className="max-h-80 space-y-4 overflow-y-auto rounded-md border border-border p-4">
					{query.data.messages.map((message) => (
						<li key={message.id} className="space-y-1">
							<p className="text-xs font-medium text-muted-foreground">
								{message.role === "user"
									? t("you")
									: t("agent")}
							</p>
							<p className="whitespace-pre-wrap break-words text-sm leading-6">
								{message.content}
							</p>
						</li>
					))}
				</ol>
			)}
		</section>
	);
}
