# Threat Model — LookaBerry (S15)

> **Version**: 0.1.0 · **Date**: 2026-08-24 · **Status**: Living document
>
> This document describes the security threats, attack surfaces, and mitigations
> for the LookaBerry GTM Outbound Engine. It is updated with each sprint as new
> features and attack surfaces are introduced.

---

## 1. Trust Zones

```
┌─────────────────────────────────────────────────────────────┐
│                     Zone 0: Public Internet                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐          │
│  │ Webhook      │  │ REST API     │  │ MCP Client   │          │
│  │ Providers    │  │ Consumers    │  │ (stdio/SSE)  │          │
│  │ (Resend,     │  │ (Dashboard,  │  │              │          │
│  │  Smartlead,  │  │  CLI, CI/CD) │  │              │          │
│  │  Unipile,    │  └──────┬──────┘  └──────┬───────┘          │
│  │  Meta WA)    │         │                │                  │
│  └──────┬───────┘         │                │                  │
│         │                 │                │                  │
├─────────┼─────────────────┼────────────────┼──────────────────┤
│         │       Zone 1: API Gateway (Fastify)                  │
│         │                                                      │
│  ┌──────▼──────┐  ┌──────────────┐  ┌──────────────────┐      │
│  │ Webhook     │  │ Auth + RBAC  │  │ Rate Limiter     │      │
│  │ Auth (HMAC, │  │ (API Keys,   │  │ (Sliding Window, │      │
│  │  Svix,      │  │  Bearer,     │  │  Redis + Memory) │      │
│  │  SHA-256)   │  │  Permission) │  │                  │      │
│  └──────┬──────┘  └──────┬───────┘  └────────┬─────────┘      │
│         │                │                    │                │
├─────────┼────────────────┼────────────────────┼────────────────┤
│         │         Zone 2: Application Core                     │
│         │                                                      │
│  ┌──────▼──────────────────────────────────────────────┐      │
│  │            Execution Engine (BullMQ + Workers)       │      │
│  │  ┌──────────┐ ┌──────────┐ ┌────────────┐           │      │
│  │  │Dispatcher│ │Inbox     │ │Scheduler   │           │      │
│  │  │Worker    │ │Worker    │ │            │           │      │
│  │  └──────────┘ └──────────┘ └────────────┘           │      │
│  └─────────────────────────────────────────────────────┘      │
│         │                                                      │
│  ┌──────▼──────────────────────────────────────────────┐      │
│  │         Data Layer (PostgreSQL + Redis)              │      │
│  │  ┌──────────┐ ┌──────────┐ ┌────────────┐           │      │
│  │  │Prisma    │ │pgvector  │ │Redis Queue │           │      │
│  │  │(ORM)     │ │(Embed)   │ │(Cache/RL)  │           │      │
│  │  └──────────┘ └──────────┘ └────────────┘           │      │
│  └─────────────────────────────────────────────────────┘      │
│                                                               │
├───────────────────────────────────────────────────────────────┤
│                     Zone 3: External Services                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐        │
│  │LinkedIn  │ │Resend    │ │Meta WA   │ │Anthropic │        │
│  │(Antigrav)│ │(Email)   │ │(WhatsApp)│ │(LLM)     │        │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘        │
└───────────────────────────────────────────────────────────────┘
```

---

## 2. Threat Catalog

### T-01: Unauthorized API Access

| Property | Value |
| :--- | :--- |
| **Severity** | Critical |
| **Zone** | 1 (API Gateway) |
| **Vector** | Missing or weak API key; credential stuffing; leaked key |
| **Impact** | Full system access; data exfiltration; campaign sabotage |

**Mitigations (S7 + S15)**:
- S7: API key authentication via `Bearer` / `X-API-Key` header (auth.ts)
- S7: Rate limiting per key/IP (rateLimit.ts, sliding window w/ Redis)
- S7: Production safety check — server refuses to start without `API_KEYS` and `WEBHOOK_SECRET`
- S7: CORS restricted to explicit origins (never `*`)
- **S15: API key rotation** — keys can be rotated without downtime (`POST /api/v1/admin/api-keys/:id/rotate`)
- **S15: API key revocation** — immediate deactivation (`DELETE /api/v1/admin/api-keys/:id`)
- **S15: Auto-expiry** — keys with `expiresAt` are auto-deactivated
- **S15: RBAC** — ADMIN, OPERATOR, CAMPAIGN_MANAGER, VIEWER levels
- **S15: Campaign isolation** — CAMPAIGN_MANAGER/VIEWER restricted to assigned campaigns

**Residual Risk**: Low. Defense-in-depth with expiry, rotation, revocation, and RBAC.

---

### T-02: Webhook Signature Bypass / Replay

