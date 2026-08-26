"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Label } from "@ui/components/label";
import { ScrollArea } from "@ui/components/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { Textarea } from "@ui/components/textarea";
import {
	CheckCircleIcon,
	ClockIcon,
	LoaderIcon,
	PlayIcon,
	XCircleIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

interface OpenAPIToolTestDialogProps {
	tool: {
		id: string;
		name: string;
		description: string | null;
		method: string;
		path: string;
		parametersSchema: unknown;
		requestBodySchema: unknown;
	} | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

interface TestResult {
	success: boolean;
	data?: unknown;
	error?: string;
	responseTime?: number;
	statusCode?: number;
}

interface ParamInfo {
	name: string;
	required: boolean;
	description?: string;
	in: string;
}

function ParamsView({ params }: { params: ParamInfo[] }) {
	return (
		<ScrollArea className="h-[250px]">
			{params.length === 0 ? (
				<p className="text-sm text-muted-foreground py-4">
					No parameters defined
				</p>
			) : (
				<div className="space-y-3">
					{params.map((param) => (
						<div key={param.name} className="p-3 border rounded-lg">
							<div className="flex items-center gap-2">
								<span className="font-medium">
									{param.name}
								</span>
								<Badge variant="outline" className="text-xs">
									{param.in}
								</Badge>
								{param.required && (
									<Badge
										variant="destructive"
										className="text-xs"
									>
										required
									</Badge>
								)}
							</div>
							{param.description && (
								<p className="text-sm text-muted-foreground mt-1">
									{param.description}
								</p>
							)}
						</div>
					))}
				</div>
			)}
		</ScrollArea>
	);
}

function ResultView({ result }: { result: TestResult | null }) {
	return (
		<ScrollArea className="h-[250px]">
			{result === null ? (
				<p className="text-sm text-muted-foreground py-4 text-center">
					Run the test to see results
				</p>
			) : (
				<div className="space-y-4">
					<div className="flex items-center gap-4">
						{result.success ? (
							<div className="flex items-center gap-2 text-success">
								<CheckCircleIcon className="h-5 w-5" />
								<span className="font-medium">Success</span>
							</div>
						) : (
							<div className="flex items-center gap-2 text-destructive">
								<XCircleIcon className="h-5 w-5" />
								<span className="font-medium">Failed</span>
							</div>
						)}
						{result.statusCode && (
							<Badge variant="outline">
								HTTP {result.statusCode}
							</Badge>
						)}
						{result.responseTime && (
							<div className="flex items-center gap-1 text-sm text-muted-foreground">
								<ClockIcon className="h-4 w-4" />
								{result.responseTime}ms
							</div>
						)}
					</div>
					{result.error && (
						<div className="p-3 bg-destructive/5 border border-destructive/20 rounded-md">
							<p className="text-sm text-destructive/80">
								{result.error}
							</p>
						</div>
					)}
					{result.data !== undefined && (
						<div className="space-y-2">
							<Label>Response Data</Label>
							<pre className="p-3 bg-muted rounded-lg text-xs overflow-auto max-h-[150px]">
								{typeof result.data === "string"
									? result.data
									: JSON.stringify(result.data, null, 2)}
							</pre>
						</div>
					)}
				</div>
			)}
		</ScrollArea>
	);
}

export function OpenAPIToolTestDialog({
	tool,
	open,
	onOpenChange,
}: OpenAPIToolTestDialogProps) {
	const [argsJson, setArgsJson] = useState("{}");
	const [result, setResult] = useState<TestResult | null>(null);

	const testMutation = useMutation({
		mutationFn: async (input: {
			id: string;
			arguments: Record<string, unknown>;
		}) => await orpcClient.openapi.tools.test(input),
		onSuccess: (data) => {
			setResult(data);
			if (data.success) {
				toast.success(
					`Tool executed successfully in ${data.responseTime}ms`,
				);
			} else {
				toast.error(`Tool execution failed: ${data.error}`);
			}
		},
		onError: (error: Error) => {
			setResult({ success: false, error: error.message });
			toast.error(`Test failed: ${error.message}`);
		},
	});

	const handleTest = () => {
		if (!tool) {
			return;
		}
		try {
			const args = JSON.parse(argsJson);
			setResult(null);
			testMutation.mutate({ id: tool.id, arguments: args });
		} catch {
			toast.error("Invalid JSON in arguments");
		}
	};

	const handleClose = () => {
		setArgsJson("{}");
		setResult(null);
		onOpenChange(false);
	};

	if (!tool) {
		return null;
	}

	const params = tool.parametersSchema as {
		pathParams?: Array<{
			name: string;
			required: boolean;
			description?: string;
		}>;
		queryParams?: Array<{
			name: string;
			required: boolean;
			description?: string;
		}>;
		headerParams?: Array<{
			name: string;
			required: boolean;
			description?: string;
		}>;
	} | null;

	const allParams: ParamInfo[] = [
		...(params?.pathParams || []).map((p) => ({ ...p, in: "path" })),
		...(params?.queryParams || []).map((p) => ({ ...p, in: "query" })),
		...(params?.headerParams || []).map((p) => ({ ...p, in: "header" })),
	];

	return (
		<Dialog open={open} onOpenChange={handleClose}>
			<DialogContent className="max-w-2xl max-h-[85vh]">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<Badge variant="outline" className="font-mono">
							{tool.method}
						</Badge>
						Test: {tool.name}
					</DialogTitle>
					<DialogDescription>{tool.path}</DialogDescription>
				</DialogHeader>

				<Tabs defaultValue="input" className="w-full">
					<TabsList className="grid w-full grid-cols-3">
						<TabsTrigger value="input">Input</TabsTrigger>
						<TabsTrigger value="params">Parameters</TabsTrigger>
						<TabsTrigger value="result">Result</TabsTrigger>
					</TabsList>

					<TabsContent value="input" className="space-y-4">
						<div className="space-y-2">
							<Label>Arguments (JSON)</Label>
							<Textarea
								value={argsJson}
								onChange={(e) => setArgsJson(e.target.value)}
								placeholder='{"param1": "value1"}'
								className="font-mono text-sm min-h-[200px]"
							/>
						</div>
					</TabsContent>

					<TabsContent value="params">
						<ParamsView params={allParams} />
					</TabsContent>

					<TabsContent value="result">
						<ResultView result={result} />
					</TabsContent>
				</Tabs>

				<DialogFooter>
					<Button variant="outline" onClick={handleClose}>
						Close
					</Button>
					<Button
						onClick={handleTest}
						disabled={testMutation.isPending}
					>
						{testMutation.isPending ? (
							<>
								<LoaderIcon className="h-4 w-4 mr-2 animate-spin" />
								Testing...
							</>
						) : (
							<>
								<PlayIcon className="h-4 w-4 mr-2" />
								Run Test
							</>
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
