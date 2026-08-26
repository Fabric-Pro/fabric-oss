/**
 * Technical Architecture Document Prompt Configuration
 *
 * Expert-level prompt for generating comprehensive architecture documents
 * that guide implementation and enable long-term system maintainability.
 */

import type { DocumentPromptConfig } from "../types";

export const ARCHITECTURE_PROMPT: DocumentPromptConfig = {
	id: "architecture",
	name: "Technical Architecture Document",

	persona: `You are a principal software architect with 20+ years of experience designing large-scale distributed systems. You have architected systems serving billions of requests at companies like AWS, Netflix, and leading tech firms.

Your architecture documents are known for:
- Clear explanation of design decisions and trade-offs
- Practical consideration of operational concerns
- Appropriate balance between detail and readability
- Focus on system qualities (scalability, reliability, security)
- Professional architecture diagrams using mermaid syntax
- Anticipating future evolution while solving present needs

CRITICAL SECTIONS TO ALWAYS INCLUDE:
1. System Overview/Summary - what the system does and why it exists
2. High-Level Architecture/Components - major components and how they interact (with diagram)
3. Technology Stack - languages, frameworks, databases, infrastructure choices
4. Data Architecture - data models, storage, data flow
5. Security Considerations - authentication, authorization, encryption, compliance
6. Scalability & Performance - how the system scales, performance targets
7. Deployment/Infrastructure - how the system is deployed (environments, CI/CD)

You may combine related sections (e.g., "Security & Compliance" or "Performance & Scalability") but ensure all critical topics are covered.

DIAGRAM NOTE: When creating architecture diagrams, you can use either:
- C4 mermaid syntax (C4Context, C4Container) for formal architecture
- Standard mermaid flowcharts for simpler diagrams
Both are acceptable. Focus on clarity over strict format.`,

	sections: [
		{
			name: "Document Metadata",
			required: true,
			guidance: `Provide document control information:

**Document Version**: Version number (e.g., v1.0, v2.1)

**Document Status**: Draft | In Review | Approved | Active | Deprecated

**Architect(s)**: Principal/lead architects responsible for this design

**Contributors**: Other engineers who contributed to the architecture

**Reviewers**: Technical reviewers and approvers

**Last Updated**: Date of last significant update

**Review Date**: When this architecture should be reviewed next

**Target System**: Name and version of the system this document describes`,
			example: `## Document Metadata

| Field | Value |
|-------|-------|
| **Version** | v2.1 |
| **Status** | Approved |
| **Lead Architect** | Michael Chen (Principal Engineer) |
| **Contributors** | Sarah Johnson (Backend Lead), David Kim (Infrastructure) |
| **Reviewers** | Jane Smith (CTO), Tech Council |
| **Last Updated** | January 15, 2024 |
| **Next Review** | July 2024 (or when significant changes occur) |
| **Target System** | Payment Processing Platform v3.0 |`,
		},
		{
			name: "System Overview",
			required: true,
			guidance: `Provide high-level context:

**Purpose**: What business problem does this system solve?

**Scope**: What this architecture covers and doesn't cover.

**Key Stakeholders**: Who will use, maintain, and operate this system?

**System Context**: How this fits into the broader ecosystem.

**System Context Diagram**: Use a C4Context mermaid diagram to show the system and its external interfaces:

\`\`\`mermaid
C4Context
title System Context for [System Name]
Person(user, "User Type", "Description of user")
System(system, "System Name", "What the system does")
System_Ext(external, "External System", "External dependency")
Rel(user, system, "Uses")
Rel(system, external, "Integrates with")
\`\`\`

Write this section so that a new team member can quickly understand what the system does and why it exists.`,
		},
		{
			name: "Stakeholder Concerns Matrix",
			required: true,
			guidance: `Document what each stakeholder group cares about in this architecture:

**For Each Stakeholder Group** (Developers, Operations, Security, Business, End Users):

| Stakeholder | Primary Concerns | How Architecture Addresses |
|-------------|-----------------|---------------------------|
| Developers | Maintainability, clear interfaces, testing | Hexagonal architecture, dependency injection |
| Operations | Reliability, observability, deployment | 99.9% SLA, comprehensive monitoring |
| Security | Data protection, access control | Zero-trust model, encryption at rest/transit |
| Business | Cost, time-to-market, scalability | Cloud-native, auto-scaling, managed services |
| End Users | Performance, availability, privacy | <200ms P95, 99.95% uptime, GDPR compliant |

**Cross-Stakeholder Trade-offs**: Where concerns conflict and how decisions were made.`,
			example: `## Stakeholder Concerns Matrix

| Stakeholder | Primary Concerns | How Architecture Addresses | Acceptance Criteria |
|-------------|-----------------|---------------------------|---------------------|
| **Development Team** | Code maintainability, clear APIs, fast feedback loops | • Hexagonal architecture with clear bounded contexts<br>• OpenAPI specs for all services<br>• Hot reload in dev environment (< 2s) | • New developer can contribute within 1 week<br>• 90%+ test coverage<br>• CI pipeline < 10 min |
| **Operations/SRE** | Reliability, observability, incident response | • Comprehensive logging (structured JSON)<br>• Distributed tracing (OpenTelemetry)<br>• Auto-scaling based on CPU/memory<br>• Blue-green deployments for zero-downtime | • 99.9% uptime SLA<br>• MTTD < 5 min<br>• MTTR < 30 min<br>• All incidents have actionable alerts |
| **Security Team** | Data protection, compliance, access control | • Zero-trust network architecture<br>• Encryption at rest (AES-256) and in transit (TLS 1.3)<br>• Row-level security in database<br>• API rate limiting & DDoS protection | • Pass quarterly pentest<br>• PCI DSS compliant<br>• SOC 2 Type II certified<br>• 0 P0/P1 security vulnerabilities |
| **Product/Business** | Time-to-market, cost efficiency, feature velocity | • Modular microservices enable parallel development<br>• Managed cloud services reduce operational overhead<br>• Feature flags for safe progressive rollout | • Deploy to prod 5x per week<br>• Infrastructure cost < $50K/month<br>• New feature launch < 2 sprints |
| **End Users** | Performance, availability, data privacy | • CDN for static assets (edge caching)<br>• Database read replicas in multiple regions<br>• GDPR-compliant data handling | • P95 response time < 200ms<br>• 99.95% availability<br>• Data export available within 24 hours |
| **Compliance/Legal** | Regulatory adherence, audit trails | • Immutable audit logs (7-year retention)<br>• Data residency controls by region<br>• Automated compliance checks in CI/CD | • Pass annual compliance audits<br>• All data access logged<br>• GDPR Article 17 (right to deletion) automated |

### Cross-Stakeholder Trade-offs

**Trade-off 1: Microservices Complexity vs. Team Autonomy**
- **Conflict**: Operations wanted monolith for simplicity; Product wanted microservices for team velocity
- **Decision**: Microservices with strong operational tooling (service mesh, centralized logging)
- **Rationale**: Business priority is fast feature delivery; invested in SRE team to manage complexity

**Trade-off 2: Cost vs. Availability**
- **Conflict**: Finance wanted single-region to reduce costs; Business wanted multi-region for 99.99% availability
- **Decision**: Active-passive multi-region (primary + hot standby)
- **Rationale**: 99.95% (active-passive) meets SLA while saving 40% vs. active-active

**Trade-off 3: Feature Velocity vs. Test Coverage**
- **Conflict**: Product wanted faster releases; Engineering wanted comprehensive testing
- **Decision**: 80% coverage minimum for merge, 90% for production deployment
- **Rationale**: Pragmatic balance - critical paths well-tested, edge cases can ship with lower coverage`,
		},
		{
			name: "Architecture Principles & Decisions",
			required: true,
			guidance: `Document the guiding principles and key decisions:

**Architecture Principles**:
List 5-7 principles guiding design decisions (e.g., "Prefer managed services over self-hosted", "Design for horizontal scaling").

**Architecture Decision Records (ADRs)**:
Use Michael Nygard's ADR format for each major decision:

**ADR Template**:
- **Number & Title**: ADR-001: [Short noun phrase]
- **Status**: Proposed | Accepted | Deprecated | Superseded by ADR-XXX
- **Context**: Forces at play (technical, political, social, project). What is the issue motivating this decision?
- **Decision**: What is the change that we're proposing or have agreed to?
- **Consequences**: What becomes easier or more difficult to do because of this change? Both positive and negative consequences.

**Best Practices**:
- Write ADRs when you make significant architectural decisions
- Keep ADRs immutable once accepted (create new ADR to supersede)
- Number sequentially (ADR-001, ADR-002, etc.)
- Store with code (e.g., docs/architecture/decisions/)
- Link related ADRs

These ADRs provide crucial context for future maintainers and explain WHY decisions were made.`,
		},
		{
			name: "Quality Attributes",
			required: true,
			guidance: `Define quality requirements using ISO/IEC 25010 quality model:

**Performance Efficiency**:
- Response time targets (P50, P95, P99)
- Throughput requirements (requests/sec, transactions/sec)
- Resource utilization limits (CPU, memory, disk, network)

**Reliability**:
- Availability targets (uptime SLA)
- Fault tolerance (MTBF, MTTR)
- Recoverability (RTO, RPO)

**Security**:
- Authentication & authorization mechanisms
- Data confidentiality (encryption standards)
- Integrity (data validation, checksums)
- Non-repudiation (audit trails)

**Maintainability**:
- Modularity (cohesion, coupling metrics)
- Reusability (shared components, libraries)
- Analyzability (logging, monitoring, debugging)
- Modifiability (time to implement changes)
- Testability (test coverage, automated testing)

**Portability**:
- Adaptability (cloud provider independence)
- Installability (deployment automation)
- Replaceability (standard interfaces)

**Usability** (for developer-facing systems):
- Learnability (onboarding time)
- Operability (ease of use)
- Documentation completeness`,
			example: `## Quality Attributes

### Performance Efficiency

| Metric | Target | Measurement | Current |
|--------|--------|-------------|---------|
| API Response Time (P50) | < 50ms | APM monitoring | 35ms |
| API Response Time (P95) | < 200ms | APM monitoring | 180ms |
| API Response Time (P99) | < 500ms | APM monitoring | 420ms |
| Throughput | 10,000 req/s | Load testing | 12,500 req/s |
| Database Query Time (P95) | < 20ms | Slow query log | 15ms |
| CPU Utilization (avg) | < 60% | CloudWatch | 45% |
| Memory Utilization (avg) | < 70% | CloudWatch | 55% |

**Performance Budget**: 
- Page load: < 1.5s Time to Interactive
- API endpoints: < 200ms P95
- Database queries: < 50ms P95
- External API calls: < 1s timeout

### Reliability

| Attribute | Target | Measurement | Current |
|-----------|--------|-------------|---------|
| **Availability** | 99.95% (21.9 min/month) | Uptime monitoring | 99.97% |
| **Error Rate** | < 0.1% | Error tracking | 0.05% |
| **MTBF** (Mean Time Between Failures) | > 30 days | Incident logs | 45 days |
| **MTTR** (Mean Time To Repair) | < 30 minutes | Incident logs | 22 minutes |
| **RTO** (Recovery Time Objective) | < 1 hour | DR drills | 45 minutes |
| **RPO** (Recovery Point Objective) | < 15 minutes | Backup frequency | 5 minutes |

**Fault Tolerance**:
- Graceful degradation: Core features remain available when dependencies fail
- Circuit breakers: Open after 5 consecutive failures, 30s cooldown
- Retry strategy: Exponential backoff (1s, 2s, 4s, 8s max)
- Bulkheads: Isolated thread pools per service dependency

### Security

| Requirement | Implementation | Compliance |
|-------------|----------------|------------|
| **Authentication** | OAuth 2.0 + JWT (15-min expiry) | ✅ NIST 800-63B |
| **Authorization** | RBAC + ABAC policies | ✅ |
| **Encryption at Rest** | AES-256-GCM | ✅ FIPS 140-2 |
| **Encryption in Transit** | TLS 1.3 only (no TLS 1.2) | ✅ PCI DSS 4.0 |
| **Secrets Management** | AWS Secrets Manager + rotation | ✅ |
| **API Rate Limiting** | 1000 req/min per user, 10000 per org | ✅ |
| **DDoS Protection** | AWS Shield + CloudFlare | ✅ |
| **Vulnerability Scanning** | Snyk (daily) + quarterly pentests | ✅ |
| **Audit Logging** | All data access logged, 7-year retention | ✅ SOC 2 |

### Maintainability

| Attribute | Target | Current | Trend |
|-----------|--------|---------|-------|
| **Cyclomatic Complexity** | < 10 per function | 7.2 avg | ⬇️ Improving |
| **Test Coverage** | > 90% | 93% | ⬆️ Improving |
| **Code Duplication** | < 3% | 2.1% | ➡️ Stable |
| **Technical Debt Ratio** | < 5% | 4.2% | ⬇️ Improving |
| **Mean Time to Deploy** | < 15 minutes | 12 minutes | ➡️ Stable |
| **Deployment Frequency** | > 5 per week | 8 per week | ⬆️ Improving |
| **Change Failure Rate** | < 5% | 3.2% | ⬇️ Improving |

**Maintainability Practices**:
- Hexagonal architecture: Clear separation of concerns
- Dependency injection: Easy mocking for tests
- API versioning: Backward compatibility for 2 versions
- Feature flags: Safe rollout without code changes
- Comprehensive documentation: Architecture decision records (ADRs)

### Portability

| Requirement | Implementation |
|-------------|----------------|
| **Cloud Agnostic** | Infrastructure as Code (Terraform) abstracts provider |
| **Container-based** | Docker images run on any container orchestrator |
| **Database Abstraction** | Prisma ORM supports multiple databases |
| **Vendor Lock-in Mitigation** | Avoid AWS-specific services where possible |
| **Data Export** | Standard formats (JSON, CSV, Parquet) |

### Usability (Developer Experience)

| Attribute | Target | Current |
|-----------|--------|---------|
| **Onboarding Time** | < 1 day to first commit | 4 hours avg |
| **Local Setup Time** | < 15 minutes | 10 minutes |
| **API Documentation** | 100% endpoints documented | 100% |
| **Error Messages** | Actionable with resolution steps | 95% |
| **Hot Reload Time** | < 2 seconds | 1.5 seconds |`,
		},
		{
			name: "Cross-Cutting Concerns",
			required: true,
			guidance: `Document architectural concerns that span multiple components:

**Logging**:
- Logging strategy (structured logging format)
- Log levels and when to use each
- Log aggregation and retention
- Sensitive data redaction

**Monitoring & Observability**:
- Metrics collected (RED/USE methods)
- Distributed tracing approach
- Health checks and readiness probes
- Alerting strategy

**Configuration Management**:
- Environment-specific configuration
- Secrets management
- Feature flags
- Configuration validation

**Caching**:
- Caching layers (CDN, application, database)
- Cache invalidation strategies
- Cache warming
- TTL policies

**Error Handling**:
- Error classification (transient vs. permanent)
- Retry strategies
- Circuit breakers
- Error reporting and tracking

**API Versioning**:
- Versioning strategy (URL, header, content negotiation)
- Backward compatibility policy
- Deprecation process

**Authentication & Authorization**:
- Authentication flow
- Token management
- Authorization model (RBAC, ABAC)
- Session management`,
			example: `## Cross-Cutting Concerns

### Logging

**Strategy**: Structured JSON logging with consistent schema across all services

\`\`\`json
{
  "timestamp": "2024-01-15T10:30:00Z",
  "level": "INFO",
  "service": "payment-api",
  "trace_id": "abc123",
  "span_id": "def456",
  "user_id": "user_789",
  "message": "Payment processed successfully",
  "duration_ms": 145,
  "metadata": {
    "payment_id": "pay_xyz",
    "amount": 9999,
    "currency": "usd"
  }
}
\`\`\`

**Log Levels**:
| Level | When to Use | Examples | Retention |
|-------|-------------|----------|-----------|
| **ERROR** | Errors requiring immediate attention | Payment failed, database unreachable | 90 days |
| **WARN** | Recoverable issues, degraded state | Rate limit hit, retry initiated | 30 days |
| **INFO** | Business events, state changes | Payment successful, user logged in | 30 days |
| **DEBUG** | Detailed diagnostic info | SQL queries, cache hits/misses | 7 days |

**Sensitive Data Redaction**:
- Credit card numbers: Show last 4 digits only
- API keys: Never log (replace with "[REDACTED]")
- Passwords: Never log
- PII: Hash before logging in non-production

**Log Aggregation**: Datadog (production), CloudWatch (staging), local files (dev)

### Monitoring & Observability

**Metrics Framework**: Prometheus + Grafana

**RED Method** (for request-driven services):
- **Rate**: Requests per second
- **Errors**: Error rate as percentage
- **Duration**: P50, P95, P99 latencies

**USE Method** (for resources):
- **Utilization**: % time resource is busy
- **Saturation**: Queue depth, wait time
- **Errors**: Error count

**Key Dashboards**:
1. **Service Health**: Request rate, error rate, latency, availability
2. **Infrastructure**: CPU, memory, disk, network by service
3. **Business Metrics**: Payments processed, revenue, conversion rate
4. **User Experience**: Page load times, API response times, error rates

**Distributed Tracing**: OpenTelemetry → Jaeger
- Trace 100% of errors
- Trace 1% of successful requests (sampled)
- Trace all requests > 1 second

**Health Checks**:
- \`/health/live\`: Is the service running? (returns 200 if alive)
- \`/health/ready\`: Can the service accept traffic? (checks dependencies)
- Kubernetes readiness probes use \`/health/ready\`

**Alerting Strategy**:
| Alert | Condition | Severity | Response Time | Notification |
|-------|-----------|----------|---------------|--------------|
| Service Down | 0 healthy instances | P0 | Immediate | PagerDuty + SMS |
| High Error Rate | > 1% for 5 min | P1 | 15 min | PagerDuty |
| High Latency | P95 > 500ms for 5 min | P1 | 15 min | PagerDuty |
| Low Availability | < 99.9% over 1 hour | P2 | 1 hour | Slack |
| High CPU | > 80% for 10 min | P2 | 1 hour | Slack |

### Configuration Management

**Configuration Hierarchy** (least to most specific):
1. Default values in code
2. Environment-specific config files (config/production.yml)
3. Environment variables (12-factor app)
4. Runtime feature flags (LaunchDarkly)

**Secrets Management**:
- AWS Secrets Manager for production
- Automatic rotation every 90 days
- No secrets in code or git (enforced by pre-commit hook)
- Development uses \`.env.local\` (gitignored)

**Feature Flags**:
- Infrastructure: LaunchDarkly
- Types: Boolean, percentage rollout, user targeting
- All new features behind flags by default
- Flags removed within 2 weeks of 100% rollout

**Configuration Validation**:
- Schema validation on application startup
- Fail-fast if invalid configuration detected
- Warnings for deprecated configuration keys

### Caching Strategy

**Multi-Layer Caching**:

| Layer | Technology | Use Case | TTL | Invalidation |
|-------|------------|----------|-----|--------------|
| **CDN** | CloudFlare | Static assets, public API responses | 1 hour | Cache-Control headers |
| **App Cache** | Redis | Session data, rate limits, user profiles | 15 min | Event-based + TTL |
| **Database** | PostgreSQL | Query results, aggregations | 5 min | Write-through |
| **Client** | Browser | Static assets, API responses | Varies | ETag validation |

**Cache Invalidation**:
- **Write-through**: Update cache on write operations
- **Event-based**: Invalidate on domain events (user updated, product changed)
- **TTL-based**: Fallback for cache misses
- **Purge API**: Manual invalidation endpoint for emergencies

**Cache Warming**: Pre-populate cache for:
- Homepage data on deployment
- Top 100 products every hour
- User sessions on login

### Error Handling

**Error Classification**:
| Type | Examples | Retry? | User Message |
|------|----------|--------|--------------|
| **Client Errors (4xx)** | Invalid input, unauthorized | No | Show validation errors |
| **Server Errors (5xx)** | Database down, timeout | Yes | "Something went wrong, try again" |
| **Transient Errors** | Network blip, rate limit | Yes (with backoff) | Auto-retry, then show error |

**Retry Strategy**:
- Exponential backoff: 1s, 2s, 4s, 8s (max 4 retries)
- Jitter: Add ±25% randomness to prevent thundering herd
- Idempotency keys: Safe to retry payment operations

**Circuit Breaker**:
- Opens after 5 consecutive failures
- Half-open after 30 seconds (try 1 request)
- Close if request succeeds, re-open if fails

**Error Tracking**: Sentry
- Group errors by stack trace
- Attach user context, breadcrumbs
- Alert on new error types
- Alert on 10x spike in existing errors

### API Versioning

**Strategy**: URL path versioning (\`/v1/\`, \`/v2/\`)

**Backward Compatibility**:
- Support 2 major versions concurrently
- Deprecation notice: 6 months before removal
- Add new fields (don't remove or rename)
- Make new fields optional, not required

**Deprecation Process**:
1. Announce deprecation (release notes, email, docs)
2. Add \`Deprecation\` header with sunset date
3. Monitor usage of deprecated endpoints
4. Remove after 6 months (or when usage < 0.1%)

**Version Migration**:
- Provide migration guides in documentation
- Offer API call to migrate resources
- Show deprecation warnings in API responses

### Authentication & Authorization

**Authentication Flow**: OAuth 2.0 + JWT

1. User logs in with email/password
2. Server validates credentials
3. Server issues JWT (access token: 15 min, refresh token: 7 days)
4. Client includes access token in \`Authorization: Bearer <token>\` header
5. Client uses refresh token to get new access token when expired

**Authorization Model**: RBAC (Role-Based Access Control) + ABAC (Attribute-Based)

**Roles**:
- **Admin**: Full system access
- **Manager**: Manage team, view all data
- **Member**: Access own data only
- **Viewer**: Read-only access

**Permissions**: Defined per resource (e.g., \`payment:read\`, \`payment:write\`, \`user:delete\`)

**Session Management**:
- Stateless JWT (no session storage)
- Refresh token stored in httpOnly cookie
- Token revocation: Maintain blocklist in Redis (TTL = token expiry)
- Concurrent sessions: Max 5 active sessions per user`,
		},
		{
			name: "System Components",
			required: true,
			guidance: `Detail each major component:

**Container Diagram**: Use a C4Container mermaid diagram showing all containers and their relationships:

\`\`\`mermaid
C4Container
title Container diagram for [System Name]

Person(user, "User", "Description")

System_Boundary(boundary, "System Name") {
    Container(web, "Web Application", "React, Next.js", "Serves the user interface")
    Container(api, "API Server", "Node.js, Express", "Handles business logic")
    ContainerDb(db, "Database", "PostgreSQL", "Stores application data")
    Container(worker, "Background Worker", "Node.js", "Processes async jobs")
}

Rel(user, web, "Uses", "HTTPS")
Rel(web, api, "Calls", "REST/JSON")
Rel(api, db, "Reads/Writes", "SQL")
Rel(api, worker, "Queues jobs", "Redis")
\`\`\`

**For Each Component**:
- **Name & Purpose**: What it does and why it exists
- **Responsibilities**: What this component is responsible for
- **Interfaces**: APIs, events, or other integration points
- **Dependencies**: What it depends on
- **Technology Stack**: Languages, frameworks, databases
- **Scaling Characteristics**: How it scales (vertical, horizontal)
- **Failure Modes**: What happens when it fails

Group related components into logical subsystems or domains.`,
		},
		{
			name: "Data Architecture",
			required: true,
			guidance: `Document data design decisions:

**Data Model Overview**: Use an ER diagram to show the conceptual data model:

\`\`\`mermaid
erDiagram
    USER ||--o{ ORDER : places
    USER {
        string id PK
        string email
        string name
        datetime created_at
    }
    ORDER ||--|{ ORDER_ITEM : contains
    ORDER {
        string id PK
        string user_id FK
        string status
        datetime created_at
    }
    PRODUCT ||--o{ ORDER_ITEM : "ordered in"
    PRODUCT {
        string id PK
        string name
        decimal price
    }
    ORDER_ITEM {
        string id PK
        string order_id FK
        string product_id FK
        int quantity
    }
\`\`\`

**Data Stores**:
For each database/storage system:
- Type (relational, document, key-value, etc.)
- Purpose and what data it stores
- Sizing and capacity planning
- Backup and recovery strategy

**Data Flow**: How data moves through the system.

**Data Partitioning**: Sharding, partitioning strategies.

**Data Consistency**: Consistency requirements and strategies (eventual vs. strong).

**Data Retention**: How long data is kept, archival strategy.

**Data Privacy**: PII handling, encryption, compliance.`,
		},
		{
			name: "Integration Architecture",
			required: true,
			guidance: `Document how the system connects to others:

**Integration Diagram**: Use a sequence diagram to show key integration flows:

\`\`\`mermaid
sequenceDiagram
    participant C as Client
    participant A as API Gateway
    participant S as Service
    participant E as External API
    participant D as Database

    C->>A: Request
    A->>A: Authenticate
    A->>S: Forward Request
    S->>D: Query Data
    D-->>S: Data
    S->>E: External Call
    E-->>S: Response
    S-->>A: Result
    A-->>C: Response
\`\`\`

**External Systems**:
For each integration:
- System name and purpose
- Integration pattern (REST, GraphQL, events, files)
- Data exchanged
- SLAs and availability expectations
- Error handling strategy

**API Design**:
- API style and conventions
- Versioning strategy
- Authentication/authorization approach

**Event Architecture** (if applicable):
- Event types and schemas
- Message broker details
- Event sourcing considerations

**Synchronous vs. Asynchronous**: When each is used and why.`,
		},
		{
			name: "Infrastructure & Deployment",
			required: true,
			guidance: `Document infrastructure and deployment approach:

**Infrastructure Diagram**: Use a flowchart to show cloud resources and network topology:

\`\`\`mermaid
flowchart TB
    subgraph Internet
        U[Users]
    end

    subgraph Cloud["Cloud Provider"]
        subgraph Edge["Edge Layer"]
            CDN[CDN]
            LB[Load Balancer]
        end

        subgraph Compute["Compute Layer"]
            WEB1[Web Server 1]
            WEB2[Web Server 2]
            API1[API Server 1]
            API2[API Server 2]
        end

        subgraph Data["Data Layer"]
            DB[(Primary DB)]
            DBR[(Read Replica)]
            CACHE[(Redis Cache)]
        end
    end

    U --> CDN
    CDN --> LB
    LB --> WEB1 & WEB2
    WEB1 & WEB2 --> API1 & API2
    API1 & API2 --> DB & CACHE
    DB --> DBR
\`\`\`

**Environment Strategy**:
- Development, staging, production environments
- Environment parity approach

**Cloud/Hosting**:
- Cloud provider(s) and services used
- Region and availability zone strategy
- Resource sizing

**Deployment Architecture**:
- Container orchestration (K8s, ECS, etc.)
- Deployment strategy (blue-green, canary, rolling)
- Infrastructure as Code approach

**CI/CD Pipeline**: Build, test, deploy workflow.

**Configuration Management**: How config differs by environment.`,
		},
		{
			name: "Security Architecture",
			required: true,
			guidance: `Document security design:

**Security Principles**: Guiding security philosophy.

**Authentication & Authorization**:
- Identity provider and protocol (OAuth, SAML)
- Authorization model (RBAC, ABAC, policies)
- Token management

**Network Security**:
- Network segmentation
- Firewall rules and security groups
- TLS/encryption in transit

**Data Security**:
- Encryption at rest
- Key management
- Secrets management

**Security Monitoring**:
- Logging and audit trails
- Intrusion detection
- Vulnerability scanning

**Compliance**: Relevant standards (SOC2, GDPR, HIPAA, PCI-DSS).`,
		},
		{
			name: "Reliability & Operations",
			required: true,
			guidance: `Document operational concerns:

**Availability Targets**: SLA/SLO objectives.

**Fault Tolerance**:
- Single points of failure and mitigation
- Redundancy approach
- Failover mechanisms

**Disaster Recovery**:
- RTO and RPO targets
- Backup strategy
- Recovery procedures

**Monitoring & Observability**:
- Metrics collected
- Logging strategy
- Distributed tracing
- Alerting approach

**Incident Response**:
- On-call structure
- Escalation procedures
- Runbooks

**Capacity Planning**: How to identify and handle growth.`,
		},
		{
			name: "Performance & Scalability",
			required: true,
			guidance: `Document performance considerations:

**Performance Requirements**:
- Latency targets (p50, p95, p99)
- Throughput requirements
- Concurrent user expectations

**Scalability Strategy**:
- Horizontal vs. vertical scaling
- Auto-scaling policies
- Bottleneck analysis

**Caching Strategy**:
- What is cached and where
- Cache invalidation approach
- CDN usage

**Performance Testing**:
- Load testing approach
- Performance benchmarks
- Profiling strategy`,
		},
		{
			name: "Glossary",
			required: true,
			guidance: `Define domain-specific terms and acronyms used in this document:

| Term | Definition | Context |
|------|------------|---------|
| CAP | Consistency, Availability, Partition tolerance theorem | Distributed systems |
| CQRS | Command Query Responsibility Segregation | Architecture pattern |

**Include**:
- Domain-specific terminology
- Technical acronyms
- Architecture patterns referenced
- System-specific terms`,
			example: `## Glossary

| Term | Definition | Context/Usage |
|------|------------|---------------|
| **API Gateway** | Entry point for all client requests, handles routing, auth, rate limiting | Kong gateway at \`api.company.com\` |
| **BFF** | Backend for Frontend - API layer tailored to specific client needs | Separate BFF for web vs. mobile |
| **Blue-Green Deployment** | Deployment strategy with two identical environments (blue=current, green=new) | Used for zero-downtime releases |
| **CAP Theorem** | Trade-off between Consistency, Availability, and Partition tolerance | We chose AP (availability over consistency) |
| **Circuit Breaker** | Design pattern that prevents cascading failures by failing fast | Hystrix pattern for external API calls |
| **CQRS** | Command Query Responsibility Segregation - separate read/write models | Used in order processing service |
| **Event Sourcing** | Storing state changes as sequence of events | Applied to payment transactions |
| **Hexagonal Architecture** | Architecture pattern with core domain isolated from external dependencies | Also called "Ports & Adapters" |
| **Idempotency** | Operation that produces same result when called multiple times | Critical for payment operations |
| **Multi-Tenancy** | Single instance serving multiple customers with data isolation | SaaS architecture pattern |
| **RTO** | Recovery Time Objective - max acceptable downtime | Our RTO: 1 hour |
| **RPO** | Recovery Point Objective - max acceptable data loss | Our RPO: 15 minutes |
| **Saga Pattern** | Managing distributed transactions across microservices | Order fulfillment workflow |
| **Service Mesh** | Infrastructure layer for service-to-service communication | Istio for traffic management |
| **Sidecar Pattern** | Helper container deployed alongside main application | Used for logging, metrics collection |
| **Strangler Fig Pattern** | Incrementally migrating from legacy to new system | Our v2 migration strategy |
| **TLS** | Transport Layer Security - encryption protocol | Minimum version: TLS 1.3 |
| **TTL** | Time To Live - expiration time for cached data | Varies by cache layer |

### Domain-Specific Terms

| Term | Definition |
|------|------------|
| **Payment Authorization** | Temporary hold on funds, not yet captured |
| **Payment Capture** | Actual transfer of funds from authorization |
| **Chargeback** | Customer dispute resulting in payment reversal |
| **Settlement** | Final transfer of funds from payment processor to merchant |
| **Tokenization** | Replacing sensitive card data with secure token |
| **3D Secure** | Authentication protocol for online card payments |`,
		},
		{
			name: "Architecture Review Checklist",
			required: false,
			guidance: `Provide a checklist for architecture review (optional):

**Alignment**:
- [ ] Aligns with organizational architecture principles
- [ ] Follows established patterns and standards
- [ ] Integrates well with existing systems

**Quality Attributes**:
- [ ] Performance requirements clearly defined and achievable
- [ ] Security requirements addressed comprehensively
- [ ] Scalability approach documented
- [ ] Reliability/availability targets realistic

**Technical Debt**:
- [ ] Technical debt acknowledged and quantified
- [ ] Plan to address critical debt items
- [ ] Trade-offs between speed and quality documented

**Operational Readiness**:
- [ ] Monitoring and alerting strategy defined
- [ ] Deployment and rollback procedures documented
- [ ] Disaster recovery plan in place
- [ ] Runbooks created for operational procedures

**Documentation**:
- [ ] All ADRs captured and reviewed
- [ ] External dependencies documented
- [ ] Data flows clearly illustrated
- [ ] Stakeholder concerns addressed`,
			example: `## Architecture Review Checklist

### Alignment with Standards
- [x] Follows company hexagonal architecture pattern
- [x] Uses approved technology stack (TypeScript, PostgreSQL, Redis)
- [x] Integrates with existing auth service (OAuth 2.0)
- [x] Uses standard observability stack (OpenTelemetry → Datadog)
- [x] Follows API design guidelines (REST, OpenAPI 3.1)

### Quality Attributes
- [x] Performance: P95 < 200ms target defined and validated via load testing
- [x] Security: Penetration test completed, 0 high/critical vulnerabilities
- [x] Scalability: Horizontal scaling validated to 50K RPS
- [x] Reliability: 99.95% availability achievable with multi-AZ deployment
- [x] Maintainability: Test coverage > 90%, cyclomatic complexity < 10

### Technical Debt
- [x] Legacy payment provider integration acknowledged (~$2K/month)
- [x] Migration plan to new provider documented (Q3 2024)
- [ ] Monorepo splitting deferred to 2025 (acceptable trade-off)
- [x] Known limitations documented (single-region for Phase 1)

### Security & Compliance
- [x] PCI DSS Level 1 compliance validated
- [x] GDPR compliance verified (data residency controls)
- [x] Encryption at rest (AES-256) and in transit (TLS 1.3)
- [x] Secrets management via AWS Secrets Manager
- [x] Rate limiting and DDoS protection configured
- [x] Audit logging for all payment operations

### Operational Readiness
- [x] Monitoring dashboards created (service health, infrastructure, business metrics)
- [x] Alerting rules defined and tested (PagerDuty integration)
- [x] Deployment runbook documented (blue-green deployment process)
- [x] Rollback procedure tested in staging
- [x] Disaster recovery plan documented (RTO: 1h, RPO: 15min)
- [x] Incident response procedures defined
- [ ] Load shedding strategy pending (implement before Black Friday)

### Documentation & Knowledge Sharing
- [x] 12 ADRs captured and reviewed
- [x] C4 diagrams complete (context, container, component for payment service)
- [x] API documentation published (OpenAPI 3.1 spec)
- [x] Onboarding guide created (new developers productive in < 1 day)
- [x] Architecture presentation delivered to engineering team
- [x] Office hours scheduled for Q&A

### Stakeholder Sign-off
- [x] Engineering: CTO approved (Jan 10)
- [x] Product: VP Product approved (Jan 12)
- [x] Security: CISO approved (Jan 15)
- [x] Operations: VP Engineering approved (Jan 15)
- [ ] Finance: Awaiting cost projection review
- [x] Legal: Compliance approved (Jan 14)

### Review Outcome
**Status**: ✅ **Approved with Conditions**

**Conditions**:
1. Finance approval on infrastructure costs (expected: Jan 18)
2. Load shedding strategy implemented before Q4 peak season

**Next Review**: July 2024 or when significant changes occur`,
		},
		{
			name: "Future Considerations",
			required: false,
			guidance: `Document future evolution:

**Known Limitations**: Current constraints that may need addressing.

**Technical Debt**: Intentional shortcuts and plan to address.

**Evolution Path**: How the architecture might evolve.

**Migration Strategy**: If replacing existing systems, the transition plan.

**Extensibility Points**: Where the system is designed to be extended.`,
		},
	],

	qualityChecklist: [
		"Document metadata is complete (version, architect, reviewers, status)",
		"Stakeholder concerns matrix identifies all key stakeholders and their needs",
		"Quality attributes (ISO 25010) defined with measurable targets",
		"Cross-cutting concerns comprehensively addressed (logging, monitoring, config, caching, errors)",
		"ADRs follow Michael Nygard format with context, decision, and consequences",
		"Architecture decisions include context, options, and rationale",
		"All components have clear responsibilities and boundaries",
		"Data flows are documented with consistency requirements",
		"Security is addressed comprehensively (auth, encryption, compliance)",
		"Operational concerns are addressed (monitoring, DR, incident response)",
		"Performance requirements are specific with measurable targets",
		"C4 diagrams use proper syntax (C4Context, C4Container, C4Component) - NOT flowchart",
		"Trade-offs are explicitly acknowledged and cross-stakeholder conflicts documented",
		"Glossary defines all technical terms and domain-specific terminology",
		"Future evolution is considered without over-engineering",
	],

	antiPatterns: [
		"Architecture decisions without documented rationale",
		"Missing or unclear component boundaries",
		"Ignoring operational concerns (monitoring, debugging, deployment)",
		"Security as an afterthought rather than designed in",
		"No consideration of failure modes",
		"Over-engineering for hypothetical future requirements",
		"Diagrams that are too complex to understand",
		"Missing data flow and consistency considerations",
		"Using basic flowchart (graph LR/TD) instead of proper C4 syntax for architecture",
	],

	additionalInstructions: `IMPORTANT DIAGRAM INSTRUCTIONS:

For architecture documents, you MUST use proper C4 mermaid diagram syntax. The editor renders these as beautiful visual diagrams.

CORRECT - Use this syntax:
\`\`\`mermaid
C4Context
    title System Context Diagram
    Person(user, "User", "Description")
    System(system, "System", "Description")
    Rel(user, system, "Uses")
\`\`\`

WRONG - Never use this for architecture:
\`\`\`mermaid
graph LR
    User -->|Uses| System
\`\`\`

C4 diagram types:
- C4Context: High-level view showing system and external actors
- C4Container: Shows containers (apps, databases, services) within the system
- C4Component: Shows components within a container

Always use \`\`\`mermaid as the code fence, then start with C4Context, C4Container, or C4Component.`,

	examples: {
		goodADR: `### ADR-001: Use PostgreSQL for Primary Data Store

**Status**: Accepted (2024-01-10)

**Context**: 
We need to select a primary database for our payment processing platform. The system will store:
- User accounts and profiles (10M users projected)
- Payment transactions (100K daily, financial data requiring ACID)
- Merchant configurations (50K merchants)
- Audit logs (compliance requirement: 7-year retention)

Forces at play:
- Team has 5+ years PostgreSQL experience, 0 MongoDB experience
- Financial transactions require strong consistency (ACID)
- Must support complex joins and aggregations for reporting
- Budget: $5K/month for database infrastructure
- Must scale to 1M transactions/day within 3 years

**Decision**: 
We will use PostgreSQL 15 (managed via AWS RDS) as our primary data store, with:
- Multi-AZ deployment for high availability
- Read replicas for read-heavy operations (2x replicas initially)
- Connection pooling via PgBouncer
- Automatic backups with 30-day retention

**Consequences**:

*Positive*:
- Team can be immediately productive (no learning curve)
- ACID transactions provide data integrity for financial operations
- Excellent support for complex queries and joins needed for reporting
- Mature ecosystem: ORMs (Prisma), migration tools (Flyway), monitoring (pg_stat_statements)
- Managed RDS reduces operational burden (automated backups, patching, scaling)
- Proven at scale: Discord (5M+ concurrent users), Instagram, Uber use PostgreSQL

*Negative*:
- Vertical scaling limits: Single-node write bottleneck beyond ~100K transactions/sec
- Manual sharding required if we exceed RDS instance limits (unlikely within 3 years)
- No native geo-distribution (must use active-passive replication for DR)
- Higher cost than DynamoDB for read-heavy workloads (mitigated by read replicas)

*Risks*:
- If transaction volume grows beyond projections, may need to migrate to distributed SQL (CockroachDB)
- If we expand globally, multi-region writes will require significant re-architecture

*Mitigations*:
- Monitor write throughput monthly; alert if approaching 50K writes/sec
- Design schema with sharding in mind (user_id as partition key)
- Review decision annually or if hitting 500K transactions/day

**Related Decisions**:
- ADR-002: Use Prisma ORM for database access
- ADR-005: Redis for caching and session storage (offloads read traffic)`,

		goodComponent: `### Order Service

**Purpose**: Manages order lifecycle from creation to fulfillment.

**Responsibilities**:
- Order creation and validation
- Order status management
- Integration with payment and inventory services

**Interfaces**:
- REST API: \`/api/v1/orders\`
- Events Published: \`order.created\`, \`order.updated\`, \`order.completed\`
- Events Consumed: \`payment.completed\`, \`inventory.reserved\`

**Technology**: Node.js, TypeScript, Express
**Data Store**: PostgreSQL (orders database)
**Scaling**: Horizontal, stateless, 2-10 instances based on load

**Failure Modes**:
- Database unavailable: Return 503, queue orders for retry
- Payment service timeout: Hold order in pending, retry with backoff`,
	},
};
