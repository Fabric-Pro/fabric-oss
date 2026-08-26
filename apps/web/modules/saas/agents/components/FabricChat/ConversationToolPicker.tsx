"use client";

import { AlwaysOnPill } from "@saas/mcp/components/AlwaysOnPill";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { ScrollArea } from "@ui/components/scroll-area";
import { TooltipProvider } from "@ui/components/tooltip";
import { Settings2, Wrench } from "lucide-react";

interface ConversationToolPickerProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	organizationId?: string;
	selectedIds: string[] | null;
	onChange: (ids: string[] | null) => void;
}

export function ConversationToolPicker({
	open,
	onOpenChange,
	organizationId,
	selectedIds,
	onChange,
}: ConversationToolPickerProps) {
	const configsQuery = useQuery({
		queryKey: ["conversation-tool-picker", organizationId],
		queryFn: async () => {
			if (organizationId) {
				return orpcClient.mcp.configs.list({ organizationId });
			}

			return orpcClient.mcp.configs.list();
		},
		enabled: open,
	});

	const configs = configsQuery.data ?? [];
	const selectedSet = new Set(selectedIds ?? []);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Conversation Tools</DialogTitle>
					<DialogDescription>
						Choose which MCP connections this chat can use. Default
						mode keeps the chat aligned with the agent or
						account-level configuration. If you select specific
						connections here, only those MCP configs will be used
						for this conversation.
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-wrap items-center gap-2">
					<Button
						variant="outline"
						size="sm"
						onClick={() => onChange(null)}
					>
						<Settings2 className="mr-2 h-4 w-4" />
						Use defaults
					</Button>
					<Button
						variant="outline"
						size="sm"
						onClick={() => onChange([])}
					>
						<Wrench className="mr-2 h-4 w-4" />
						Disable MCP
					</Button>
					{selectedIds && (
						<Badge variant="secondary">
							{selectedIds.length} selected
						</Badge>
					)}
				</div>

				<ScrollArea className="max-h-[420px] pr-4">
					<TooltipProvider>
						<div className="space-y-3">
							{configs.map((config: any) => {
								const isManagedDefault =
									!!config.isManagedDefault;
								// Managed-default rows are always active — render
								// checked + disabled regardless of the picker's
								// selectedIds state, and never let the user
								// toggle them off. The backend unions managed
								// defaults into the tool set on every request,
								// so the UI mirrors that invariant.
								const checked = isManagedDefault
									? true
									: selectedSet.has(config.id);
								const name =
									config.name ||
									config.mcpServer?.name ||
									config.id;

								return (
									<div
										key={config.id}
										data-managed-default={
											isManagedDefault
												? "true"
												: undefined
										}
										className="flex items-start gap-3 rounded-lg border p-3"
									>
										<Checkbox
											aria-label={`Toggle ${name}`}
											checked={checked}
											disabled={isManagedDefault}
											onCheckedChange={(value) => {
												if (isManagedDefault) {
													return;
												}
												const next = new Set(
													selectedIds ?? [],
												);
												if (value) {
													next.add(config.id);
												} else {
													next.delete(config.id);
												}
												onChange(Array.from(next));
											}}
										/>
										<div className="flex-1 space-y-1">
											<div className="flex items-center gap-2">
												<span className="font-medium">
													{name}
												</span>
												{isManagedDefault && (
													<AlwaysOnPill />
												)}
											</div>
											<div className="text-sm text-muted-foreground">
												{config.description ||
													config.mcpServer
														?.description ||
													"No description available"}
											</div>
										</div>
									</div>
								);
							})}
							{!configsQuery.isLoading &&
								configs.length === 0 && (
									<div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
										No MCP connections are available in this
										context yet.
									</div>
								)}
						</div>
					</TooltipProvider>
				</ScrollArea>

				<DialogFooter className="mt-2 flex items-center justify-between gap-3 border-t pt-4">
					<p className="text-xs text-muted-foreground">
						Changes save automatically for this conversation.
					</p>
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
					>
						Done
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
