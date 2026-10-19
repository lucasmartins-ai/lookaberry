# Security policy

## Reporting a vulnerability

Email **lucas@lookadev.com** with the subject `lookaberry security`, with steps to
reproduce and the commit. You will get a reply within 5 working days. Please do not
open a public issue for security reports.

## Data protection

LookaBerry stores prospect data (company, contact, interactions) in your own
PostgreSQL database. It provides tools that support GDPR/LGPD work: a suppression
list with multi-channel opt-out cascade, API key lifecycle, RBAC and an audit
trail. Whoever runs a deployment is the controller and is responsible for its
lawful basis and sending rules (for example PECR consent rules for sole traders
in the UK, and WhatsApp's opt-in policy).

Known gap: outbound email does not yet add a `List-Unsubscribe` header or an
unsubscribe footer. Add one before sending marketing email at volume.

## Supported versions

Only `main` receives fixes.