| Property | Value |
| :--- | :--- |
| **Severity** | High |
| **Zone** | 1 (API Gateway) |
| **Vector** | Missing/fake HMAC; replay of old webhook events |
| **Impact** | Feedback manipulation; duplicate event processing; metric distortion |

**Mitigations (S7, S14, S15)**:
- S7: HMAC-SHA256 webhook signatures with timestamp tolerance (±5 min) (webhookAuth.ts)
- S7: Svix signature validation for Resend
- S7: X-Hub-Signature-256 for Meta WhatsApp
- S7: Raw body capture in preParsing hook
- S14: Idempotency via `idempotency_keys` UNIQUE constraint
- S14: Atomic `INSERT ... ON CONFLICT DO NOTHING` (DB-level dedup)
- S14: In-memory negative cache (IdempotencyCache, 20K entries)
- S14: Status transition validation (cannot OPEN after BOUNCED)
- **S15: Webhook payload sanitization** — secrets stripped before storage
- **S15: Secrets masking** — API keys/tokens masked in logs

**Residual Risk**: Low. Triple layer: signature + idempotency + transition validation.

---

### T-03: Privilege Escalation / Horizontal Movement

| Property | Value |
| :--- | :--- |
| **Severity** | High |
| **Zone** | 2 (Application Core) |
| **Vector** | VIEWER accessing ADMIN endpoints; CAMPAIGN_MANAGER reading other campaigns |
| **Impact** | Unauthorized data access; cross-campaign data leak; configuration tampering |

**Mitigations (S15)**:
- **S15: RBAC matrix** — each action/resource combination gated by permission level
- **S15: Campaign isolation** — `canAccessCampaign()` checks `campaignIds` allowlist
- **S15: Admin routes** — `requireAdmin()` / `requireOperator()` preHandlers on every admin endpoint
- **S15: Audit trail** — all permission violations logged with severity WARNING+

**Residual Risk**: Low. Fine-grained access control at the middleware layer.

---

### T-04: PII Exposure / Data Breach

| Property | Value |
| :--- | :--- |
| **Severity** | Critical |
| **Zone** | 2 (Application Core), 3 (External Services) |
| **Vector** | Lead data exposed in logs/errors; webhook payloads stored with PII; no data lifecycle |
| **Impact** | LGPD/GDPR violation (fines up to 4% revenue); reputational damage |

**Mitigations (S7, S15)**:
- S7: Security headers (no-store, CSP, referrer-policy: no-referrer)
- S7: Input validation (depth limit, size limit, content-type enforcement)
- **S15: Data retention policies** — configurable per entity type (defaults: LEAD 730d, tracking 90d, webhooks 30d)
- **S15: Lead anonymization** — irreversible SHA-256 hashing of all PII fields
- **S15: Manual anonymization** — admin endpoint for right-to-erasure requests
- **S15: Scheduled anonymization** — auto-anonymize after retention period
- **S15: Secrets masking** — `sanitizeObject()`, `sanitizeText()`, `safeStringify()` on all log/error paths
- **S15: Webhook payload sanitization** — credentials stripped before DB insert

**Residual Risk**: Low-Medium. Anonymization must be enabled via retention policy in production.

---

### T-05: Opt-Out Circumvention / Spam

| Property | Value |
| :--- | :--- |
| **Severity** | High |
| **Zone** | 2 (Application Core) |
| **Vector** | Lead receives messages after unsubscribing; opt-out limited to one channel |
| **Impact** | CAN-SPAM/LGPD violation; domain blacklisting; provider account suspension |

**Mitigations (S15)**:
- **S15: Global suppression list** — EMAIL, DOMAIN, LINKEDIN_URL checked before every send
- **S15: Unsubscribe cascade** — single opt-out cancels ALL active sequences across ALL channels
- **S15: Automatic domain suppression** — domain added to suppression list when lead unsubscribes
- **S15: shouldBlockLead()** — dispatcher checks suppression list before any outbound action
- **S15: Audit trail** — all unsubscribe events logged for compliance

**Residual Risk**: Low. Multi-channel cascade + pre-send checks.

---

### T-06: Secrets Leak via Logs/Errors

| Property | Value |
| :--- | :--- |
| **Severity** | Medium |
| **Zone** | 1 (API Gateway), 2 (Application Core) |
| **Vector** | API keys/tokens in structured logs; passwords in error messages |
| **Impact** | Credential compromise through log aggregation systems |

**Mitigations (S15)**:
- **S15: Pattern-based masking** — `sk_`, `lb_`, `whsec_`, `Bearer` patterns detected and redacted
- **S15: Key-level redaction** — any field matching `api_key`, `token`, `secret`, `password` etc. → `[REDACTED]`
- **S15: `safeStringify()`** — JSON serialization that auto-sanitizes secrets
- **S15: `sanitizeText()`** — text-based log entries scanned for API key patterns
- **S15: `sanitizeWebhookPayload()`** — provider-specific redaction rules (Resend, Smartlead, Unipile)

