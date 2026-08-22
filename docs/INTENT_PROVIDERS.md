# Intent Providers — LookaBerry S2

## Status model

Provider runs return an explicit status. These labels describe the code path that actually ran:

| Status | Meaning |
| :--- | :--- |
| `IMPLEMENTED` | The provider can collect and normalize the supplied public input. |
| `PARTIALLY_IMPLEMENTED` | Some inputs produced signals while another input or provider path failed or was unavailable. |
| `REQUIRES_CREDENTIALS` | Collection requires an authenticated external adapter that is not configured. |
| `NOT_AVAILABLE` | The required URL, crawl result, snapshot, or normalized data was not supplied. |
| `FALLBACK` | A provider is deliberately using a local fallback path. |
| `FAILED` | Collection or normalization failed. |
| `TIMEOUT` | Collection exceeded the configured timeout. |

A provider failure is returned in `provider_runs`; it does not silently become a successful signal.

## Contract

The core provider contract is implemented in `src/core/intent/providers/types.ts`:

- `id`, `type`, `source`, `cost`, and default `ttlDays` identify the provider;
- `getAvailability` reports whether the provider can run for a specific input;
- `collect` only collects raw observations;
- `normalize` converts raw observations to signals with provenance, confidence, classification, TTL, and sanitized payloads.

The runner in `src/core/intent/providers/runner.ts` separates collection from normalization and handles provider failure, timeout, unavailable inputs, partial failure, and cost aggregation.

## Initial providers

### Website changes — `website-changes`

**Status: IMPLEMENTED for supplied snapshots or public URLs.** Cost is zero.

The provider compares current and previous crawl content using a SHA-256 hash. A detected difference between two snapshots is classified as `FACT`. A change asserted by the agent without a previous snapshot is classified as `UNVERIFIED`; it is never promoted to `FACT` automatically. The default TTL is 14 days.

The repository does not yet persist a dedicated website snapshot history. Callers that need comparison across runs must provide the previous snapshot or persist that state in their crawl layer.

### Hiring — `hiring`

**Status: IMPLEMENTED for normalized postings, public HTML, or a public careers URL.** Cost is zero.

The provider accepts normalized `job_postings`, JSON-LD `JobPosting` records, or conservative public HTML selectors. Each posting becomes a `HIRING` signal classified as `FACT`, with a default TTL of 30 days. Official company-domain pages receive higher source quality than third-party job boards.

No authenticated LinkedIn, job-board, or paid hiring API integration is claimed by this provider.

### Public announcements — `public-announcements`

**Status: IMPLEMENTED for normalized public items, public HTML, or a public announcements URL.** Cost is zero.

Announcements are classified deterministically as `FUNDING` when their title or kind matches funding, investment, acquisition, merger, or IPO terms. Other items become `PUBLIC_ANNOUNCEMENT`. Public announcement signals are `FACT` when directly observed in the supplied public source. The default TTL is 45 days; funding signals use 60 days.

This provider does not validate financial claims against a paid data source.

### Funding API — `funding-api`

**Status: REQUIRES CREDENTIALS.**

The registry exposes an explicit credential-gated adapter boundary, but no paid funding API is connected. It throws a typed `REQUIRES_CREDENTIALS` result and must not be described as a live funding integration.

## Signal persistence

Signals are persisted in `intent_signals` and may link to the shared S1 graph:

- `provider_id`, `signal_type`, `source`, `source_url`;
- `observed_at`, `expires_at`, and `ttl_days`;
- `confidence`, `source_quality`, `intent_weight`, and `cost`;
- `evidence_classification`, preserving `FACT`, `INFERENCE`, `LLM_INFERENCE`, `USER_PROVIDED`, and `UNVERIFIED` as distinct values;
- `normalized_data`, sanitized `raw_payload`, `metadata`, `content_hash`, and `deduplication_key`;
- optional links to `Source` and `CompanyEvidence`.

New provider inputs pass through the existing evidence sanitization rules. Sensitive object keys and sensitive URL query parameters are redacted before persistence. The S2 migration backfills the new provenance fields while preserving legacy payload content; new ingestion paths sanitize `raw_payload`, `normalized_data`, and `metadata` in TypeScript before persistence.

## Deterministic scoring

`scoreAndRankLeads` remains SQL-based and does not call an LLM. Active signals are weighted by:

1. remaining TTL and recency;
2. confidence;
3. source quality;
4. configured signal-type multiplier;
5. evidence classification multiplier;
6. explicit intent weight.

Signals with the same deduplication key are counted once for score contribution. Expired and inactive signals contribute zero. Stable ID tie-breaking keeps ranking deterministic.

The vector component remains dependent on the embedding source. The existing ICP engine can use `text-embedding-3-small` with `OPENAI_API_KEY`; the intent ingestion path intentionally uses the deterministic SHA-256 company embedding fallback to remain token-free. That fallback does **not** represent semantic similarity, regardless of whether an OpenAI key is configured for other flows.

## MCP compatibility

`gtm_detect_intent_signals` still accepts the existing `signals` input shape. It additionally accepts `collection_inputs`, `provider_ids`, and `provider_timeout_ms`, and returns additive `provider_runs` plus signal provenance fields. `gtm_score_and_rank_leads` keeps its existing input and output fields, with additive signal count fields.

The provider registry is local and extensible. External credentials, paid data sources, crawl scheduling, and production queue orchestration remain outside this sprint.
