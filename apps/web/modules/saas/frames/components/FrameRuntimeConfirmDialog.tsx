"use client";

import {
	describeToolPhrase,
	summarizeArguments,
} from "@saas/agents/lib/chat-confirmation";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ui/components/alert-dialog";
import { cn } from "@ui/lib";
import { useRef } from "react";
import type { PendingCall } from "../hooks/use-frame-runtime-bridge";
import { formatFileSize } from "../lib/page-download";

/**
 * The question a page's script raises when it asks Fabric for something that
 * is not a plain read: the page is somebody's code, the call would run as the
 * viewer, so the viewer says yes or no. It names the action in the chat's own
 * words and shows every value the call carries, nested ones under their path.
 *
 * A yes to a tool covers it on this version of the page for the browser session,
 * whatever values it is later called with, except where the page is asked about
 * on every call: a page that has read outside its own store, or one that keeps
 * shared data and asks for another kind of change. A file a page offers is asked
 * about each time. Sensitive reads also ask before reaching the viewer's accounts.
 */

function Row({
	name,
	value,
	muted = false,
}: {
	name: string;
	value: string;
	muted?: boolean;
}) {
	return (
		<div className="grid gap-0.5 sm:grid-cols-[8rem_1fr] sm:gap-3">
			<dt className="min-w-0 break-words text-xs text-muted-foreground">
				{name}
			</dt>
			<dd
				className={cn(
					"min-w-0 break-words font-mono text-xs",
					muted ? "text-muted-foreground" : "text-foreground",
				)}
			>
				{value}
			</dd>
		</div>
	);
}

/** What the call costs beyond what its action says. A connected read says all it has to. */
const RISK: Record<string, string | null> = {
	fabric_page_ask: "which spends your AI allowance",
	fabric_page_read_connected: null,
};

function toolConsequence(call: Extract<PendingCall, { kind: "tool" }>): string {
	switch (call.because) {
		case "tainted":
			if (call.toolName === "fabric_page_ask") {
				return "This page has read information from outside itself, so it asks before each AI request.";
			}
			if (
				call.readOnly === true ||
				call.toolName === "fabric_page_read_connected"
			) {
				return "This page has read information from outside itself, so it asks before every sensitive read.";
			}
			return "This page has read information from outside itself, so it asks before every change to shared data, not only the first.";
		case "keeps-data":
			return "This page keeps shared data, so it asks every time before it makes any other change.";
		case "confirm":
			return "This action always needs your yes, so it asks every time, not only the first.";
		case undefined:
			return "If you allow it, this page can do this again, with other values, without asking until you close the tab or the page is changed.";
	}
}

export function FrameRuntimeConfirmDialog({
	call,
	pageTitle,
	onAnswer,
}: {
	call: PendingCall | null;
	pageTitle: string;
	onAnswer: (allowed: boolean) => void;
}) {
	// The dialog fades out after the answer, when there is no call any more:
	// it keeps showing the last one until it has gone, not an empty box.
	const lastCall = useRef(call);
	if (call) {
		lastCall.current = call;
	}
	const shown = call ?? lastCall.current;
	return (
		<AlertDialog
			open={call !== null}
			onOpenChange={(open) => {
				if (!open) {
					onAnswer(false);
				}
			}}
		>
			<AlertDialogContent className="max-h-[90dvh] overflow-y-auto">
				{shown?.kind === "download" ? (
					<DownloadQuestion
						download={shown.download}
						pageTitle={pageTitle}
						onAnswer={onAnswer}
					/>
				) : shown ? (
					<ToolQuestion
						call={shown}
						pageTitle={pageTitle}
						onAnswer={onAnswer}
					/>
				) : null}
			</AlertDialogContent>
		</AlertDialog>
	);
}

function ToolQuestion({
	call,
	pageTitle,
	onAnswer,
}: {
	call: Extract<PendingCall, { kind: "tool" }>;
	pageTitle: string;
	onAnswer: (allowed: boolean) => void;
}) {
	const action = describeToolPhrase(call.toolName);
	const risk =
		call.toolName in RISK
			? RISK[call.toolName]
			: call.readOnly === true
				? "which reads data without changing it"
				: "which can change data in Fabric";
	return (
		<>
			<AlertDialogHeader>
				<AlertDialogTitle>
					Allow this page to {action}?
				</AlertDialogTitle>
				<AlertDialogDescription>
					&ldquo;{pageTitle}&rdquo; is asking to {action} as you
					{risk ? `, ${risk}` : ""}. {toolConsequence(call)}
				</AlertDialogDescription>
			</AlertDialogHeader>
			<dl className="max-h-72 space-y-2 overflow-y-auto rounded-md border border-border bg-muted p-3">
				{summarizeArguments(call.args).map(([name, value]) => (
					<Row key={name} name={name} value={value} />
				))}
				<Row name="Fabric tool" value={call.toolName} muted />
			</dl>
			<AlertDialogFooter>
				<AlertDialogCancel onClick={() => onAnswer(false)}>
					Don&rsquo;t allow
				</AlertDialogCancel>
				<AlertDialogAction onClick={() => onAnswer(true)}>
					Allow
				</AlertDialogAction>
			</AlertDialogFooter>
		</>
	);
}

function DownloadQuestion({
	download,
	pageTitle,
	onAnswer,
}: {
	download: Extract<PendingCall, { kind: "download" }>["download"];
	pageTitle: string;
	onAnswer: (allowed: boolean) => void;
}) {
	const size = formatFileSize(download.bytes);
	return (
		<>
			<AlertDialogHeader>
				<AlertDialogTitle className="break-words">
					Save {download.filename}, {size}?
				</AlertDialogTitle>
				<AlertDialogDescription>
					&ldquo;{pageTitle}&rdquo; wants to save a file to your
					device. It is saved as a download and not opened; open it
					only if you trust this page.
				</AlertDialogDescription>
			</AlertDialogHeader>
			<dl className="space-y-2 rounded-md border border-border bg-muted p-3">
				<Row name="File name" value={download.filename} />
				<Row name="Type" value={download.mimeType} />
				<Row name="Size" value={size} />
			</dl>
			<AlertDialogFooter>
				<AlertDialogCancel onClick={() => onAnswer(false)}>
					Don&rsquo;t save
				</AlertDialogCancel>
				<AlertDialogAction onClick={() => onAnswer(true)}>
					Save
				</AlertDialogAction>
			</AlertDialogFooter>
		</>
	);
}
