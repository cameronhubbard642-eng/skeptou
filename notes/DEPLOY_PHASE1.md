# Phase 1 Deployment Log — Sképtou

**DevOps / Deploy role | Last updated: 2026-05-12**

---

## DNS baseline (audited 2026-05-12)

Zone already on Cloudflare Registrar. Nameservers: `harleigh.ns.cloudflare.com` / `wells.ns.cloudflare.com`. No migration needed.

**Records to preserve — NEVER MODIFY:**

| Type | Name | Value | Notes |
|---|---|---|---|
| MX | `skeptou.com` | `mx01.mail.icloud.com` (priority 10) | iCloud mail delivery |
| MX | `skeptou.com` | `mx02.mail.icloud.com` (priority 10) | iCloud mail delivery |
| CNAME | `sig1._domainkey.skeptou.com` | `sig1.dkim.skeptou.com.at.icloudmailadmin.com` | **cf-proxied: false** — must stay DNS-only |
| TXT | `skeptou.com` | `v=spf1 include:icloud.com ~all` | iCloud SPF |
| TXT | `skeptou.com` | `apple-domain=YRJYW3FECEjfpdcj` | Apple domain verification |

**Records modified in Phase 1:**

| Type | Name | Old value | New value | Status |
|---|---|---|---|---|
| CNAME | `skeptou.com` | `default-page.cloudflareregistrar.com` (proxied) | `skeptou-apex.pages.dev` (proxied) | ⬜ pending |
| CNAME | `phronesis.skeptou.com` | *(none)* | `phronesis-skeptou.pages.dev` (proxied) | ⬜ pending |

**DMARC gap (flag to Cam):** No `_dmarc.skeptou.com` TXT record exists. Recommended addition (non-blocking):
```
_dmarc.skeptou.com.  TXT  "v=DMARC1; p=quarantine; rua=mailto:cam@skeptou.com"
```

---

## Deployment steps

### Step 1 — Apex Pages project (`skeptou.com`)

**Source:** `modules/apex/index.html`
**Project name:** `skeptou-apex`
**Public access:** Yes (no Access policy)

Cloudflare Dashboard procedure:
1. Workers & Pages → Create application → Pages → Upload assets
2. Upload the `modules/apex/` folder (contains `index.html`)
3. Project name: `skeptou-apex`
4. Deploy — note the assigned `*.pages.dev` URL

Via Wrangler CLI alternative:
```bash
cd modules/apex
npx wrangler pages deploy . --project-name=skeptou-apex
```

**DNS update after deploy:**
- In Cloudflare DNS, update the apex CNAME:
  - Name: `skeptou.com`
  - Target: `skeptou-apex.pages.dev`
  - Proxy status: Proxied ✓
- Confirm iCloud MX + TXT records untouched after edit

