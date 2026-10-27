import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DecisionReplayDashboard } from "../DecisionReplayDashboard";

const visibilityStateDescriptor = Object.getOwnPropertyDescriptor(
	document,
	"visibilityState",
);

const mocks = vi.hoisted(() => ({
	mint: vi.fn(),
	initialize: vi.fn(),
	destroy: vi.fn(),
	options: vi.fn(),
	theme: "dark",
}));
vi.mock("next-themes", () => ({
	useTheme: () => ({ resolvedTheme: mocks.theme }),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			decisionReplay: {
				getEmbedToken: (...a: unknown[]) => mocks.mint(...a),
			},
		},
	},
}));
vi.mock("@databricks/aibi-client", () => ({
	DatabricksDashboard: class {
		constructor(options: unknown) {
			mocks.options(options);
		}
		initialize = mocks.initialize;
		destroy = mocks.destroy;
	},
}));
function token(value = "synthetic-token") {
	return {
		available: true,
		token: value,
		expiresAt: new Date(Date.now() + 3600000).toISOString(),
		instanceUrl: "https://example.com",
		workspaceId: "example-workspace",
		dashboardId: "example-dashboard",
	};
}
async function mount(projectId = "example-project") {
	const view = render(<DecisionReplayDashboard projectId={projectId} />);
	await act(async () => {});
	return view;
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.mint.mockReset();
	mocks.theme = "dark";
	vi.useFakeTimers();
	mocks.mint.mockImplementation(async () => token());
	mocks.initialize.mockImplementation(() => {
		const host = mocks.options.mock.lastCall?.[0].container as HTMLElement;
		const iframe = document.createElement("iframe");
		host.append(iframe);
		queueMicrotask(() => iframe.dispatchEvent(new Event("load")));
	});
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
	if (visibilityStateDescriptor) {
		Object.defineProperty(
			document,
			"visibilityState",
			visibilityStateDescriptor,
		);
	} else {
		Reflect.deleteProperty(document, "visibilityState");
	}
});
it("not_configured is compact and terminal across timers and wake events", async () => {
	mocks.mint.mockResolvedValue({
		available: false,
		reason: "not_configured",
	});
	const view = await mount();
	expect(
		screen.getByText("Trends aren't set up in this environment yet."),
	).toBeInTheDocument();
	expect(
		screen.queryByRole("status", { name: "Loading trends" }),
	).not.toBeInTheDocument();
	expect(
		screen.queryByRole("button", { name: "Try again" }),
	).not.toBeInTheDocument();
	expect(view.container.querySelector(".h-340")).toBeNull();
	expect(
		screen.queryByText(
			"Refreshes on a schedule, so new decisions can take several hours to appear",
		),
	).not.toBeInTheDocument();
	expect(screen.getByRole("status")).toHaveTextContent(
		"Trends aren't set up in this environment yet.",
	);
	expect(vi.getTimerCount()).toBe(0);
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		value: "visible",
	});
	await act(async () => {
		await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
		document.dispatchEvent(new Event("visibilitychange"));
		window.dispatchEvent(new Event("online"));
	});
	expect(mocks.mint).toHaveBeenCalledTimes(1);
	expect(mocks.initialize).not.toHaveBeenCalled();
	expect(vi.getTimerCount()).toBe(0);
	view.rerender(
		<DecisionReplayDashboard projectId="example-other-project" />,
	);
	await act(async () => {});
	expect(mocks.mint).toHaveBeenCalledTimes(2);
});
it("not_configured during SDK refresh rejects waiters and clears held-token timers", async () => {
	await mount();
	await act(async () => {
		await vi.advanceTimersByTimeAsync(30000);
	});
	mocks.mint.mockResolvedValue({
		available: false,
		reason: "not_configured",
	});
	const pending = mocks.options.mock.calls[0][0].getNewToken();
	const rejected = expect(pending).rejects.toThrow(
		"Dashboard access unavailable",
	);
	await act(async () => {
		await rejected;
	});
	expect(
		screen.getByText("Trends aren't set up in this environment yet."),
	).toBeInTheDocument();
	expect(document.querySelector("iframe")).toBeNull();
	expect(mocks.destroy).toHaveBeenCalledOnce();
	expect(vi.getTimerCount()).toBe(0);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
		window.dispatchEvent(new Event("online"));
		document.dispatchEvent(new Event("visibilitychange"));
	});
	expect(mocks.mint).toHaveBeenCalledTimes(2);
});
it("unavailable preserves refresh backoff at thirty then sixty seconds", async () => {
	await mount();
	mocks.mint.mockResolvedValue({ available: false, reason: "unavailable" });
	await act(async () => {
		await vi.advanceTimersByTimeAsync(3300000);
	});
	expect(mocks.mint).toHaveBeenCalledTimes(2);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(29999);
	});
	expect(mocks.mint).toHaveBeenCalledTimes(2);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1);
	});
	expect(mocks.mint).toHaveBeenCalledTimes(3);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(59999);
	});
	expect(mocks.mint).toHaveBeenCalledTimes(3);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1);
	});
	expect(mocks.mint).toHaveBeenCalledTimes(4);
	expect(document.querySelector("iframe")).toBeInTheDocument();
	expect(mocks.destroy).not.toHaveBeenCalled();
});
it("unavailable retries and keeps tokens out of Fabric navigation and storage", async () => {
	mocks.mint.mockResolvedValueOnce({
		available: false,
		reason: "unavailable",
	});
	await mount();
	expect(
		screen.getByText("Trends are unavailable right now"),
	).toBeInTheDocument();
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
	});
	expect(mocks.mint).toHaveBeenCalledTimes(2);
	expect(mocks.initialize).toHaveBeenCalledOnce();
	expect(mocks.options).toHaveBeenCalledWith(
		expect.objectContaining({
			token: "synthetic-token",
			config: { version: 1, hideDatabricksLogo: true },
			getNewToken: expect.any(Function),
		}),
	);
	expect(window.location.href).not.toContain("synthetic-token");
	expect(JSON.stringify(window.history.state)).not.toContain(
		"synthetic-token",
	);
	expect(JSON.stringify(window.localStorage)).not.toContain(
		"synthetic-token",
	);
	expect(JSON.stringify(window.sessionStorage)).not.toContain(
		"synthetic-token",
	);
});
it("pre-mints five minutes before expiry and supplies the token via the client hook", async () => {
	await mount();
	mocks.mint.mockImplementation(async () => token("fresh-synthetic-token"));
	await act(async () => {
		await vi.advanceTimersByTimeAsync(3299999);
	});
	expect(mocks.mint).toHaveBeenCalledTimes(1);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1);
	});
	expect(mocks.mint).toHaveBeenCalledTimes(2);
	expect(await mocks.options.mock.calls[0][0].getNewToken()).toBe(
		"fresh-synthetic-token",
	);
	expect(mocks.mint).toHaveBeenCalledTimes(2);
	// Once handed to the SDK, B's deadline replaces A's original deadline.
	await act(async () => {
		await vi.advanceTimersByTimeAsync(600000);
	});
	expect(mocks.mint).toHaveBeenCalledTimes(2);
	expect(mocks.initialize).toHaveBeenCalledOnce();
	expect(document.querySelector("iframe")).toBeInTheDocument();
});
it("unmount destroys dashboard and cancels token refresh", async () => {
	const view = await mount();
	view.unmount();
	expect(mocks.destroy).toHaveBeenCalledOnce();
	await act(async () => {
		await vi.advanceTimersByTimeAsync(3600000);
	});
	expect(mocks.mint).toHaveBeenCalledTimes(1);
	window.dispatchEvent(new Event("online"));
	document.dispatchEvent(new Event("visibilitychange"));
	expect(mocks.mint).toHaveBeenCalledTimes(1);
	expect(vi.getTimerCount()).toBe(0);
});
it("project change destroys the previous dashboard and ignores a late response", async () => {
	let resolve!: (value: ReturnType<typeof token>) => void;
	mocks.mint.mockReturnValueOnce(
		new Promise((r) => {
			resolve = r;
		}),
	);
	const view = await mount();
	view.rerender(
		<DecisionReplayDashboard projectId="example-other-project" />,
	);
	await act(async () => {});
	await act(async () => {
		resolve(token("stale-synthetic-token"));
	});
	expect(mocks.initialize).toHaveBeenCalledTimes(1);
	expect(mocks.options).not.toHaveBeenCalledWith(
		expect.objectContaining({ token: "stale-synthetic-token" }),
	);
	view.rerender(
		<DecisionReplayDashboard projectId="example-third-project" />,
	);
	await act(async () => {});
	expect(mocks.destroy).toHaveBeenCalledOnce();
	expect(mocks.mint).toHaveBeenLastCalledWith({
		projectId: "example-third-project",
	});
});
it("failed refresh keeps a valid frame through recurring retries until expiry", async () => {
	await mount();
	mocks.mint.mockRejectedValue(new Error("offline"));
	await act(async () => {
		await vi.advanceTimersByTimeAsync(3300000);
	});
	expect(document.querySelector("iframe")).toBeInTheDocument();
	expect(mocks.destroy).not.toHaveBeenCalled();
	expect(
		screen.queryByText("Trends are unavailable right now"),
	).not.toBeInTheDocument();
	await act(async () => {
		await vi.advanceTimersByTimeAsync(29999);
	});
	expect(mocks.mint).toHaveBeenCalledTimes(2);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1);
	});
	expect(mocks.mint).toHaveBeenCalledTimes(3);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(270000);
	});
	// Expiry makes one recovery attempt regardless of timer lateness.
	expect(mocks.mint).toHaveBeenCalledTimes(8);
	expect(
		screen.getByText("Trends are unavailable right now"),
	).toBeInTheDocument();
	expect(mocks.destroy).toHaveBeenCalledOnce();
});
it.each(["online", "visibilitychange"])(
	"recovers failed refresh on %s without remounting",
	async (event) => {
		await mount();
		mocks.mint.mockRejectedValueOnce(new Error("offline"));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(3300000);
		});
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			value: "visible",
		});
		await act(async () => {
			(event === "online" ? window : document).dispatchEvent(
				new Event(event),
			);
		});
		expect(mocks.mint).toHaveBeenCalledTimes(3);
		expect(mocks.initialize).toHaveBeenCalledOnce();
		expect(document.querySelector("iframe")).toBeInTheDocument();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(30000);
		});
		expect(mocks.mint).toHaveBeenCalledTimes(3);
	},
);
it("SDK back-to-back refresh requests reuse a token younger than 30 seconds", async () => {
	await mount();
	const refresh = mocks.options.mock.calls[0][0].getNewToken;
	expect(await refresh()).toBe("synthetic-token");
	expect(await refresh()).toBe("synthetic-token");
	expect(mocks.mint).toHaveBeenCalledTimes(1);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(30000);
	});
	await refresh();
	await refresh();
	expect(mocks.mint).toHaveBeenCalledTimes(2);
});
it("shows refresh cadence without claiming a data timestamp and uses app theme", async () => {
	const view = await mount();
	expect(
		screen.getByText(
			"Refreshes on a schedule, so new decisions can take several hours to appear",
		),
	).toBeInTheDocument();
	expect(screen.queryByText(/Updated/)).not.toBeInTheDocument();
	expect(document.querySelector("[title*=loaded]")).toBeNull();
	expect(mocks.options.mock.calls[0][0].colorScheme).toBe("dark");
	const frame = document.querySelector("iframe");
	mocks.theme = "light";
	view.rerender(<DecisionReplayDashboard projectId="example-project" />);
	expect(frame?.style.colorScheme).toBe("light");
	expect(document.querySelector("iframe")).toBe(frame);
	expect(mocks.initialize).toHaveBeenCalledOnce();
});
it("an in-flight refresh resolving after unmount rejects and schedules no work", async () => {
	const view = await mount();
	await act(async () => {
		await vi.advanceTimersByTimeAsync(30000);
	});
	let resolve!: (value: ReturnType<typeof token>) => void;
	mocks.mint.mockReturnValueOnce(
		new Promise((r) => {
			resolve = r;
		}),
	);
	const pending = mocks.options.mock.calls[0][0].getNewToken();
	const assertion = expect(pending).rejects.toThrow(
		"Dashboard access unavailable",
	);
	view.unmount();
	await act(async () => {
		resolve(token("late-example-token"));
		await assertion;
	});
	expect(vi.getTimerCount()).toBe(0);
});

