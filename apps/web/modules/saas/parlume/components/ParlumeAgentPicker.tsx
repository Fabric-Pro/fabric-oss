"use client";

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Loader2Icon } from "lucide-react";
import type { ParlumeAgent } from "../lib/parlume-format";

export const FABRIC_AGENT_KIND = "FABRIC_AGENT";
const CUSTOM_AGENT_NOTE = "Custom agent bound to this project.";

/** One value per agent: the built-in one, or a custom agent by its stable id. */
export function agentKey(agent: ParlumeAgent): string {
	return agent.kind === FABRIC_AGENT_KIND
		? FABRIC_AGENT_KIND
		: `custom:${agent.agentInstanceSId}`;
}

function agentTag(agent: ParlumeAgent): string {
	return agent.kind === FABRIC_AGENT_KIND ? "Built-in" : `v${agent.version}`;
}

function agentNote(agent: ParlumeAgent): string {
	return agent.description ?? CUSTOM_AGENT_NOTE;
}

/** Which Fabric Agent answers in the meeting. */
export function ParlumeAgentPicker({
	agents,
	isLoading,
	isError,
	onRetry,
	selection,
	onSelect,
	disabled,
}: {
	agents: ParlumeAgent[];
	isLoading: boolean;
	isError: boolean;
	onRetry: () => void;
	selection: string;
	onSelect: (selection: string) => void;
	disabled: boolean;
}) {
	const selected = agents.find((agent) => agentKey(agent) === selection);
	return (
		<div className="min-w-0 flex-1 basis-56 space-y-2">
			<Label htmlFor="parlume-agent">Agent</Label>
			{isLoading ? (
				<p className="flex h-10 items-center gap-2 text-sm text-muted-foreground">
					<Loader2Icon
						className="size-4 motion-safe:animate-spin"
						aria-hidden="true"
					/>
					Loading project agents…
				</p>
			) : isError ? (
				<p
					className="flex flex-wrap items-center gap-2 text-sm text-destructive"
					role="alert"
				>
					Could not load project agents.
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={onRetry}
					>
						Retry agents
					</Button>
				</p>
			) : (
				<>
					<Select
						value={selection}
						onValueChange={onSelect}
						disabled={disabled}
					>
						<SelectTrigger id="parlume-agent" className="h-10">
							<SelectValue>
								{selected ? (
									<>
										{selected.label}{" "}
										<Badge variant="info">
											{agentTag(selected)}
										</Badge>
									</>
								) : (
									"Choose an agent"
								)}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{agents.map((agent) => (
								<SelectItem
									key={agentKey(agent)}
									value={agentKey(agent)}
									textValue={agent.label}
								>
									<span className="flex items-center gap-2.5">
										<span className="flex min-w-0 flex-1 flex-col">
											<span>{agent.label}</span>
											<span className="text-xs text-muted-foreground">
												{agentNote(agent)}
											</span>
										</span>
										<Badge variant="info">
											{agentTag(agent)}
										</Badge>
									</span>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{selected && (
						<p className="text-xs text-muted-foreground">
							{agentNote(selected)}
						</p>
					)}
				</>
			)}
		</div>
	);
}
