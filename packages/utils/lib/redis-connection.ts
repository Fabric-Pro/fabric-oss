/**
 * TCP keepalive delay for every ioredis client in the monorepo.
 *
 * ioredis defaults `keepAlive` to 0, which disables TCP keepalive entirely. A
 * connection that then sits idle is silently reaped by whatever sits between
 * the client and Redis — a managed instance's idle timeout, a load balancer, a
 * NAT table — and the client only discovers this on its next write, which
 * surfaces as `ECONNRESET` or `connect ETIMEDOUT` rather than as a clean
 * reconnect.
 *
 * The publishers here are bursty and idle-heavy by design (fire-and-forget
 * execution events, subscribe-only SSE streams), which is exactly the traffic
 * shape that profile punishes. Production logged roughly 3,650 such errors in a
 * week; each one drops a live progress event, so a user watching the assistant
 * sees nothing until the run completes.
 *
 * 30s is comfortably under the idle timeouts used by managed Redis providers
 * while costing one small packet per idle connection per interval.
 *
 * This is deliberately a lone constant rather than a shared options factory:
 * the call sites legitimately differ (2s vs 3s connect timeouts, and the seed
 * script wants ioredis's default offline queue), so a single options object
 * would have to either flatten those differences or grow a parameter per site.
 */
export const REDIS_KEEPALIVE_MS = 30_000;
