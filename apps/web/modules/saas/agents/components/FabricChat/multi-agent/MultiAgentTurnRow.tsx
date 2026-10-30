"use client";

import type { ChatScope } from "@saas/projects/components/excalidraw-auto-insert/useChatScopedProject";
import { RobotIcon } from "@saas/shared/components/icons/RobotIcon";
import { Badge } from "@ui/components/badge";
import { XIcon } from "lucide-react";
import type { ApprovalSendResult } from "../../../lib/approval-response";
import type { MultiAgentTurnRecord } from "../../../lib/multi-agent-runtime-protocol";
import {
	type MultiAgentTurnView,
	multiAgentViewFromRecord,
} from "../../../lib/multi-agent-turn";
import type { SelectedAgent } from "../shared/agent-selection";
import { useProviderPickStatus } from "../shared/use-provider-pick-status";
import { AgentResponseBlock } from "./AgentResponseBlock";

/**
 * A multi-agent turn in the thread: the question, then each agent's answer
 * as Nexus shows it (`AgentResponseBlock`), its approval answered through
 * the turn's run.
 */
export function MultiAgentTurnRow({
	question,
	view,
	record,
	organizationId,
	organizationSlug,
	chatScope,
	onAnswer,
}: {
	question: string;
	/** The live turn's view, or */
	view?: MultiAgentTurnView;
	/** a saved turn's record. */
	record?: MultiAgentTurnRecord;
	organizationId?: string | null;
	organizationSlug?: string | null;
	chatScope: ChatScope;
	onAnswer?: (
		interruptId: string,
		decision: { approved: boolean; feedback?: string },
	) => Promise<ApprovalSendResult>;
}) {
	const shown =
		view ?? (record ? multiAgentViewFromRecord(record, question) : null);
	if (!shown) {
		return null;
	}
	return (
		<div className="space-y-4">
			<div className="flex justify-end py-2">
				<p className="max-w-[70%] whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 text-sm">
					{question}
				</p>
			</div>
			{shown.status === "refused" && shown.error ? (
				<p role="alert" className="text-destructive text-sm">
					{shown.error}
				</p>
			) : null}
			<div className="space-y-4">
				{shown.agents.map((agent) => (
					<AgentResponseBlock
						key={agent.memberKey}
						response={agent}
						organizationId={organizationId}
						organizationSlug={organizationSlug}
						chatScope={chatScope}
						onApprovalRespond={onAnswer}
					/>
				))}
			</div>
		</div>
	);
}

/**
 * The agents picked after the first, each removable (multi-agent mode),
 * each noting when its model's provider is not active, as Nexus does.
 */
export function MultiAgentPickBadges({
	agents,
	organizationId,
	onRemove,
}: {
	agents: SelectedAgent[];
	organizationId?: string | null;
	onRemove: (agent: SelectedAgent) => void;
}) {
	const { getInactiveNote } = useProviderPickStatus(organizationId, agents);
	return (
		<>
			{agents.map((agent) => {
				const inactiveNote = getInactiveNote(agent);
				return (
					<Badge
						key={agent.agentId}
						variant="secondary"
						className="gap-1 rounded-full"
						title={inactiveNote}
					>
						<RobotIcon className="h-3 w-3" />
						{agent.name}
						{inactiveNote ? (
							<span className="text-highlight-ink">
								not applied
							</span>
						) : null}
						<button
							type="button"
							onClick={() => onRemove(agent)}
							aria-label={`Remove ${agent.name}`}
							className="ml-0.5 text-muted-foreground transition-colors hover:text-foreground"
						>
							<XIcon className="h-3 w-3" />
						</button>
					</Badge>
				);
			})}
		</>
	);
}
