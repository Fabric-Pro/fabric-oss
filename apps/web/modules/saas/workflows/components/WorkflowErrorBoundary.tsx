"use client";

/**
 * Error Boundary for Workflow Builder
 *
 * Catches and handles errors in the workflow builder to prevent crashes.
 * Based on React's error boundary pattern with recovery support.
 */

import { Button } from "@ui/components/button";
import { AlertTriangleIcon, RefreshCwIcon } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
	children: ReactNode;
	fallback?: ReactNode;
	onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface State {
	hasError: boolean;
	error: Error | null;
	errorInfo: ErrorInfo | null;
}

export class WorkflowErrorBoundary extends Component<Props, State> {
	constructor(props: Props) {
		super(props);
		this.state = { hasError: false, error: null, errorInfo: null };
	}

	static getDerivedStateFromError(error: Error): Partial<State> {
		return { hasError: true, error };
	}

	componentDidCatch(error: Error, errorInfo: ErrorInfo) {
		console.error(
			"[WorkflowBuilder] Error caught by boundary:",
			error,
			errorInfo,
		);
		this.setState({ errorInfo });
		this.props.onError?.(error, errorInfo);
	}

	handleReset = () => {
		this.setState({ hasError: false, error: null, errorInfo: null });
	};

	render() {
		if (this.state.hasError) {
			if (this.props.fallback) {
				return this.props.fallback;
			}

			return (
				<div className="flex flex-col items-center justify-center h-full min-h-[400px] p-8 bg-background">
					<div className="flex flex-col items-center max-w-md text-center space-y-4">
						<div className="p-4 rounded-full bg-destructive/10">
							<AlertTriangleIcon className="h-8 w-8 text-destructive" />
						</div>

						<h2 className="text-xl font-semibold">
							Something went wrong
						</h2>

						<p className="text-muted-foreground">
							An error occurred in the workflow builder. This
							might be due to corrupted workflow data or an
							unexpected state.
						</p>

						{this.state.error && (
							<div className="w-full p-4 rounded-lg bg-muted text-left">
								<p className="text-sm font-mono text-destructive break-all">
									{this.state.error.message}
								</p>
							</div>
						)}

						<div className="flex gap-3 pt-2">
							<Button
								onClick={this.handleReset}
								variant="default"
							>
								<RefreshCwIcon className="h-4 w-4 mr-2" />
								Try Again
							</Button>
							<Button
								variant="outline"
								onClick={() => window.location.reload()}
							>
								Reload Page
							</Button>
						</div>

						{process.env.NODE_ENV === "development" &&
							this.state.errorInfo && (
								<details className="w-full mt-4 text-left">
									<summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
										View Stack Trace
									</summary>
									<pre className="mt-2 p-4 rounded-lg bg-muted text-xs overflow-auto max-h-48">
										{this.state.errorInfo.componentStack}
									</pre>
								</details>
							)}
					</div>
				</div>
			);
		}

		return this.props.children;
	}
}