it("keeps a sized skeleton until the frame loads", async () => {
	mocks.initialize.mockImplementation(() => {
		mocks.options.mock.lastCall?.[0].container.append(
			document.createElement("iframe"),
		);
	});
	await mount();
	expect(
		screen.getByRole("status", { name: "Loading trends" }),
	).toBeInTheDocument();
	const iframe = document.querySelector("iframe");
	if (!iframe) {
		throw new Error("Expected dashboard frame");
	}
	await act(async () => {
		iframe.dispatchEvent(new Event("load"));
	});
	expect(
		screen.queryByRole("status", { name: "Loading trends" }),
	).not.toBeInTheDocument();
	expect(iframe).toHaveAttribute("title", "AI outcomes trends and details");
});
it("a frame that does not load becomes retryable", async () => {
	mocks.initialize.mockImplementation(() => {
		mocks.options.mock.lastCall?.[0].container.append(
			document.createElement("iframe"),
		);
	});
	await mount();
	await act(async () => {
		await vi.advanceTimersByTimeAsync(30000);
	});
	expect(
		screen.getByText("Trends are unavailable right now"),
	).toBeInTheDocument();
	expect(mocks.destroy).toHaveBeenCalledOnce();
});

it("NOT_FOUND from token mint signals the project flag fallback", async () => {
	const onNotFound = vi.fn();
	mocks.mint.mockRejectedValue({ code: "NOT_FOUND" });
	render(
		<DecisionReplayDashboard
			projectId="example-project"
			onNotFound={onNotFound}
		/>,
	);
	await act(async () => {});
	expect(onNotFound).toHaveBeenCalledOnce();
});

