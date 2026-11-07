"use client";

import { FrameCollection } from "@saas/frames/components/FrameCollection";
import { useFrameAgentContext } from "@saas/frames/hooks/use-frame-agent-context";
import {
	FrameListSchema,
	shareScopeLabel,
} from "@saas/frames/lib/frame-tool-types";
import { useFabricToolQuery } from "@saas/mcp/lib/fabric-tool-client";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { LayoutPanelTopIcon, SparklesIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { PagesHero } from "./PagesHero";

const NEW_PAGE_PROMPT = "Create a new Page that shows ";

const PAGE_CONTEXT = { surface: "workspace" } as const;

/**
 * The organization's Pages: pages Fabric Agent wrote, which the people of
 * the organization open from here. A new Page is shared with the whole
 * organization unless it is asked to stay private. Nothing on a page is built
 * by us, so there is no form for a new one; "New page" opens Fabric Agent,
 * and the agent makes the page. The list is read through Fabric's own tools, as
 * an agent reads it.
 */
export function PagesList({ organizationSlug }: { organizationSlug: string }) {
	const t = useTranslations("frameAuthoring");
	const openAgent = useFrameAgentContext(PAGE_CONTEXT);
	const list = useFabricToolQuery(
		"fabric_list_frames",
		{ surface: "workspace" },
		{ schema: FrameListSchema },
	);

	const startPage = openAgent ? () => openAgent(NEW_PAGE_PROMPT) : undefined;

	return (
		<div className="space-y-8">
			<PagesHero
				actions={
					<div className="flex flex-wrap gap-2">
						<Button asChild variant="outline">
							<Link
								data-onboarding-target="pages-artifacts"
								href={`/app/${organizationSlug}/frames`}
							>
								{t("browse")}
							</Link>
						</Button>
						{startPage ? (
							<Button
								data-onboarding-target="pages-new"
								onClick={startPage}
							>
								<SparklesIcon
									className="mr-2 size-4"
									aria-hidden
								/>
								New page
							</Button>
						) : null}
					</div>
				}
			/>

			<FrameCollection
				query={list}
				cardLabel="Page"
				loadingLabel="Loading pages"
				errorMessage="The pages could not be loaded."
				data-onboarding-target="pages-list"
				empty={{
					icon: (
						<LayoutPanelTopIcon className="size-10" aria-hidden />
					),
					title: "No pages yet",
					description:
						"Describe the page you want, such as this week's delivery status or a board of open decisions, and Fabric Agent builds it, shares it with your organization and explains what it shows.",
					action: startPage ? (
						<Button onClick={startPage}>
							<SparklesIcon className="mr-2 size-4" aria-hidden />
							New page
						</Button>
					) : undefined,
				}}
				cardTarget={(frame) => ({
					href: `/app/${organizationSlug}/pages/${frame.frameId}`,
				})}
				cardBadges={(frame) =>
					frame.shareScope ? (
						<Badge variant="outline">
							{shareScopeLabel(frame.shareScope)}
						</Badge>
					) : null
				}
			/>
		</div>
	);
}