**Residual Risk**: Low. Comprehensive pattern + key-name based masking.

---

### T-07: LinkedIn Account Ban / Detection

| Property | Value |
| :--- | :--- |
| **Severity** | Medium |
| **Zone** | 3 (External Services — Antigravity Bridge) |
| **Vector** | Aggressive automation triggers LinkedIn anti-bot detection |
| **Impact** | Account suspension; campaign interruption; IP reputation damage |

**Mitigations (S5 + S11)**:
- S5: Anti-ban engine: quotas (15-25 connects/day), gaussian jitter (45-210s), 48h pause on CAPTCHA/429
- S5: Circuit breaker: auto-quarantine on security check detection
- S11: Multi-account rotation via `OutreachAccount.sessionKey`
- S11: Proxy isolation per account (residential IPs)

**Residual Risk**: Low-Medium. LinkedIn heuristics are proprietary and evolving.

---

### T-08: Denial of Service (API)

| Property | Value |
| :--- | :--- |
| **Severity** | Medium |
| **Zone** | 1 (API Gateway) |
| **Vector** | High-volume requests exhausting CPU/memory/DB connections |
| **Impact** | Service unavailable; queue saturation; legitimate requests blocked |

**Mitigations (S7 + S12 + S14)**:
- S7: Rate limiting (sliding window, Redis + memory fallback)
- S7: Body size limit (default 1MB)
- S7: JSON depth limit (max 20 levels)
- S12: Health endpoint timeouts (2s per check)
- S14: Queue backpressure (BullMQ concurrency limiting)
- S14: DLQ for permanently failed jobs (prevents retry storms)

**Residual Risk**: Medium. Rate limiter effective for simple attacks; volumetric attacks require infrastructure-level protection (WAF, CDN).

---

## 3. Residual Risk Matrix

| Threat | Severity | Residual | Confidence |
| :--- | :---: | :---: | :---: |
| T-01 Unauthorized API Access | Critical | Low | High |
| T-02 Webhook Replay | High | Low | High |
| T-03 Privilege Escalation | High | Low | High |
| T-04 PII Exposure | Critical | Low-Medium | Medium |
| T-05 Opt-Out Circumvention | High | Low | High |
| T-06 Secrets in Logs | Medium | Low | High |
| T-07 LinkedIn Ban | Medium | Low-Medium | Medium |
| T-08 DoS (API) | Medium | Medium | Medium |

---

## 4. Security Controls by Layer

### 4.1 Network & Transport
- TLS/HTTPS terminated at reverse proxy (production)
- CORS: explicit origin allowlist (never `*`)
- Security headers: HSTS, CSP, X-Frame-Options, X-Content-Type-Options
- Input validation: content-type enforcement, body size/depth limits

### 4.2 Authentication & Authorization
- API key auth: `Bearer` or `X-API-Key` header
- Env-var based keys (fast path) + DB-based keys (S15)
- RBAC: ADMIN, OPERATOR, CAMPAIGN_MANAGER, VIEWER
- Campaign-scoped isolation for non-ADMIN roles

### 4.3 Webhook Security
- HMAC-SHA256 signatures with timestamp replay protection (±5 min)
- Svix (Resend), X-Hub-Signature-256 (Meta WhatsApp)
- Idempotency: DB UNIQUE constraint + in-memory cache
- State transition validation (no backward transitions)

### 4.4 Data Protection
- PII anonymization: irreversible SHA-256 hashing
- Configurable data retention policies per entity
- Scheduled anonymization (opt-in via retention policy)
- Secrets masking in logs, webhook payloads, error messages

### 4.5 Audit & Compliance
- Structured audit log: action, actor, target, IP, severity
- Compliance actions preserved (never purged)
- Unsubscribe cascade with full audit trail
- Production safety checks (refuse start without credentials)

### 4.6 Resilience
- Rate limiting: distributed (Redis) + local fallback
- Dead-Letter Queue for permanently failed jobs
- Exponential backoff with full jitter
- Graceful degradation (memory fallbacks for Redis-dependent features)

---

## 5. Security Roadmap

| Sprint | Focus | Status |
| :--- | :--- | :---: |
| S7 | Authentication, rate limiting, webhook signatures, security headers | ✅ Done |
| S11 | Account resolution, session management, multi-account isolation | ✅ Done |
| S14 | Idempotency, backoff, DLQ, locking, recovery | ✅ Done |
| **S15** | **API key rotation/revocation, RBAC, audit trail, suppression, anonymization, threat model** | **✅ Done** |
| S16 (planned) | 2FA/MFA, IP allowlisting, WebAuthn | 🔜 |
| S17 (planned) | Advanced anomaly detection, SIEM integration | 🔜 |