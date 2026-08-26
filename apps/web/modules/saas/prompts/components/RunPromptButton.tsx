"use client";

import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { Clipboard, ExternalLink, Play, Zap } from "lucide-react";
import { useCallback, useState } from "react";

interface Platform {
	id: string;
	name: string;
	baseUrl: string;
	supportsQuerystring?: boolean;
}

// Chat platforms (AI assistants)
const chatPlatforms: Platform[] = [
	{ id: "chatgpt", name: "ChatGPT", baseUrl: "https://chatgpt.com" },
	{ id: "claude", name: "Claude", baseUrl: "https://claude.ai/new" },
	{
		id: "gemini",
		name: "Gemini",
		baseUrl: "https://gemini.google.com/app",
		supportsQuerystring: false,
	},
	{
		id: "perplexity",
		name: "Perplexity",
		baseUrl: "https://www.perplexity.ai",
	},
	{
		id: "copilot",
		name: "Microsoft Copilot",
		baseUrl: "https://copilot.microsoft.com",
		supportsQuerystring: false,
	},
	{
		id: "deepseek",
		name: "DeepSeek",
		baseUrl: "https://chat.deepseek.com",
		supportsQuerystring: false,
	},
	{
		id: "mistral",
		name: "Le Chat (Mistral)",
		baseUrl: "https://chat.mistral.ai/chat",
	},
	{
		id: "huggingface",
		name: "HuggingChat",
		baseUrl: "https://huggingface.co/chat",
	},
	{
		id: "poe",
		name: "Poe",
		baseUrl: "https://poe.com",
		supportsQuerystring: false,
	},
];

// Code platforms (IDEs + code generation tools)
const codePlatforms: Platform[] = [
	{
		id: "cursor",
		name: "Cursor",
		baseUrl: "cursor://anysphere.cursor-deeplink/prompt",
	},
	{ id: "bolt", name: "Bolt", baseUrl: "https://bolt.new" },
	{ id: "v0", name: "v0", baseUrl: "https://v0.dev/chat" },
	{ id: "lovable", name: "Lovable", baseUrl: "https://lovable.dev" },
	{
		id: "github-copilot",
		name: "GitHub Copilot",
		baseUrl: "https://github.com/copilot",
	},
];

function buildUrl(
	platformId: string,
	baseUrl: string,
	promptText: string,
): string {
	const encoded = encodeURIComponent(promptText);

	switch (platformId) {
		case "cursor":
			return `${baseUrl}?text=${encoded}`;
		case "bolt":
			return `${baseUrl}?prompt=${encoded}`;
		case "chatgpt":
			return `${baseUrl}/?q=${encoded}`;
		case "claude":
			return `${baseUrl}?q=${encoded}`;
		case "github-copilot":
			return `${baseUrl}?prompt=${encoded}`;
		case "huggingface":
			return `${baseUrl}/?prompt=${encoded}`;
		case "lovable":
			return `${baseUrl}/?autosubmit=true#prompt=${encoded}`;
		case "mistral":
			return `${baseUrl}?q=${encoded}`;
		case "perplexity":
			return `${baseUrl}/search?q=${encoded}`;
		case "v0":
			return `${baseUrl}?q=${encoded}`;
		default:
			return `${baseUrl}?q=${encoded}`;
	}
}

interface RunPromptButtonProps {
	content: string;
	variant?: "default" | "ghost" | "outline";
	size?: "default" | "sm" | "icon";
	className?: string;
	emphasized?: boolean;
}

export function RunPromptButton({
	content,
	variant = "default",
	size = "sm",
	className,
	emphasized = false,
}: RunPromptButtonProps) {
	const [dialogOpen, setDialogOpen] = useState(false);
	const [activeTab, setActiveTab] = useState<"chat" | "code">("chat");
	const [pendingPlatform, setPendingPlatform] = useState<Platform | null>(
		null,
	);

	const handleRun = useCallback(
		(platform: Platform) => {
			if (platform.supportsQuerystring === false) {
				navigator.clipboard.writeText(content);
				setPendingPlatform(platform);
				setDialogOpen(true);
			} else {
				const url = buildUrl(platform.id, platform.baseUrl, content);
				window.open(url, "_blank");
			}
		},
		[content],
	);

	const handleOpenPlatform = () => {
		if (pendingPlatform) {
			window.open(pendingPlatform.baseUrl, "_blank");
			setDialogOpen(false);
			setPendingPlatform(null);
		}
	};

	const activePlatforms =
		activeTab === "code" ? codePlatforms : chatPlatforms;

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant={emphasized ? "default" : variant}
						size={size}
						className={
							emphasized
								? `bg-green-600 hover:bg-green-700 text-white ${className || ""}`
								: className
						}
					>
						<Play className="h-4 w-4" />
						{size !== "icon" && <span className="ml-1.5">Run</span>}
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-52">
					{/* Tab buttons */}
					<div className="p-1">
						<div className="flex gap-1 p-1 bg-muted rounded-md">
							<button
								type="button"
								onClick={() => setActiveTab("chat")}
								className={`flex-1 px-2 py-1 text-xs font-medium rounded transition-colors ${
									activeTab === "chat"
										? "bg-background text-foreground shadow-sm"
										: "text-muted-foreground hover:text-foreground"
								}`}
							>
								Chat
							</button>
							<button
								type="button"
								onClick={() => setActiveTab("code")}
								className={`flex-1 px-2 py-1 text-xs font-medium rounded transition-colors ${
									activeTab === "code"
										? "bg-background text-foreground shadow-sm"
										: "text-muted-foreground hover:text-foreground"
								}`}
							>
								Code
							</button>
						</div>
					</div>
					<DropdownMenuSeparator />
					<div className="max-h-64 overflow-y-auto">
						{activePlatforms.map((platform) => (
							<DropdownMenuItem
								key={platform.id}
								onClick={() => handleRun(platform)}
								className="flex items-center gap-2"
							>
								{platform.supportsQuerystring === false ? (
									<Clipboard className="h-3 w-3 text-muted-foreground" />
								) : (
									<Zap className="h-3 w-3 text-success" />
								)}
								{platform.name}
							</DropdownMenuItem>
						))}
					</div>
				</DropdownMenuContent>
			</DropdownMenu>

			{/* Dialog for platforms that don't support query strings */}
			<Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Prompt Copied</DialogTitle>
						<DialogDescription>
							The prompt has been copied to your clipboard. Click
							below to open {pendingPlatform?.name} and paste it.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setDialogOpen(false)}
						>
							Cancel
						</Button>
						<Button onClick={handleOpenPlatform}>
							<ExternalLink className="h-4 w-4 mr-2" />
							Open {pendingPlatform?.name}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