it("late SDK refresh failures cannot overwrite the next project container", async () => {
	const view = await mount();
	const oldOptions = mocks.options.mock.calls[0][0];
	await act(async () => {
		await vi.advanceTimersByTimeAsync(30000);
	});
	let resolve!: (value: { available: false }) => void;
	mocks.mint.mockReturnValueOnce(
		new Promise((r) => {
			resolve = r;
		}),
	);
	// The SDK renders refresh errors into its container even after destroy().
	const pending = oldOptions.getNewToken().catch(() => {
		oldOptions.container.textContent = "Stale refresh error";
	});
	view.rerender(
		<DecisionReplayDashboard projectId="example-other-project" />,
	);
	await act(async () => {});
	await act(async () => {
		resolve({ available: false });
		await pending;
	});
	expect(screen.queryByText("Stale refresh error")).not.toBeInTheDocument();
	expect(document.querySelector("iframe")).toBeInTheDocument();
});

it("SDK refresh failure waits for the bounded retry without destroying a valid frame", async () => {
	await mount();
	await act(async () => {
		await vi.advanceTimersByTimeAsync(30000);
	});
	mocks.mint.mockRejectedValueOnce(new Error("offline"));
	let settled = false;
	const pending = mocks.options.mock.calls[0][0].getNewToken();
	const observed = pending.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	await act(async () => {});
	expect(settled).toBe(false);
	expect(document.querySelector("iframe")).toBeInTheDocument();
	expect(mocks.destroy).not.toHaveBeenCalled();
	await act(async () => {
		await vi.advanceTimersByTimeAsync(30000);
	});
	await expect(pending).resolves.toBe("synthetic-token");
	await observed;
	expect(mocks.mint).toHaveBeenCalledTimes(3);
	expect(mocks.initialize).toHaveBeenCalledOnce();
});

