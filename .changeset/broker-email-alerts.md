---
"@beachside/cli": patch
---

`beachside broker` gains canary tokens and alert destinations, including email alerts: `beachside broker canary issue|list|show|revoke` and `beachside broker alert add slack|webhook|email`. Email alerts need a broker deployed with `BROKER_EMAIL_FROM` on a domain onboarded to Cloudflare Email Sending.
