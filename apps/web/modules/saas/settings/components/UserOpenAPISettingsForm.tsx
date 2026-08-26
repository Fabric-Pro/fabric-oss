"use client";

import { SettingsItem } from "@saas/shared/components/SettingsItem";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { SearchInput } from "@ui/components/search-input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Switch } from "@ui/components/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import {
	ExternalLinkIcon,
	EyeIcon,
	EyeOffIcon,
	LoaderIcon,
	PlayIcon,
	PlusIcon,
	RefreshCwIcon,
	SearchIcon,
	Settings2Icon,
	TrashIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { OpenAPIToolTestDialog } from "./OpenAPIToolTestDialog";

interface OpenAPIService {
	id: string;
	name: string;
	description: string | null;
	specUrl: string;
	baseUrl: string | null;
	status: "ACTIVE" | "INACTIVE" | "ERROR" | "SYNCING";
	authType: "NONE" | "API_KEY" | "BEARER" | "BASIC" | "OAUTH2";
	toolCount: number;
	lastSyncedAt: string | null;
	errorMessage: string | null;
	tools?: Array<{
		id: string;
		name: string;
		description: string | null;
		method: string;
		path: string;
		enabled: boolean;
	}>;
}

export function UserOpenAPISettingsForm() {
	const qc = useQueryClient();
	const [addDialogOpen, setAddDialogOpen] = useState(false);
	const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
	const [configDialogOpen, setConfigDialogOpen] = useState(false);
	const [selectedService, setSelectedService] =
		useState<OpenAPIService | null>(null);
	const [searchQuery, setSearchQuery] = useState("");

	// Form state for adding service
	const [specUrl, setSpecUrl] = useState("");
	const [serviceName, setServiceName] = useState("");
	const [authType, setAuthType] = useState<
		"NONE" | "API_KEY" | "BEARER" | "BASIC"
	>("NONE");
	const [authKey, setAuthKey] = useState("");
	const [authValue, setAuthValue] = useState("");
	const [showAuthValue, setShowAuthValue] = useState(false);

	// Query for listing services
	const { data: services, isLoading } = useQuery({
		queryKey: ["openapi-services"],
		queryFn: async () => await orpcClient.openapi.services.list({}),
	});

	// Mutations
	const onboardMutation = useMutation({
		mutationFn: async (input: {
			specUrl: string;
			name: string;
			authType?: "NONE" | "API_KEY" | "BEARER" | "BASIC" | "OAUTH2";
			authKey?: string;
			authValue?: string;
			authLocation?: "HEADER" | "QUERY" | "COOKIE";
		}) => await orpcClient.openapi.services.onboard(input),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["openapi-services"] });
			toast.success("OpenAPI service added successfully");
			resetForm();
			setAddDialogOpen(false);
		},
		onError: (error: Error) => {
			toast.error(`Failed to add service: ${error.message}`);
		},
	});

	const deleteMutation = useMutation({
		mutationFn: async (input: { id: string }) =>
			await orpcClient.openapi.services.delete(input),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["openapi-services"] });
			toast.success("Service deleted");
			setDeleteDialogOpen(false);
			setSelectedService(null);
		},
		onError: (error: Error) => {
			toast.error(`Failed to delete: ${error.message}`);
		},
	});

	const syncMutation = useMutation({
		mutationFn: async (input: { id: string }) =>
			await orpcClient.openapi.services.sync(input),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["openapi-services"] });
			toast.success("Service synced successfully");
		},
		onError: (error: Error) => {
			toast.error(`Sync failed: ${error.message}`);
		},
	});

	const resetForm = () => {
		setSpecUrl("");
		setServiceName("");
		setAuthType("NONE");
		setAuthKey("");
		setAuthValue("");
		setShowAuthValue(false);
	};

	const handleAddService = () => {
		if (!specUrl) {
			toast.error("Please enter a spec URL");
			return;
		}
		onboardMutation.mutate({
			specUrl,
			name: serviceName || "New API Service",
			authType,
			authKey: authKey || undefined,
			authValue: authValue || undefined,
			authLocation: authType === "API_KEY" ? "HEADER" : undefined,
		});
	};

	const filteredServices = (services ?? []).filter(
		(s: OpenAPIService) =>
			s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
			s.specUrl.toLowerCase().includes(searchQuery.toLowerCase()),
	);

	const getStatusBadge = (status: string, errorMessage: string | null) => {
		switch (status) {
			case "ACTIVE":
				return (
					<Badge variant="default" className="bg-success">
						Active
					</Badge>
				);
			case "SYNCING":
				return <Badge variant="secondary">Syncing...</Badge>;
			case "ERROR":
				return (
					<Tooltip>
						<TooltipTrigger>
							<Badge variant="destructive">Error</Badge>
						</TooltipTrigger>
						<TooltipContent>
							{errorMessage || "Unknown error"}
						</TooltipContent>
					</Tooltip>
				);
			default:
				return <Badge variant="outline">Inactive</Badge>;
		}
	};

	return (
		<TooltipProvider>
			<SettingsItem
				title="OpenAPI Services"
				description="Connect external APIs by providing their OpenAPI specification URL"
			>
				{/* Search and Add */}
				<div className="flex gap-2 mb-4">
					<div className="relative flex-1">
						<SearchIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
						<SearchInput
							placeholder="Search services..."
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							className="pl-9"
						/>
					</div>
					<Button onClick={() => setAddDialogOpen(true)}>
						<PlusIcon className="h-4 w-4 mr-2" />
						Add Service
					</Button>
				</div>

				{/* Services List */}
				{isLoading ? (
					<div className="flex justify-center py-8">
						<LoaderIcon className="h-6 w-6 animate-spin text-muted-foreground" />
					</div>
				) : filteredServices.length === 0 ? (
					<Card className="p-8 text-center">
						<p className="text-muted-foreground">
							{searchQuery
								? "No services match your search"
								: "No OpenAPI services connected yet"}
						</p>
						<Button
							variant="link"
							onClick={() => setAddDialogOpen(true)}
						>
							Add your first service
						</Button>
					</Card>
				) : (
					<div className="space-y-3">
						{filteredServices.map((service: OpenAPIService) => (
							<Card key={service.id} className="p-4">
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-3">
										<div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
											<ExternalLinkIcon className="h-5 w-5 text-primary" />
										</div>
										<div>
											<div className="flex items-center gap-2">
												<span className="font-medium">
													{service.name}
												</span>
												{getStatusBadge(
													service.status,
													service.errorMessage,
												)}
											</div>
											<p className="text-sm text-muted-foreground truncate max-w-md">
												{service.specUrl}
											</p>
										</div>
									</div>
									<div className="flex items-center gap-2">
										<Badge variant="outline">
											{service.toolCount} tools
										</Badge>
										<Tooltip>
											<TooltipTrigger asChild>
												<Button
													variant="ghost"
													size="icon"
													onClick={() =>
														syncMutation.mutate({
															id: service.id,
														})
													}
													disabled={
														syncMutation.isPending
													}
												>
													<RefreshCwIcon
														className={`h-4 w-4 ${syncMutation.isPending ? "animate-spin" : ""}`}
													/>
												</Button>
											</TooltipTrigger>
											<TooltipContent>
												Sync tools from spec
											</TooltipContent>
										</Tooltip>
										<Tooltip>
											<TooltipTrigger asChild>
												<Button
													variant="ghost"
													size="icon"
													onClick={() => {
														setSelectedService(
															service,
														);
														setConfigDialogOpen(
															true,
														);
													}}
												>
													<Settings2Icon className="h-4 w-4" />
												</Button>
											</TooltipTrigger>
											<TooltipContent>
												Configure tools
											</TooltipContent>
										</Tooltip>
										<Tooltip>
											<TooltipTrigger asChild>
												<Button
													variant="ghost"
													size="icon"
													onClick={() => {
														setSelectedService(
															service,
														);
														setDeleteDialogOpen(
															true,
														);
													}}
												>
													<TrashIcon className="h-4 w-4 text-destructive" />
												</Button>
											</TooltipTrigger>
											<TooltipContent>
												Delete service
											</TooltipContent>
										</Tooltip>
									</div>
								</div>
							</Card>
						))}
					</div>
				)}
			</SettingsItem>

			{/* Add Service Dialog */}
			<Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
				<DialogContent className="max-w-lg">
					<DialogHeader>
						<DialogTitle>Add OpenAPI Service</DialogTitle>
					</DialogHeader>
					<div className="space-y-4 py-4">
						<div className="space-y-2">
							<Label htmlFor="specUrl">OpenAPI Spec URL *</Label>
							<Input
								id="specUrl"
								placeholder="https://api.example.com/openapi.json"
								value={specUrl}
								onChange={(e) => setSpecUrl(e.target.value)}
							/>
							<p className="text-xs text-muted-foreground">
								URL to OpenAPI 3.x JSON or YAML specification
							</p>
						</div>
						<div className="space-y-2">
							<Label htmlFor="serviceName">Service Name</Label>
							<Input
								id="serviceName"
								placeholder="My API Service"
								value={serviceName}
								onChange={(e) => setServiceName(e.target.value)}
							/>
						</div>
						<div className="space-y-2">
							<Label>Authentication</Label>
							<Select
								value={authType}
								onValueChange={(v) =>
									setAuthType(v as typeof authType)
								}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="NONE">
										No Authentication
									</SelectItem>
									<SelectItem value="API_KEY">
										API Key
									</SelectItem>
									<SelectItem value="BEARER">
										Bearer Token
									</SelectItem>
									<SelectItem value="BASIC">
										Basic Auth
									</SelectItem>
								</SelectContent>
							</Select>
						</div>
						{authType !== "NONE" && (
							<>
								{authType === "API_KEY" && (
									<div className="space-y-2">
										<Label htmlFor="authKey">
											Header Name
										</Label>
										<Input
											id="authKey"
											placeholder="X-API-Key"
											value={authKey}
											onChange={(e) =>
												setAuthKey(e.target.value)
											}
										/>
									</div>
								)}
								<div className="space-y-2">
									<Label htmlFor="authValue">
										{authType === "API_KEY"
											? "API Key"
											: authType === "BEARER"
												? "Token"
												: "Password"}
									</Label>
									<div className="relative">
										<Input
											id="authValue"
											type={
												showAuthValue
													? "text"
													: "password"
											}
											value={authValue}
											onChange={(e) =>
												setAuthValue(e.target.value)
											}
										/>
										<Button
											variant="ghost"
											size="icon"
											type="button"
											className="absolute right-0 top-0 h-full"
											onClick={() =>
												setShowAuthValue(!showAuthValue)
											}
										>
											{showAuthValue ? (
												<EyeOffIcon className="h-4 w-4" />
											) : (
												<EyeIcon className="h-4 w-4" />
											)}
										</Button>
									</div>
								</div>
							</>
						)}
					</div>
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setAddDialogOpen(false)}
						>
							Cancel
						</Button>
						<Button
							onClick={handleAddService}
							disabled={onboardMutation.isPending}
						>
							{onboardMutation.isPending && (
								<LoaderIcon className="h-4 w-4 mr-2 animate-spin" />
							)}
							Add Service
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Delete Confirmation Dialog */}
			<AlertDialog
				open={deleteDialogOpen}
				onOpenChange={setDeleteDialogOpen}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							Delete OpenAPI Service?
						</AlertDialogTitle>
						<AlertDialogDescription>
							This will delete "{selectedService?.name}" and all
							its tools. This action cannot be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() =>
								selectedService &&
								deleteMutation.mutate({
									id: selectedService.id,
								})
							}
							variant="destructive"
						>
							{deleteMutation.isPending && (
								<LoaderIcon className="h-4 w-4 mr-2 animate-spin" />
							)}
							Delete
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			{/* Tool Configuration Dialog */}
			<ToolConfigDialog
				service={selectedService}
				open={configDialogOpen}
				onOpenChange={setConfigDialogOpen}
			/>
		</TooltipProvider>
	);
}

