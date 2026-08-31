"use client";

/**
 * CUGA Generalist Agent Page
 *
 * Moved here from `/app/agents/cuga-generalist` when the personal route trees
 * were retired (Fizzy #1875, R1) — it had no organization counterpart to
 * redirect to.
 *
 * Detailed page for the Configurable Universal Generalist Agent (CUGA)
 * showcasing its capabilities, sub-agents, and features.
 */

import { CugaAuthenticatedChat } from "@saas/agents/components/cuga";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { useFullscreen } from "@saas/shared/contexts/FullscreenContext";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ui/components/card";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { ScrollArea } from "@ui/components/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import {
	Bot,
	Brain,
	Code2,
	Globe,
	ListTree,
	MessageSquare,
	Network,
	Play,
	Search,
	Shield,
	Sparkles,
	Target,
	Workflow,
	X,
	Zap,
} from "lucide-react";
import { useEffect, useState } from "react";

// Sub-agent definitions
const SUB_AGENTS = [
	{
		id: "chat_agent",
		name: "Chat Agent",
		icon: MessageSquare,
		description: "Handles conversational interactions and user queries",
		capabilities: [
			"Natural language understanding",
			"Context management",
			"Response generation",
		],
	},
	{
		id: "task_analyzer",
		name: "Task Analyzer",
		icon: Search,
		description:
			"Analyzes user requests to determine optimal execution strategy",
		capabilities: [
			"Intent classification",
			"Complexity assessment",
			"Resource estimation",
		],
	},
	{
		id: "task_decomposition",
		name: "Task Decomposition",
		icon: ListTree,
		description: "Breaks complex tasks into manageable subtasks",
		capabilities: [
			"Hierarchical decomposition",
			"Dependency mapping",
			"Parallel task identification",
		],
	},
	{
		id: "plan_controller",
		name: "Plan Controller",
		icon: Workflow,
		description: "Orchestrates execution of decomposed tasks",
		capabilities: [
			"Execution scheduling",
			"Progress tracking",
			"Error recovery",
		],
	},
	{
		id: "api_agent",
		name: "API Agent",
		icon: Code2,
		description: "Executes API calls and code for data operations",
		capabilities: [
			"REST/GraphQL calls",
			"Python code execution",
			"Data transformation",
		],
	},
	{
		id: "browser_planner",
		name: "Browser Planner",
		icon: Globe,
		description: "Plans browser automation sequences",
		capabilities: [
			"Navigation planning",
			"Element targeting",
			"Action sequencing",
		],
	},
	{
		id: "action_agent",
		name: "Action Agent",
		icon: Target,
		description: "Executes browser actions via Playwright",
		capabilities: [
			"Click/type/scroll",
			"Form filling",
			"Screenshot capture",
		],
	},
	{
		id: "qa_agent",
		name: "QA Agent",
		icon: Shield,
		description: "Validates task completion and output quality",
		capabilities: [
			"Result verification",
			"Quality scoring",
			"Error detection",
		],
	},
];

// Key features
const FEATURES = [
	{
		title: "Intelligent Task Decomposition",
		description:
			"Automatically breaks complex tasks into manageable subtasks with dependency tracking",
		icon: ListTree,
	},
	{
		title: "Browser Automation",
		description:
			"Full browser control via Playwright with BID-based element targeting",
		icon: Globe,
	},
	{
		title: "Code Execution Sandbox",
		description:
			"Secure Python/JavaScript execution with E2B or Docker sandboxing",
		icon: Code2,
	},
	{
		title: "Human-in-the-Loop",
		description:
			"Request human approval for high-risk actions before execution",
		icon: Shield,
	},
	{
		title: "Variables Manager",
		description:
			"Cross-task state persistence for sharing data between subtasks",
		icon: Network,
	},
	{
		title: "Multi-Agent Orchestration",
		description:
			"Coordinates multiple specialized sub-agents for complex workflows",
		icon: Workflow,
	},
];

// CUGA AG-UI wrapper URL (port 9999) for authenticated access
const CUGA_AGUI_URL =
	process.env.NEXT_PUBLIC_CUGA_AGUI_URL || "http://localhost:9999";

