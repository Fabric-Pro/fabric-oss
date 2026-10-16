"use client";

import { FrameCollection } from "@saas/frames/components/FrameCollection";
import { FrameDetailView } from "@saas/frames/components/FrameDetailView";
import { useOpenFrameAgent } from "@saas/frames/hooks/use-open-frame-agent";
import {
	FrameDetailSchema,
	FrameListSchema,
	type FrameSummary,
} from "@saas/frames/lib/frame-tool-types";
import { PageTourButton } from "@saas/get-started/components/PageTourButton";
import { useFabricToolQuery } from "@saas/mcp/lib/fabric-tool-client";
import { useIsGuestInOrg } from "@saas/organizations/hooks/use-is-guest-in-org";
import {
	useOrganizationId,
	useOrganizationSlug,
} from "@saas/organizations/hooks/use-organization-context";
import { Button } from "@ui/components/button";
import { ArrowLeftIcon, CodeIcon, SparklesIcon } from "lucide-react";
import { useState } from "react";

const ASK_FOR_ARTIFACT_PROMPT =
	"Build a page for this project: a status board of the current work, with a refresh button. Explain what it shows.";

function editPrompt(frame: Pick<FrameSummary, "frameId" | "title">) {
	return `Change the artifact "${frame.title}" (frame id ${frame.frameId}): `;
}

/**
 * The project's Artifacts tab: the pages Fabric Agent has written for this
 * project. Nothing on a page is built by us; the agent writes the HTML and its
 * script, saves it here, and explains it. This tab lists them, opens one in the
 * sandboxed viewer, and is where "ask Fabric Agent for a page" starts. It reads
 * through Fabric's own tools, the ones an agent calls, which serve only members
 * of the organization: a guest of the project is told so instead of being
 * shown an error.
 */
export function ProjectArtifactsList({
	projectId,
	projectName,
	organizationSlug,
}: {
	projectId: string;
	projectName?: string;
	/** The organization of the page's address; read from the page when absent. */
	organizationSlug?: string;
}) {
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const isGuest = useIsGuestInOrg();
	const contextSlug = useOrganizationSlug();
	const slug = organizationSlug ?? contextSlug;
	const openAgent = useOpenFrameAgent({
		projectId,
		projectName: projectName ?? null,
		surface: "artifact",
	});

	const list = useFabricToolQuery(
		"fabric_list_frames",
		{ projectId, surface: "artifact" },
		{ schema: FrameListSchema, enabled: !isGuest },
	);

	if (selectedId && slug) {
		return (
			<ArtifactView
				frameId={selectedId}
				organizationSlug={slug}
				onBack={() => setSelectedId(null)}
				onEdit={openAgent}
			/>
		);
	}

	return (
		<div className="space-y-6">
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div className="space-y-1">
					<p className="app-editorial-label">
						Written by Fabric Agent
					</p>
					<div className="flex items-center gap-1.5">
						<h2
							data-onboarding-target="artifacts-header"
							className="font-serif text-3xl leading-tight text-foreground"
						>
							Artifacts
						</h2>
						<PageTourButton pageId="artifacts" />
					</div>
					<p className="max-w-2xl text-sm leading-6 text-muted-foreground">
						Pages built for this project: status boards, reports,
						small tools. Ask Fabric Agent for one and it writes the
						page, saves it here and explains what it shows.
					</p>
				</div>
				{openAgent && !isGuest ? (
					<Button
						size="sm"
						data-onboarding-target="artifacts-ask"
						onClick={() => openAgent(ASK_FOR_ARTIFACT_PROMPT)}
					>
						<SparklesIcon className="mr-2 size-4" aria-hidden />
						Ask Fabric Agent
					</Button>
				) : null}
			</div>

			{isGuest ? (
				<p
					data-testid="artifacts-guest-notice"
					className="max-w-2xl rounded-lg border border-border bg-card p-5 text-sm leading-6 text-muted-foreground"
				>
					You are a guest of this project, and the list of its
					artifacts is kept for members of the organization. Someone
					who can open an artifact can share it with you; it then
					opens from the link they send.
				</p>
			) : (
				<FrameCollection
					query={list}
					cardLabel="Artifact"
					loadingLabel="Loading artifacts"
					errorMessage="The artifacts could not be loaded."
					data-onboarding-target="artifacts-list"
					empty={{
						icon: <CodeIcon className="size-10" aria-hidden />,
						title: "No artifacts yet",
						description:
							"Ask Fabric Agent to build a page for this project, for example a status board with a refresh button. It writes the page, saves it here and tells you what each part does.",
						action: openAgent ? (
							<Button
								onClick={() =>
									openAgent(ASK_FOR_ARTIFACT_PROMPT)
								}
							>
								<SparklesIcon
									className="mr-2 size-4"
									aria-hidden
								/>
								Ask Fabric Agent
							</Button>
						) : undefined,
					}}
					cardTarget={(frame) => ({
						onOpen: () => setSelectedId(frame.frameId),
					})}
				/>
			)}
		</div>
	);
}

function ArtifactView({
	frameId,
	organizationSlug,
	onBack,
	onEdit,
}: {
	frameId: string;
	organizationSlug: string;
	onBack: () => void;
	onEdit?: (prompt: string) => void;
}) {
	const organizationId = useOrganizationId();
	const detail = useFabricToolQuery(
		"fabric_get_frame",
		{ frameId },
		{ schema: FrameDetailSchema },
	);

	const frame = detail.data;

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<Button variant="ghost" size="sm" onClick={onBack}>
					<ArrowLeftIcon className="mr-2 size-4" aria-hidden />
					All artifacts
				</Button>
				{frame && onEdit ? (
					<Button
						variant="outline"
						size="sm"
						onClick={() => onEdit(editPrompt(frame))}
					>
						<SparklesIcon className="mr-2 size-4" aria-hidden />
						Change with Fabric Agent
					</Button>
				) : null}
			</div>

			<FrameDetailView
				detail={detail}
				surface="artifact"
				organizationId={organizationId}
				organizationSlug={organizationSlug}
				onOpenAgent={onEdit}
			/>
		</div>
	);
}
