"use client";

import { useOrganizationId } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import { Label } from "@ui/components/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import { ScrollArea } from "@ui/components/scroll-area";
import { ChevronsUpDownIcon, ServerIcon, XIcon } from "lucide-react";
import { useState } from "react";

interface McpServerSelectorProps {
	value?: string[];
	onChange: (value: string[]) => void;
	placeholder?: string;
}

export function McpServerSelector({
	value = [],
	onChange,
	placeholder = "Select MCP servers...",
}: McpServerSelectorProps) {
	const [open, setOpen] = useState(false);
	const organizationId = useOrganizationId();

	// Fetch MCP configs
	const { data: mcpConfigs, isLoading } = useQuery({
		queryKey: ["mcpConfigs", organizationId],
		queryFn: async () => {
			return await orpcClient.mcp.configs.list({
				organizationId: organizationId ?? undefined,
			});
		},
	});

	// Filter enabled configs
	const enabledConfigs = (mcpConfigs || []).filter(
		(config: any) => config.enabled,
	);

	// Get selected configs
	const selectedConfigs = enabledConfigs.filter((config: any) =>
		value.includes(config.id),
	);

	const toggleConfig = (configId: string) => {
		const newValue = value.includes(configId)
			? value.filter((id) => id !== configId)
			: [...value, configId];
		onChange(newValue);
	};

	const removeConfig = (configId: string) => {
		onChange(value.filter((id) => id !== configId));
	};

	return (
		<div className="space-y-2">
			<Label>MCP Servers</Label>
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger asChild>
					<Button
						variant="outline"
						role="combobox"
						aria-expanded={open}
						className="w-full justify-between font-normal"
					>
						<span className="truncate">
							{selectedConfigs.length === 0
								? placeholder
								: `${selectedConfigs.length} server${selectedConfigs.length > 1 ? "s" : ""} selected`}
						</span>
						<ChevronsUpDownIcon className="ml-2 h-4 w-4 shrink-0 opacity-50" />
					</Button>
				</PopoverTrigger>
				<PopoverContent className="w-full p-0" align="start">
					<ScrollArea className="h-[200px] p-4">
						{isLoading ? (
							<div className="text-sm text-muted-foreground">
								Loading MCP servers...
							</div>
						) : enabledConfigs.length === 0 ? (
							<div className="text-sm text-muted-foreground">
								No MCP servers configured.
							</div>
						) : (
							<div className="space-y-3">
								{enabledConfigs.map((config: any) => {
									const isSelected = value.includes(
										config.id,
									);
									return (
										<div
											key={config.id}
											className="flex items-start gap-2"
										>
											<Checkbox
												id={config.id}
												checked={isSelected}
												onCheckedChange={() =>
													toggleConfig(config.id)
												}
											/>
											<label
												htmlFor={config.id}
												className="flex-1 cursor-pointer"
											>
												<div className="flex items-center gap-2">
													<ServerIcon className="h-4 w-4 text-muted-foreground" />
													<div className="flex-1 min-w-0">
														<div className="font-medium text-sm truncate">
															{config.displayName ||
																config.mcpServer
																	?.name ||
																"Unnamed Server"}
														</div>
														{config.mcpServer
															?.key && (
															<div className="text-xs text-muted-foreground truncate">
																{
																	config
																		.mcpServer
																		.key
																}
															</div>
														)}
													</div>
												</div>
											</label>
										</div>
									);
								})}
							</div>
						)}
					</ScrollArea>
				</PopoverContent>
			</Popover>

			{/* Selected servers chips */}
			{selectedConfigs.length > 0 && (
				<div className="flex flex-wrap gap-2 mt-2">
					{selectedConfigs.map((config: any) => (
						<div
							key={config.id}
							className="inline-flex items-center gap-1 px-2 py-1 bg-secondary text-secondary-foreground rounded-md text-sm"
						>
							<ServerIcon className="h-3 w-3" />
							<span className="truncate max-w-[200px]">
								{config.displayName ||
									config.mcpServer?.name ||
									"Unnamed Server"}
							</span>
							<button
								type="button"
								onClick={() => removeConfig(config.id)}
								className="ml-1 hover:bg-secondary-foreground/10 rounded-sm p-0.5"
							>
								<XIcon className="h-3 w-3" />
							</button>
						</div>
					))}
				</div>
			)}

			<p className="text-xs text-muted-foreground">
				Select one or more MCP servers to use their tools in this
				workflow. Tools will be available at runtime.
			</p>
		</div>
	);
}
