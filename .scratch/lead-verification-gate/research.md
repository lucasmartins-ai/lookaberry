# Lead verification gate + delivery dossier — research

Date: 2026-10-16. Question: how do competitors make sure a lead's contact is real before handing it over, what does their "delivery" contain, and where is the gap LookaBerry can own?

## Evidence

- Web research (search summaries, ~14 queries) on Clay, Apollo, ZoomInfo, Cognism, Lusha, Seamless, Instantly, Smartlead, Lemlist, Amplemarket, Unify, Common Room, 11x/Artisan, Dropcontact, Hunter, Kaspr, FullEnrich, BetterContact, Findymail, Speedio, Econodata, Casa dos Dados, Meetime/Reev/Exact/Ramper, Outscraper, Apify, PhantomBuster. Most prices/accuracy numbers come from vendor or competitor blogs: treat as unverified.
- Primary source fetched with lookacrawler: Apollo KB "How Apollo Verifies Emails" — SMTP first, then a contributor network of linked mailboxes to judge catch-all addresses; claims 91% accuracy for "verified".
- FullEnrich "triple-verified" page returned HTTP 410 (removed). Mechanism below comes from secondary sources.
- REA: browser-scenario capture needs a Playwright scenario schema the CLI does not document; not run. No third-party code was read or copied.

## How they do it (our words)

| Vendor | Verification | Delivery |
|---|---|---|
| FullEnrich | Waterfall over 20+ providers; every email through 3 verifiers, any "invalid" → keep searching; tiers Deliverable / High-probability catch-all / Catch-all / Invalid; phones checked for line type and owner name | email + phone + tier |
| BetterContact | Waterfall + one verifier (syntax, domain, MX, mailbox); pay only on valid | email + phone |
| Clay | Waterfall columns + Claygent (LLM browsing) research columns; no per-claim citation found | spreadsheet rows |
| Apollo | SMTP + contributor-network engagement; only Verified/Unverified labels | contact record |
| Speedio / Econodata | Receita Federal CNPJ registry + extra sources; registry contacts are company-level and often the accountant's | company + phones |
| Outscraper / Apify | raw Maps listings, verification is a paid add-on | listing fields |
| 11x / Artisan | AI SDR writes and sends | sent messages; top complaint: generic "obviously AI" copy |

## Gaps (ranked) and what we build

1. **No per-field provenance.** Nobody hands over *why* a contact is trusted. → Every delivered contact carries the list of independent confirmations (deliverability re-check, domain match, seen on the company site, matches the company WhatsApp/identity record).
2. **Single-source trust / catch-all.** A value from one provider is accepted as-is. → Double check: a contact is delivered only with ≥2 independent confirmations; a re-verification runs at delivery time, not only at enrichment.
3. **Fake/placeholder data from Maps/registry for BR SMBs.** Repeated/sequential numbers, wrong DDD, landline sold as WhatsApp, `teste@`, disposable domains. → Deterministic fake detectors (BR DDD table, mobile 9-digit rule, repeated/sequential, placeholder names/emails, disposable domains).
4. **AI-slop personalization.** → Shared anti-slop lint (pt-BR + en phrases, unfilled placeholders, "not X, it's Y", exclamation/em-dash/emoji spam) and a numbers-must-exist-in-payload check, applied to generated messages and to the delivery's approach suggestions.
5. **Delivery = rows, not a dossier.** → `gtm_build_lead_delivery`: only leads that pass the gate, each with company profile, observed site facts (platform, WhatsApp link, booking, analytics, HTTPS), signals and FACT evidence with source URL/date, and approach suggestions that cite the facts they rest on. Leads with nothing verifiable to say are dropped and listed under `rejected` with reasons.

Not built now (open): CNPJ ↔ Maps fusion (gap 6), WhatsApp-registered check (ToS/compliance unverified), multi-verifier consensus with paid APIs (needs keys).