it("SDK refresh failure rejects only at actual expiry when recovery fails", async () => {
	await mount();
	await act(async () => {
		await vi.advanceTimersByTimeAsync(30000);
	});
	mocks.mint.mockRejectedValue(new Error("offline"));
	let settled = false;
	const pending = mocks.options.mock.calls[0][0].getNewToken();
	const observed = pending.catch(() => {
		settled = true;
	});
	await act(async () => {});
	expect(settled).toBe(false);
	const assertion = expect(pending).rejects.toThrow(
		"Dashboard access unavailable",
	);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(3570000);
	});
	await assertion;
	await observed;
	expect(
		screen.getByText("Trends are unavailable right now"),
	).toBeInTheDocument();
	expect(mocks.destroy).toHaveBeenCalledOnce();
});

// Regression: a second failed attempt must not exhaust recovery.
it("recovers after several retry intervals while the same dashboard stays visible", async () => {
	await mount();
	mocks.mint.mockRejectedValue(new Error("offline"));
	await act(async () => {
		await vi.advanceTimersByTimeAsync(3300000);
	});
	const pending = mocks.options.mock.calls[0][0].getNewToken();
	void pending.catch(() => {});
	await act(async () => {
		await vi.advanceTimersByTimeAsync(150000);
	});
	expect(mocks.mint).toHaveBeenCalledTimes(5);
	expect(mocks.initialize).toHaveBeenCalledOnce();
	expect(mocks.destroy).not.toHaveBeenCalled();
	expect(document.querySelector("iframe")).toBeInTheDocument();
	mocks.mint.mockImplementation(async () => token("recovered-example-token"));
	await act(async () => {
		await vi.advanceTimersByTimeAsync(60000);
	});
	await expect(pending).resolves.toBe("recovered-example-token");
	expect(await mocks.options.mock.calls[0][0].getNewToken()).toBe(
		"recovered-example-token",
	);
	expect(mocks.mint).toHaveBeenCalledTimes(6);
	expect(mocks.initialize).toHaveBeenCalledOnce();
});
it("near-expiry tokens younger than 30 seconds wait for a fresh mint", async () => {
	mocks.mint.mockResolvedValueOnce({
		...token(),
		expiresAt: new Date(Date.now() + 300000).toISOString(),
	});
	await mount();
	let resolve!: (value: ReturnType<typeof token>) => void;
	mocks.mint.mockReturnValueOnce(
		new Promise((r) => {
			resolve = r;
		}),
	);
	let settled = false;
	const pending = mocks.options.mock.calls[0][0]
		.getNewToken()
		.then((value: string) => {
			settled = true;
			return value;
		});
	await act(async () => {});
	expect(settled).toBe(false);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(30000);
	});
	expect(mocks.mint).toHaveBeenCalledTimes(2);
	await act(async () => {
		resolve(token("fresh-example-token"));
	});
	await expect(pending).resolves.toBe("fresh-example-token");
});
it("waking past expiry attempts recovery and recreates the frame before unavailable", async () => {
	await mount();
	await act(async () => {
		await vi.advanceTimersByTimeAsync(0);
	});
	let resolve!: (value: ReturnType<typeof token>) => void;
	mocks.mint.mockReturnValueOnce(
		new Promise((r) => {
			resolve = r;
		}),
	);
	vi.setSystemTime(Date.now() + 3700000);
	await act(async () => {
		await vi.advanceTimersToNextTimerAsync();
	});
	expect(mocks.mint).toHaveBeenCalledTimes(2);
	expect(
		screen.queryByText("Trends are unavailable right now"),
	).not.toBeInTheDocument();
	await act(async () => {
		resolve(token("wake-example-token"));
	});
	expect(mocks.initialize).toHaveBeenCalledTimes(2);
	expect(mocks.destroy).toHaveBeenCalledOnce();
	expect(mocks.options.mock.lastCall?.[0].token).toBe("wake-example-token");
});

