"use client";

import { useCliDiscovery } from "@saas/projects/components/cli-connection/lib/use-cli-discovery";
import { Button } from "@ui/components/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import { CheckIcon, CopyIcon, InfoIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	CLI_NPM_INSTALL,
	chatgptConnectLines,
} from "./lib/chatgpt-connect-line";

function CopyableLine({ line, testId }: { line: string; testId?: string }) {
	const t = useTranslations("settings.chatgptPlan");
	const [copied, setCopied] = useState(false);

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(line);
			setCopied(true);
			toast.success(t("copied"));
		} catch {
			toast.error(t("copyFailed"));
		}
	};

	return (
		<div className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2">
			<code
				className="min-w-0 flex-1 break-all font-mono text-sm"
				data-testid={testId}
			>
				{line}
			</code>
			<Button
				aria-label={t("copyCommand")}
				autoLoading={false}
				onClick={() => void copy()}
				size="icon"
				type="button"
				variant="ghost"
			>
				{copied ? (
					<CheckIcon aria-hidden="true" className="size-4" />
				) : (
					<CopyIcon aria-hidden="true" className="size-4" />
				)}
			</Button>
		</div>
	);
}

/**
 * The `fabric connect chatgpt` line for this deployment, with a copy button
 * and help on getting the CLI (Fizzy #2770). Shared by the personal plan
 * card, the reconnect notices and the organization's shared accounts card,
 * so they never disagree about which CLI to run where.
 */
export function ChatgptConnectCommand({
	sharedOrganizationSlug,
}: {
	sharedOrganizationSlug?: string;
}) {
	const t = useTranslations("settings.chatgptPlan.cli");
	const discovery = useCliDiscovery(true);
	// The page's own address is known only once mounted.
	const [origin, setOrigin] = useState("");
	useEffect(() => {
		setOrigin(window.location.origin);
	}, []);

	const lines = chatgptConnectLines({
		document:
			discovery.status === "ready" && origin !== ""
				? discovery.document
				: null,
		origin,
		sharedOrganizationSlug,
	});

	return (
		<div className="flex items-start gap-1">
			<div className="min-w-0 flex-1">
				<CopyableLine
					line={lines.primary}
					testId="chatgpt-connect-line"
				/>
			</div>
			<Popover>
				<PopoverTrigger asChild>
					<Button
						aria-label={t("helpLabel")}
						autoLoading={false}
						size="icon"
						type="button"
						variant="ghost"
					>
						<InfoIcon aria-hidden="true" className="size-4" />
					</Button>
				</PopoverTrigger>
				<PopoverContent
					className="w-96 max-w-[calc(100vw-2rem)] space-y-3"
					data-testid="chatgpt-connect-help"
				>
					<p className="font-medium text-sm">{t("helpTitle")}</p>
					{lines.primaryKind === "served" ? (
						<p className="text-muted-foreground text-sm">
							{t("servedPrimary")}
						</p>
					) : lines.servedLine ? (
						<>
							<p className="text-muted-foreground text-sm">
								{t("noCliYet")}
							</p>
							<CopyableLine line={lines.servedLine} />
						</>
					) : (
						<p className="text-muted-foreground text-sm">
							{t("installFirst")}
						</p>
					)}
					{lines.primaryKind === "served" || lines.servedLine ? (
						<p className="text-muted-foreground text-sm">
							{t("permanentInstall")}
						</p>
					) : null}
					<CopyableLine line={CLI_NPM_INSTALL} />
					<p className="text-muted-foreground text-xs">
						{t("checkVersion")}
					</p>
				</PopoverContent>
			</Popover>
		</div>
	);
}
