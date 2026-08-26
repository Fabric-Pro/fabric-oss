# Upstash Redis Integration

This guide covers setting up Upstash Redis for production rate limiting in Fabric.

## Why Upstash?

Upstash provides serverless Redis that's ideal for:
- **Serverless deployments** (Vercel, Cloudflare Workers)
- **Multi-instance scaling** (consistent rate limiting across instances)
- **Pay-per-request pricing** (cost-effective for variable traffic)
- **Global replication** (low latency worldwide)

## Setup Guide

### Step 1: Create Upstash Account

1. Go to [upstash.com](https://upstash.com)
2. Sign up with GitHub, Google, or email
3. Verify your account

### Step 2: Create a Redis Database

1. Click **"Create Database"** in the Upstash Console
2. Configure your database:
   - **Name**: `fabric-rate-limit` (or your preference)
   - **Type**: Regional (or Global for multi-region)
   - **Region**: Choose closest to your deployment
   - **TLS**: Enabled (default)

3. Click **"Create"**

### Step 3: Get Credentials

After creation, go to the database details page:

1. Find the **REST API** section
2. Copy the following values:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

![Upstash credentials screenshot placeholder]

### Step 4: Configure Environment

Add to your environment variables:

```bash
# .env.local (development)
UPSTASH_REDIS_REST_URL=https://useful-shark-12345.upstash.io
UPSTASH_REDIS_REST_TOKEN=AXXXXXXXyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy

# Vercel (production)
# Add via Vercel Dashboard > Settings > Environment Variables
```

### Step 5: Verify Connection

Start your application and check the logs:

```
[RateLimit] Using Redis for rate limiting
```

Or programmatically:

```typescript
import { getRateLimitStats } from "@repo/api/lib/rate-limit";

const stats = getRateLimitStats();
console.log(stats);
// {
//   totalKeys: 0,
//   memoryEntries: 0,
//   backend: "redis",
//   redisAvailable: true
// }
```

## Configuration Options

### Database Settings

| Setting | Recommended | Notes |
|---------|-------------|-------|
| Eviction | Enabled | Auto-cleanup expired keys |
| TLS | Enabled | Secure connections |
| Type | Regional | Unless you need global |

### Rate Limit Tuning

Adjust rate limits in `packages/api/lib/rate-limit.ts`:

```typescript
export const RATE_LIMIT_PRESETS = {
  // Increase for high-traffic APIs
  standard: {
    limit: 200, // was 100
    windowMs: 60_000,
  },
  // Decrease for sensitive endpoints
  auth: {
    limit: 3, // was 5
    windowMs: 60_000,
  },
};
```

## Monitoring

### Upstash Dashboard

Monitor your Redis usage:
- **Commands/sec**: Request rate
- **Memory usage**: Key storage
- **Connections**: Active clients

### Application Metrics

```typescript
import { getRateLimitStats } from "@repo/api/lib/rate-limit";

// Expose via health endpoint
app.get("/api/health/rate-limit", (c) => {
  return c.json(getRateLimitStats());
});
```

## Pricing Considerations

Upstash pricing is based on:
- **Commands**: Each rate limit check = 1-2 commands
- **Storage**: Minimal (keys expire automatically)
- **Bandwidth**: REST API data transfer

Estimated costs for rate limiting:
- **10K daily users**: ~$5-10/month
- **100K daily users**: ~$20-50/month
- **1M daily users**: Contact Upstash for volume pricing

## Fallback Behavior

If Redis is unavailable, the system automatically falls back to in-memory rate limiting:

```
[RateLimit] Redis error, falling back to in-memory: ConnectionError
```

This ensures your API remains protected even during Redis outages.

## Security Best Practices

1. **Rotate tokens regularly**: Generate new tokens monthly
2. **Use environment variables**: Never commit tokens to git
3. **Enable TLS**: Always use HTTPS connections (default)
4. **Restrict IP access**: Use Upstash IP allowlist if possible

## Troubleshooting

### "Redis not configured, using in-memory store"

**Cause**: Missing environment variables

**Solution**: Verify both variables are set:
```bash
echo $UPSTASH_REDIS_REST_URL
echo $UPSTASH_REDIS_REST_TOKEN
```

### "Failed to initialize Redis"

**Cause**: Invalid credentials or network issue

**Solution**:
1. Verify credentials in Upstash dashboard
2. Check for typos in URL/token
3. Ensure your deployment can reach Upstash (no firewall blocking)

### Rate limits not consistent across instances

**Cause**: Each instance using local memory

**Solution**: Verify Redis is connected in all instances

### High latency on rate limit checks

**Cause**: Database in distant region

**Solution**: Create database in region closest to your deployment

## Alternative Redis Providers

While Upstash is recommended, the system works with any Redis provider that supports REST API:

- **Redis Cloud** (redis.com)
- **AWS ElastiCache** (with REST proxy)
- **Self-hosted Redis** (with REST proxy)

Configure with the same environment variables:
```bash
UPSTASH_REDIS_REST_URL=https://your-redis-rest-endpoint
UPSTASH_REDIS_REST_TOKEN=your-auth-token
```

## Integration with Vercel

For Vercel deployments, use the Upstash integration:

1. Go to Vercel Dashboard
2. Navigate to **Integrations**
3. Search for **Upstash**
4. Click **Add Integration**
5. Select your project and Upstash database
6. Environment variables are automatically configured

## Related Documentation

- [Deployment Guide](../deployment.md)
- [Rate Limiting Implementation](../../packages/api/lib/rate-limit.ts)
- [Upstash Documentation](https://docs.upstash.com/redis)