// Tool Configuration Dialog Component
interface ToolData {
	id: string;
	name: string;
	description: string | null;
	method: string;
	path: string;
	enabled: boolean;
	parametersSchema: unknown;
	requestBodySchema: unknown;
}

function ToolConfigDialog({
	service,
	open,
	onOpenChange,
}: {
	service: OpenAPIService | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const qc = useQueryClient();
	const [testDialogOpen, setTestDialogOpen] = useState(false);
	const [selectedTool, setSelectedTool] = useState<ToolData | null>(null);

	// Fetch tools for this service
	const { data: tools, isLoading } = useQuery({
		queryKey: ["openapi-tools", service?.id],
		queryFn: async () =>
			service
				? await orpcClient.openapi.tools.listForService({
						serviceId: service.id,
					})
				: [],
		enabled: !!service && open,
	});

	const toggleMutation = useMutation({
		mutationFn: async (input: { id: string; enabled: boolean }) =>
			await orpcClient.openapi.tools.setEnabled(input),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["openapi-tools", service?.id] });
		},
	});

	if (!service) {
		return null;
	}

	return (
		<>
			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
					<DialogHeader>
						<DialogTitle>
							Configure Tools: {service.name}
						</DialogTitle>
					</DialogHeader>
					<div className="py-4">
						{isLoading ? (
							<div className="flex justify-center py-8">
								<LoaderIcon className="h-6 w-6 animate-spin" />
							</div>
						) : !tools || tools.length === 0 ? (
							<p className="text-center text-muted-foreground py-8">
								No tools available
							</p>
						) : (
							<div className="space-y-2">
								{tools.map((tool: ToolData) => (
									<div
										key={tool.id}
										className="flex items-center justify-between p-3 border rounded-lg"
									>
										<div className="flex-1 min-w-0">
											<div className="flex items-center gap-2">
												<Badge
													variant="outline"
													className="font-mono text-xs"
												>
													{tool.method}
												</Badge>
												<span className="font-medium truncate">
													{tool.name}
												</span>
											</div>
											<p className="text-sm text-muted-foreground truncate">
												{tool.path}
											</p>
											{tool.description && (
												<p className="text-xs text-muted-foreground line-clamp-1 mt-1">
													{tool.description}
												</p>
											)}
										</div>
										<div className="flex items-center gap-2">
											<Tooltip>
												<TooltipTrigger asChild>
													<Button
														variant="ghost"
														size="icon"
														onClick={() => {
															setSelectedTool(
																tool,
															);
															setTestDialogOpen(
																true,
															);
														}}
													>
														<PlayIcon className="h-4 w-4" />
													</Button>
												</TooltipTrigger>
												<TooltipContent>
													Test tool
												</TooltipContent>
											</Tooltip>
											<Switch
												checked={tool.enabled}
												onCheckedChange={(checked) =>
													toggleMutation.mutate({
														id: tool.id,
														enabled: checked,
													})
												}
												disabled={
													toggleMutation.isPending
												}
											/>
										</div>
									</div>
								))}
							</div>
						)}
					</div>
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => onOpenChange(false)}
						>
							Done
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<OpenAPIToolTestDialog
				tool={selectedTool}
				open={testDialogOpen}
				onOpenChange={setTestDialogOpen}
			/>
		</>
	);
}
