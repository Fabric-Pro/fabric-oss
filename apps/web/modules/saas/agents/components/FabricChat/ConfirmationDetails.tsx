"use client";

import { Badge } from "@ui/components/badge";
import { AlertTriangle } from "lucide-react";
import {
	type ChatConfirmationRequest,
	describeConsequence,
	summarizeArguments,
	type WorkflowDraft,
} from "../../lib/chat-confirmation";

function Row({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="grid gap-1 sm:grid-cols-[8.5rem_1fr] sm:gap-3">
			<dt className="text-xs text-muted-foreground">{label}</dt>
			<dd className="min-w-0 break-words text-sm text-foreground">
				{children}
			</dd>
		</div>
	);
}

function BadgeList({ items }: { items: string[] }) {
	return (
		<ul className="flex flex-wrap gap-1.5">
			{items.map((item) => (
				<li key={item}>
					<Badge status="info">{item}</Badge>
				</li>
			))}
		</ul>
	);
}

/**
 * The scheduled workflow behind the approval: when it runs, what it does,
 * which servers and tools the agent may use while nobody is watching, and where
 * its page goes. Everything is read from the draft the gateway produced for the
 * same arguments, so what is approved is what is saved.
 */
function WorkflowDraftRows({ draft }: { draft: WorkflowDraft }) {
	return (
		<>
			{draft.schedule ? (
				<Row label="Runs">
					<span>{draft.schedule.description}</span>
					<span className="mt-0.5 block font-mono text-xs text-muted-foreground">
						{draft.schedule.cron} · {draft.schedule.timezone}
					</span>
				</Row>
			) : null}
			{draft.prompt ? (
				<Row label="Task">
					<p className="line-clamp-4 whitespace-pre-wrap">
						{draft.prompt}
					</p>
				</Row>
			) : null}
			{draft.mcpServers.length > 0 ? (
				<Row label="Connected servers">
					<BadgeList
						items={draft.mcpServers.map((server) => server.name)}
					/>
				</Row>
			) : null}
			{draft.builtInTools.length > 0 ? (
				<Row label="Built-in tools">
					<BadgeList items={draft.builtInTools} />
				</Row>
			) : null}
			{draft.schedule ? (
				<Row label="Publishes to">
					<span>{draft.project?.name ?? "No project"}</span>
					{draft.outputTitle ? (
						<span className="mt-0.5 block text-xs text-muted-foreground">
							as “{draft.outputTitle}”
						</span>
					) : null}
				</Row>
			) : draft.steps.length > 0 ? (
				<Row label="Steps">
					<ol className="list-decimal pl-4">
						{draft.steps.map((step, index) => (
							<li key={`${step.type}-${index}`}>{step.label}</li>
						))}
					</ol>
				</Row>
			) : null}
		</>
	);
}

/**
 * What sits inside the chat's approval card between its title and its
 * buttons: the draft for a workflow the person is creating, the plain
 * arguments for any other tool, anything that would stop it going live, and
 * what approving does in words.
 */
export function ConfirmationDetails({
	request,
}: {
	request: ChatConfirmationRequest;
}) {
	const draft = request.workflowDraft;
	const argumentRows =
		draft || request.workflowAction ? [] : summarizeArguments(request.args);

	return (
		<div className="mt-3 space-y-3">
			{draft || argumentRows.length > 0 ? (
				<dl className="space-y-3">
					{draft ? <WorkflowDraftRows draft={draft} /> : null}
					{argumentRows.map(([name, value]) => (
						<Row key={name} label={name}>
							{value}
						</Row>
					))}
				</dl>
			) : null}
			{draft && draft.problems.length > 0 ? (
				<div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
					<p className="flex items-center gap-2 text-xs font-medium text-destructive">
						<AlertTriangle
							className="size-3.5"
							aria-hidden="true"
						/>
						Fix this before it can go live
					</p>
					<ul className="mt-1.5 list-disc pl-5 text-xs text-foreground">
						{draft.problems.map((problem) => (
							<li key={problem}>{problem}</li>
						))}
					</ul>
				</div>
			) : null}
			<p className="text-xs text-muted-foreground">
				{describeConsequence(request)}
			</p>
		</div>
	);
}
