"use client";

import { parseConnectedDeclaration } from "@repo/temporal/fabric-page-tool-definitions";
import { describeToolPhrase } from "@saas/agents/lib/chat-confirmation";
import { DuplicatedFrameSchema } from "@saas/frames/lib/frame-tool-types";
import { callFabricTool } from "@saas/mcp/lib/fabric-tool-client";
import { userMessageOf } from "@saas/shared/lib/user-message-of";
import { useMutation } from "@tanstack/react-query";
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
import { Button } from "@ui/components/button";
import { useToast } from "@ui/hooks/use-toast";
import { CopyIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Makes a copy of a Workspace that belongs to the person asking, who can then
 * change it freely. Fabric keeps the page's surface and project; what people
 * saved in the page is not copied. The page's script can reach Fabric only
 * through the tools it declared, so a copy that is to keep working has to carry
 * them, and the person is asked before that happens.
 */
/** A declared tool in words: "List workflows", or what a connected read reaches. */
function toolLabel(entry: string): string {
	const connected = parseConnectedDeclaration(entry);
	const phrase = connected
		? `read ${connected.tool} from ${connected.provider}`
		: describeToolPhrase(entry);
	return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

export function WorkspaceCopyButton({
	frameId,
	organizationId,
	organizationSlug,
	projectId,
	runtimeTools,
}: {
	frameId: string;
	organizationId: string;
	organizationSlug: string;
	/** The project the page belongs to, when it belongs to one; its copy stays in it. */
	projectId?: string;
	runtimeTools: readonly string[];
}) {
	const router = useRouter();
	const { toast } = useToast();
	const [open, setOpen] = useState(false);

	const copy = useMutation({
		mutationFn: () =>
			callFabricTool(
				"fabric_duplicate_frame",
				{
					frameId,
					...(runtimeTools.length > 0 ? { runtimeTools } : {}),
				},
				{ organizationId, schema: DuplicatedFrameSchema },
			),
		onSuccess: (copied) => {
			setOpen(false);
			toast({ title: "Copy made" });
			router.push(
				`/app/${organizationSlug}/workspaces/${copied.frameId}`,
			);
		},
		onError: (error) => {
			toast({
				title: "Could not make a copy",
				description: userMessageOf(error, "Please try again."),
				variant: "destructive",
			});
		},
	});

	return (
		<>
			<Button variant="outline" size="sm" onClick={() => setOpen(true)}>
				<CopyIcon className="mr-2 size-4" aria-hidden />
				Make a copy
			</Button>
			<AlertDialog
				open={open}
				onOpenChange={(next) => {
					// Esc and a click outside leave a copy being made alone.
					if (!next && copy.isPending) {
						return;
					}
					setOpen(next);
				}}
			>
				<AlertDialogContent className="max-h-[90dvh] overflow-y-auto">
					<AlertDialogHeader>
						<AlertDialogTitle>
							Make a copy of this workspace?
						</AlertDialogTitle>
						<AlertDialogDescription>
							You get your own copy to change
							{projectId ? ", in the same project" : ""}. What
							people saved in the page is not copied.
							{runtimeTools.length > 0
								? " The copy can use the same Fabric tools as this page, running as the person who opens it."
								: ""}
						</AlertDialogDescription>
					</AlertDialogHeader>
					{runtimeTools.length > 0 ? (
						<ul className="max-h-48 space-y-2 overflow-y-auto rounded-md border border-border bg-muted p-3 text-sm text-foreground">
							{runtimeTools.map((tool) => (
								<li key={tool} className="break-words">
									{toolLabel(tool)}
									<span className="block font-mono text-xs text-muted-foreground">
										{tool}
									</span>
								</li>
							))}
						</ul>
					) : null}
					<AlertDialogFooter>
						<AlertDialogCancel disabled={copy.isPending}>
							Cancel
						</AlertDialogCancel>
						<AlertDialogAction
							disabled={copy.isPending}
							onClick={(event) => {
								event.preventDefault();
								copy.mutate();
							}}
						>
							{copy.isPending
								? "Making a copy..."
								: "Make a copy"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