**Post-deploy verification:**
- [ ] `https://skeptou.com` loads placeholder (unauthenticated browser, incognito)
- [ ] Send test email TO `cam@skeptou.com` — confirm delivery
- [ ] Send test email FROM `cam@skeptou.com` — confirm delivery
- [ ] Visual check: Cormorant font, Parchment background (#fcf5e5), Purple body (#301934), Mauve rule

---

### Step 2 — Phronesis Pages project (`phronesis.skeptou.com`)

**Prerequisite:** Cloudflare Zero Trust team configured and Cam's account (camh502@alumni.stanford.edu) enrolled.

**Source:** `modules/phronesis/index.html`
**Project name:** `phronesis-skeptou`
**Access:** Cloudflare Access — Cam-only

Cloudflare Dashboard procedure:
1. Workers & Pages → Create application → Pages → Upload assets
2. Upload the `modules/phronesis/` folder
3. Project name: `phronesis-skeptou`
4. Deploy — note `*.pages.dev` URL

**DNS:**
- Add CNAME: `phronesis.skeptou.com` → `phronesis-skeptou.pages.dev` (Proxied ✓)

**Access policy (Zero Trust → Access → Applications):**
1. Add application → Self-hosted
2. Application name: `Phronesis`
3. Subdomain: `phronesis` / Domain: `skeptou.com`
4. Session duration: 24h (or per Cam's preference)
5. Policy: Allow — Email is `camh502@alumni.stanford.edu`
6. Authentication method: One-time PIN (or Google if Cam prefers)
7. Save and deploy

**Post-deploy verification (QA gate — mandatory before content):**
- [ ] Unauthenticated desktop browser → `https://phronesis.skeptou.com` → redirects to Access login (not placeholder visible)
- [ ] Unauthenticated mobile browser → same result
- [ ] Incognito / fresh session → same result
- [ ] Cam authenticates → placeholder loads correctly
- [ ] Visual check: Cormorant fallback font, Parchment/Purple/Mauve design tokens present

---

## DNS verification (DevOps pass — 2026-05-12 ~02:00 UTC)

Verified via MXToolbox against Cloudflare authoritative nameservers.

| Record | Expected | Verified | Status |
|---|---|---|---|
| NS | `harleigh.ns.cloudflare.com`, `wells.ns.cloudflare.com` | ✅ Match | ✅ |
| MX (×2) | `mx01/02.mail.icloud.com` priority 10 | ✅ Both present, Apple IPs | ✅ |
| SPF TXT | `v=spf1 include:icloud.com ~all` | ✅ Valid, syntax clean | ✅ |
| Apple TXT | `apple-domain=YRJYW3FECEjfpdcj` | ✅ Present | ✅ |
| DKIM CNAME | `sig1._domainkey → sig1.dkim.skeptou.com.at.icloudmailadmin.com` | ✅ DNS-only (not proxied) | ✅ |
| `skeptou.com` A | Cloudflare edge (CNAME-flattened) | ✅ `172.67.151.122`, `104.21.73.247` | ✅ |
| `phronesis.skeptou.com` A | Cloudflare edge (CNAME-flattened) | ✅ Same edge IPs | ✅ |

**All iCloud email-critical records confirmed untouched.**

## HTTP verification (DevOps pass — 2026-05-12)

| URL | Expected | Actual | Status |
|---|---|---|---|
| `https://skeptou.com` | Public placeholder (no auth) | ❌ **Redirects to Cloudflare Access OTP** | ⚠️ ISSUE |
| `https://phronesis.skeptou.com` | Access OTP gate | ✅ Redirects to Access OTP | ✅ |

**Divergence — apex over-gated:** `skeptou.com` has a Cloudflare Access Application applied to it (separate `kid` from phronesis; two distinct Access Applications exist). The apex must be public. This is a misconfiguration to resolve before QA.

**Likely cause:** An Access Application was created for the apex Pages project during Cam's setup, either intentionally (mistaken intent) or incidentally (Pages dashboard prompted one). The fix is simple:
- Zero Trust → Access → Applications → find the application whose domain is `skeptou.com` → delete it (or remove `skeptou.com` from its domain list if it covers multiple domains)
- Do NOT touch the phronesis application

## Status

| Item | Status | Notes |
|---|---|---|
| DNS audit | ✅ Complete | 2026-05-12 |
| Apex placeholder HTML | ✅ Built | `modules/apex/index.html` |
| Phronesis placeholder HTML | ✅ Built | `modules/phronesis/index.html` |
| Zero Trust configured | ✅ Complete | 2026-05-12; Cam enrolled |
| Phronesis Pages deploy | ✅ Complete | 2026-05-12; custom domain `phronesis.skeptou.com` live |
| Phronesis Access policy | ✅ Complete | OTP; Cam email only; gating confirmed active |
| Apex Pages deploy | ✅ Complete | 2026-05-12; custom domain `skeptou.com` live |
| iCloud email records | ✅ Verified | All 5 records intact post-deploy |
| **Apex Access over-gating** | ❌ **Must fix** | Apex has unexpected Access Application; must be removed |
| Email send/receive test | ⬜ Pending | After apex fix; prerequisite before QA apex pass |
| QA: Phronesis gating | ⬜ Pending | QA role — gating confirmed active; ready for multi-device check |
| QA: Apex visual + Lighthouse | ⬜ Pending | QA role — blocked on apex Access removal first |