export default function CugaGeneralistPage() {
	const { organizationName, basePath } = useOrganizationContext();
	const { setIsFullscreen } = useFullscreen();
	const [activeTab, setActiveTab] = useState("overview");
	const [showCugaDialog, setShowCugaDialog] = useState(false);

	useEffect(() => {
		setIsFullscreen(false);
	}, [setIsFullscreen]);

	const breadcrumbItems = [
		{ label: organizationName ?? "Organization", href: basePath },
		// Was a hardcoded `/app/agents`, which is now a redirect rather than a
		// destination — built from the base path like every other crumb here.
		{ label: "Agents", href: `${basePath}/agents` },
		{ label: "CUGA Generalist" },
	];

	return (
		<div className="flex flex-col h-full">
			<div className="flex items-center justify-between px-6 py-4 border-b bg-background">
				<PageBreadcrumbs items={breadcrumbItems} />
				<div className="flex items-center gap-2">
					<Button
						variant="default"
						className="gap-2 cursor-pointer"
						onClick={() => setShowCugaDialog(true)}
					>
						<Play className="h-4 w-4" />
						Try CUGA
					</Button>
				</div>
			</div>
			<ScrollArea className="flex-1">
				<CugaContent
					activeTab={activeTab}
					setActiveTab={setActiveTab}
				/>
			</ScrollArea>

			{/* CUGA Authenticated Chat Dialog */}
			<Dialog open={showCugaDialog} onOpenChange={setShowCugaDialog}>
				<DialogContent className="max-w-[95vw] w-[1400px] h-[90vh] p-0 flex flex-col">
					<DialogHeader className="px-4 py-3 border-b flex flex-row items-center justify-between shrink-0">
						<DialogTitle className="flex items-center gap-2">
							<Bot className="h-5 w-5" />
							CUGA - Configurable Universal Generalist Agent
						</DialogTitle>
						<Button
							variant="ghost"
							size="icon"
							onClick={() => setShowCugaDialog(false)}
							className="h-8 w-8"
						>
							<X className="h-4 w-4" />
						</Button>
					</DialogHeader>
					<div className="flex-1 min-h-0">
						<CugaAuthenticatedChat
							agentUrl={CUGA_AGUI_URL}
							className="h-full"
						/>
					</div>
				</DialogContent>
			</Dialog>
		</div>
	);
}

interface CugaContentProps {
	activeTab: string;
	setActiveTab: (tab: string) => void;
}

