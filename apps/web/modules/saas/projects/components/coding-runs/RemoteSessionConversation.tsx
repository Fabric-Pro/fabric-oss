"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { ExternalLinkIcon, HelpCircleIcon, MonitorIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MULTI_PART_PUBLIC_SUFFIXES = new Set([
	"co.uk",
	"org.uk",
	"gov.uk",
	"ac.uk",
	"com.au",
	"net.au",
	"org.au",
	"co.jp",
	"co.nz",
	"com.br",
	"co.in",
]);

function normalizeHost(hostname?: string): string | null {
	if (!hostname) {
		return null;
	}
	const trimmed = hostname.trim().toLowerCase().replace(/\.$/, "");
	if (!trimmed) {
		return null;
	}
	return trimmed === "::1" ? "[::1]" : trimmed;
}

function isIpLiteral(host: string): boolean {
	return host.startsWith("[") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

function registrableSiteKey(host: string): string {
	if (LOOPBACK_HOSTS.has(host) || isIpLiteral(host)) {
		return host;
	}
	const labels = host.split(".").filter(Boolean);
	if (labels.length <= 2) {
		return host;
	}
	const lastTwo = labels.slice(-2).join(".");
	if (MULTI_PART_PUBLIC_SUFFIXES.has(lastTwo) && labels.length >= 3) {
		return labels.slice(-3).join(".");
	}
	return lastTwo;
}

export function isCrossSiteWebUiUrl(
	targetUrl: string,
	portalLocation?: string,
): boolean {
	if (!portalLocation) {
		return false;
	}
	let targetParsed: URL;
	try {
		targetParsed = new URL(targetUrl);
	} catch {
		return false;
	}
	if (
		targetParsed.protocol !== "http:" &&
		targetParsed.protocol !== "https:"
	) {
		return false;
	}
	const targetHost = normalizeHost(targetParsed.hostname);
	if (!targetHost) {
		return false;
	}

	let portalHost: string | null = null;
	let portalProtocol: string | null = null;
	if (/^https?:\/\//i.test(portalLocation.trim())) {
		try {
			const parsedPortal = new URL(portalLocation.trim());
			portalHost = normalizeHost(parsedPortal.hostname);
			portalProtocol = parsedPortal.protocol;
		} catch {
			return false;
		}
	} else {
		portalHost = normalizeHost(portalLocation);
	}
	if (!portalHost) {
		return false;
	}
	if (portalProtocol && targetParsed.protocol !== portalProtocol) {
		return true;
	}
	if (targetHost === portalHost) {
		return false;
	}
	return registrableSiteKey(targetHost) !== registrableSiteKey(portalHost);
}

export function RemoteSessionConversation({
	codingRunId,
	organizationId,
	active = false,
	fallbackWebUrl = null,
}: {
	codingRunId: string;
	organizationId?: string | null;
	active?: boolean;
	fallbackWebUrl?: string | null;
}) {
	const t = useTranslations("projects.remoteAgents");
	const [embedWebUi, setEmbedWebUi] = useState(false);
	const [portalOrigin, setPortalOrigin] = useState<string | undefined>(
		undefined,
	);
	useEffect(() => {
		setPortalOrigin(window.location.origin);
	}, []);
	const query = useQuery({
		queryKey: ["remoteSessionMessages", codingRunId, organizationId],
		gcTime: 0,
		queryFn: () =>
			orpcClient.codingRuns.messages({ id: codingRunId, organizationId }),
		refetchInterval: active ? 5000 : false,
		retry: false,
	});
	const liveWebUrl = query.data?.webUrl || fallbackWebUrl || null;
	const crossSiteWebUi = liveWebUrl
		? isCrossSiteWebUiUrl(liveWebUrl, portalOrigin)
		: false;
	return (
		<section
			className="space-y-3 border-t border-border pt-4"
			aria-label={t("conversation")}
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex items-center gap-2">
					<h3 className="text-sm font-medium">{t("conversation")}</h3>
					<TooltipProvider delayDuration={150}>
						<Tooltip>
							<TooltipTrigger asChild>
								<a
									href="/docs/features/projects#viewing-the-live-server-web-ui-inside-the-fabric-portal"
									target="_blank"
									rel="noopener noreferrer"
									data-testid="live-session-webui-docs-link"
									aria-label="Live Server Web UI in Portal documentation"
									className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
								>
									<HelpCircleIcon className="size-3" />
									Docs
								</a>
							</TooltipTrigger>
							<TooltipContent className="max-w-xs space-y-1 text-xs leading-relaxed">
								<p className="font-semibold">
									Live Server Web UI &amp; Session Stream
								</p>
								<p>
									Click &ldquo;View Live Server Web UI in
									Portal&rdquo; to embed the real Fabric
									Agents Remote Server Web UI inline, or send
									follow-up instructions below.
								</p>
							</TooltipContent>
						</Tooltip>
					</TooltipProvider>
				</div>
				{liveWebUrl && (
					<div className="flex flex-wrap items-center gap-1.5">
						<Button
							type="button"
							variant={embedWebUi ? "default" : "outline"}
							size="sm"
							onClick={() => setEmbedWebUi((current) => !current)}
							data-testid="toggle-embedded-session-webui"
						>
							<MonitorIcon className="mr-1.5 size-3.5" />
							{embedWebUi
								? "Hide Embedded Server Web UI"
								: "View Live Server Web UI in Portal"}
						</Button>
						<Button asChild variant="outline" size="sm">
							<a
								href={liveWebUrl}
								target="_blank"
								rel="noopener noreferrer"
							>
								<ExternalLinkIcon className="mr-1.5 size-3.5" />
								{t("openBrowser")}
							</a>
						</Button>
					</div>
				)}
			</div>
			<p className="text-xs text-muted-foreground">
				{t("conversationHelp")}
			</p>
			{embedWebUi && liveWebUrl && (
				<div className="overflow-hidden rounded-lg border border-primary/30 bg-background shadow-xs">
					<div className="flex items-center justify-between border-b border-border/60 bg-muted/30 px-3 py-1.5 text-xs">
						<span className="font-medium text-foreground">
							Fabric Agents Remote Server Web UI (Live Session)
						</span>
						<span className="truncate font-mono text-[11px] text-muted-foreground">
							{liveWebUrl}
						</span>
					</div>
					{crossSiteWebUi && (
						<p
							data-testid="cross-site-webui-cookie-note"
							className="border-b border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
						>
							This server runs on a different site from the
							Portal, so browsers block its{" "}
							<code className="font-mono text-foreground">
								SameSite=Strict
							</code>{" "}
							session cookie inside an embedded frame. If it stays
							on the sign-in screen, use{" "}
							<strong className="font-medium text-foreground">
								{t("openBrowser")}
							</strong>{" "}
							or connect using a matching hostname (for example{" "}
							<code className="font-mono text-foreground">
								localhost
							</code>{" "}
							vs{" "}
							<code className="font-mono text-foreground">
								127.0.0.1
							</code>
							).
						</p>
					)}
					<iframe
						src={liveWebUrl}
						title="Fabric Agents Remote Server Web UI"
						className="h-[520px] w-full border-0"
						allow="clipboard-read; clipboard-write"
						sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
					/>
				</div>
			)}
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