it("a token delivered to SDK waiters is not cached indefinitely after recovery", async () => {
	await mount();
	mocks.mint.mockRejectedValueOnce(new Error("offline"));
	await act(async () => {
		await vi.advanceTimersByTimeAsync(3300000);
	});
	const refresh = mocks.options.mock.calls[0][0].getNewToken;
	const pending = refresh();
	void pending.catch(() => {});
	mocks.mint.mockImplementation(async () => token("recovery-example-token"));
	await act(async () => {
		await vi.advanceTimersByTimeAsync(30000);
	});
	await expect(pending).resolves.toBe("recovery-example-token");
	await act(async () => {
		await vi.advanceTimersByTimeAsync(30000);
	});
	mocks.mint.mockImplementation(async () => token("next-example-token"));
	await expect(refresh()).resolves.toBe("next-example-token");
	expect(mocks.mint).toHaveBeenCalledTimes(4);
});
it("component refresh and concurrent SDK callers share one mint even at the five-minute boundary", async () => {
	// Start with a short token so even a token just minted cannot be reused.
	mocks.mint.mockResolvedValueOnce({
		...token(),
		expiresAt: new Date(Date.now() + 310000).toISOString(),
	});
	await mount();
	let resolve!: (value: ReturnType<typeof token>) => void;
	mocks.mint.mockReturnValueOnce(
		new Promise((r) => {
			resolve = r;
		}),
	);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(10000);
	});
	const refresh = mocks.options.mock.calls[0][0].getNewToken;
	let settled = 0;
	const pending = [refresh(), refresh()].map((p) =>
		p.then((value: string) => {
			settled++;
			return value;
		}),
	);
	for (const p of pending) {
		void p.catch(() => {});
	}
	await act(async () => {});
	expect(settled).toBe(0);
	expect(mocks.mint).toHaveBeenCalledTimes(2);
	await act(async () => {
		resolve(token("shared-example-token"));
	});
	await expect(Promise.all(pending)).resolves.toEqual([
		"shared-example-token",
		"shared-example-token",
	]);
	expect(mocks.mint).toHaveBeenCalledTimes(2);
});
it("an overdue expiry timer also recovers before unavailable", async () => {
	mocks.mint.mockResolvedValueOnce({
		...token(),
		expiresAt: new Date(Date.now() + 60000).toISOString(),
	});
	await mount();
	mocks.mint.mockRejectedValueOnce(new Error("offline"));
	await act(async () => {
		await vi.advanceTimersByTimeAsync(30000);
	});
	// The expiry timer is now earlier than the next retry timer.
	let resolve!: (value: ReturnType<typeof token>) => void;
	mocks.mint.mockReturnValueOnce(
		new Promise((r) => {
			resolve = r;
		}),
	);
	vi.setSystemTime(Date.now() + 120000);
	await act(async () => {
		await vi.advanceTimersToNextTimerAsync();
	});
	expect(mocks.mint).toHaveBeenCalledTimes(3);
	expect(
		screen.queryByText("Trends are unavailable right now"),
	).not.toBeInTheDocument();
	await act(async () => {
		resolve(token("expiry-wake-example-token"));
	});
	expect(mocks.initialize).toHaveBeenCalledTimes(2);
});