function CugaContent({ activeTab, setActiveTab }: CugaContentProps) {
	return (
		<div className="p-6 space-y-8 max-w-6xl mx-auto">
			{/* Hero Section */}
			<div className="text-center space-y-4">
				<div className="flex items-center justify-center gap-3">
					<div className="h-16 w-16 rounded-2xl bg-gradient-to-br from-purple-500 to-blue-600 flex items-center justify-center">
						<Bot className="h-8 w-8 text-white" />
					</div>
				</div>
				<h1 className="text-3xl font-bold">CUGA Generalist</h1>
				<p className="text-lg text-muted-foreground max-w-2xl mx-auto">
					Configurable Universal Generalist Agent - A powerful
					multi-agent system capable of browser automation, API
					orchestration, code execution, and intelligent task
					decomposition.
				</p>
				<div className="flex items-center justify-center gap-2 flex-wrap">
					<Badge variant="secondary" className="gap-1">
						<Sparkles className="h-3 w-3" /> LangGraph-Python
					</Badge>
					<Badge variant="secondary" className="gap-1">
						<Globe className="h-3 w-3" /> Playwright
					</Badge>
					<Badge variant="secondary" className="gap-1">
						<Code2 className="h-3 w-3" /> E2B Sandbox
					</Badge>
					<Badge variant="secondary" className="gap-1">
						<Shield className="h-3 w-3" /> HITL Support
					</Badge>
				</div>
			</div>

			{/* Tabs */}
			<Tabs value={activeTab} onValueChange={setActiveTab}>
				<TabsList className="grid w-full grid-cols-3">
					<TabsTrigger value="overview" className="gap-2">
						<Brain className="h-4 w-4" /> Overview
					</TabsTrigger>
					<TabsTrigger value="sub-agents" className="gap-2">
						<Network className="h-4 w-4" /> Sub-Agents
					</TabsTrigger>
					<TabsTrigger value="features" className="gap-2">
						<Zap className="h-4 w-4" /> Features
					</TabsTrigger>
				</TabsList>

				<TabsContent value="overview" className="mt-6 space-y-6">
					<Card>
						<CardHeader>
							<CardTitle>How CUGA Works</CardTitle>
							<CardDescription>
								CUGA uses a sophisticated multi-agent
								architecture to handle complex tasks
							</CardDescription>
						</CardHeader>
						<CardContent className="space-y-4">
							<div className="grid gap-4 md:grid-cols-2">
								<div className="space-y-2">
									<h4 className="font-medium flex items-center gap-2">
										<span className="h-6 w-6 rounded-full bg-blue-100 dark:bg-blue-900 flex items-center justify-center text-xs font-bold text-blue-700 dark:text-blue-300">
											1
										</span>
										Task Analysis
									</h4>
									<p className="text-sm text-muted-foreground pl-8">
										The Task Analyzer examines your request
										to understand intent, complexity, and
										required resources.
									</p>
								</div>
								<div className="space-y-2">
									<h4 className="font-medium flex items-center gap-2">
										<span className="h-6 w-6 rounded-full bg-blue-100 dark:bg-blue-900 flex items-center justify-center text-xs font-bold text-blue-700 dark:text-blue-300">
											2
										</span>
										Task Decomposition
									</h4>
									<p className="text-sm text-muted-foreground pl-8">
										Complex tasks are broken into subtasks
										with dependencies and parallel execution
										opportunities.
									</p>
								</div>
								<div className="space-y-2">
									<h4 className="font-medium flex items-center gap-2">
										<span className="h-6 w-6 rounded-full bg-blue-100 dark:bg-blue-900 flex items-center justify-center text-xs font-bold text-blue-700 dark:text-blue-300">
											3
										</span>
										Execution
									</h4>
									<p className="text-sm text-muted-foreground pl-8">
										Specialized sub-agents (API, Browser,
										Code) execute each subtask with HITL
										checkpoints.
									</p>
								</div>
								<div className="space-y-2">
									<h4 className="font-medium flex items-center gap-2">
										<span className="h-6 w-6 rounded-full bg-blue-100 dark:bg-blue-900 flex items-center justify-center text-xs font-bold text-blue-700 dark:text-blue-300">
											4
										</span>
										Quality Assurance
									</h4>
									<p className="text-sm text-muted-foreground pl-8">
										The QA Agent validates results and
										ensures task completion meets quality
										standards.
									</p>
								</div>
							</div>
						</CardContent>
					</Card>

					<Card>
						<CardHeader>
							<CardTitle>Use Cases</CardTitle>
						</CardHeader>
						<CardContent>
							<div className="grid gap-3 md:grid-cols-2">
								{[
									"Web scraping and data extraction",
									"Form filling and automation",
									"API integration workflows",
									"Data processing pipelines",
									"Research and information gathering",
									"Multi-step business processes",
								].map((useCase) => (
									<div
										key={useCase}
										className="flex items-center gap-2 text-sm"
									>
										<div className="h-1.5 w-1.5 rounded-full bg-green-500" />
										{useCase}
									</div>
								))}
							</div>
						</CardContent>
					</Card>
				</TabsContent>

				<TabsContent value="sub-agents" className="mt-6">
					<div className="grid gap-4 md:grid-cols-2">
						{SUB_AGENTS.map((agent) => (
							<Card key={agent.id}>
								<CardHeader className="pb-2">
									<CardTitle className="text-base flex items-center gap-2">
										<agent.icon className="h-5 w-5 text-primary" />
										{agent.name}
									</CardTitle>
									<CardDescription>
										{agent.description}
									</CardDescription>
								</CardHeader>
								<CardContent>
									<div className="flex flex-wrap gap-1">
										{agent.capabilities.map((cap) => (
											<Badge
												key={cap}
												variant="outline"
												className="text-xs"
											>
												{cap}
											</Badge>
										))}
									</div>
								</CardContent>
							</Card>
						))}
					</div>
				</TabsContent>

				<TabsContent value="features" className="mt-6">
					<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
						{FEATURES.map((feature) => (
							<Card key={feature.title}>
								<CardHeader>
									<CardTitle className="text-base flex items-center gap-2">
										<feature.icon className="h-5 w-5 text-primary" />
										{feature.title}
									</CardTitle>
								</CardHeader>
								<CardContent>
									<p className="text-sm text-muted-foreground">
										{feature.description}
									</p>
								</CardContent>
							</Card>
						))}
					</div>
				</TabsContent>
			</Tabs>
		</div>
	);
}