it("a short mint cannot feed the SDK refresh loop or extend its expiry wait", async () => {
	await mount();
	mocks.mint.mockImplementation(async () => ({
		...token("short-example-token"),
		expiresAt: new Date(Date.now() + 300000).toISOString(),
	}));
	await act(async () => {
		await vi.advanceTimersByTimeAsync(3300000);
	});
	let settled = false;
	const pending = mocks.options.mock.calls[0][0].getNewToken();
	void pending.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	await act(async () => {});
	expect(settled).toBe(false);
	const rejected = expect(pending).rejects.toThrow(
		"Dashboard access unavailable",
	);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(300000);
	});
	await rejected;
	expect(
		screen.getByText("Trends are unavailable right now"),
	).toBeInTheDocument();
});

it.each(["online", "visibilitychange"])(
	"fresh-token %s events do not mint",
	async (event) => {
		await mount();
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			value: "visible",
		});
		for (let i = 0; i < 5; i++) {
			await act(async () => {
				await vi.advanceTimersByTimeAsync(60000);
				(event === "online" ? window : document).dispatchEvent(
					new Event(event),
				);
			});
		}
		expect(mocks.mint).toHaveBeenCalledTimes(1);
		expect(mocks.initialize).toHaveBeenCalledOnce();
	},
);
it("focus at 50 minutes cannot extend the SDK token deadline during an outage", async () => {
	await mount();
	await act(async () => {
		await vi.advanceTimersByTimeAsync(3000000);
		window.dispatchEvent(new Event("online"));
	});
	mocks.mint.mockRejectedValue(new Error("offline"));
	await act(async () => {
		await vi.advanceTimersByTimeAsync(900000);
	});
	expect(
		screen.getByText("Trends are unavailable right now"),
	).toBeInTheDocument();
	expect(
		screen.getByRole("button", { name: "Try again" }),
	).toBeInTheDocument();
});
it("an unused pre-minted token never replaces the SDK token or its expiry", async () => {
	await mount();
	mocks.mint.mockImplementation(async () => token("unused-example-token"));
	await act(async () => {
		await vi.advanceTimersByTimeAsync(3300000);
	});
	expect(mocks.mint).toHaveBeenCalledTimes(2);
	mocks.mint.mockRejectedValue(new Error("offline"));
	await act(async () => {
		await vi.advanceTimersByTimeAsync(300000);
	});
	expect(
		screen.getByText("Trends are unavailable right now"),
	).toBeInTheDocument();
	expect(mocks.initialize).toHaveBeenCalledOnce();
});
it("focus at 10 minutes followed by waking at 65 recreates the expired SDK frame", async () => {
	await mount();
	await act(async () => {
		await vi.advanceTimersByTimeAsync(600000);
		window.dispatchEvent(new Event("online"));
	});
	vi.setSystemTime(Date.now() + 3300000);
	await act(async () => {
		window.dispatchEvent(new Event("online"));
	});
	expect(mocks.initialize).toHaveBeenCalledTimes(2);
	expect(mocks.destroy).toHaveBeenCalledOnce();
	expect(
		screen.queryByText("Trends are unavailable right now"),
	).not.toBeInTheDocument();
});
it("exact expiry gets the same single recovery attempt as a late expiry timer", async () => {
	mocks.mint.mockResolvedValueOnce({
		...token(),
		expiresAt: new Date(Date.now() + 60000).toISOString(),
	});
	await mount();
	mocks.mint.mockRejectedValueOnce(new Error("offline"));
	await act(async () => {
		await vi.advanceTimersByTimeAsync(60000);
	});
	expect(mocks.mint).toHaveBeenCalledTimes(3);
	expect(mocks.initialize).toHaveBeenCalledTimes(2);
	expect(
		screen.queryByText("Trends are unavailable right now"),
	).not.toBeInTheDocument();
});

it("updates the mounted status region when trends are not configured", async () => {
	let resolveMint!: (value: unknown) => void;
	mocks.mint.mockImplementation(
		() =>
			new Promise((resolve) => {
				resolveMint = resolve;
			}),
	);
	const view = render(
		<DecisionReplayDashboard projectId="example-project" />,
	);
	const statusRegion = Array.from(
		view.container.querySelectorAll('[role="status"]'),
	).find((region) => !region.hasAttribute("aria-label"));
	expect(statusRegion).toBeInTheDocument();
	expect(statusRegion).toBeEmptyDOMElement();
	// An empty live region between the caption and frame adds a second space-y gap.
	const caption = screen.getByText(
		"Refreshes on a schedule, so new decisions can take several hours to appear",
	);
	expect(caption.nextElementSibling).not.toBe(statusRegion);
	expect(statusRegion?.parentElement?.lastElementChild).toBe(statusRegion);
	expect(statusRegion).toBeVisible();
	await act(async () => {
		resolveMint({ available: false, reason: "not_configured" });
	});
	expect(screen.getByRole("status")).toBe(statusRegion);
	expect(statusRegion).toHaveTextContent(
		"Trends aren't set up in this environment yet.",
	);
});
