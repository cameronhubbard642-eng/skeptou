# Strategia D1 Migrations

Database: `skeptou-strategia`

## DevOps setup

```bash
# 1. Create the D1 database (run once)
wrangler d1 create skeptou-strategia
# Paste the returned database_id into wrangler.toml [[d1_databases]]

# 2. Apply migrations
wrangler d1 migrations apply skeptou-strategia --remote

# 3. Verify
wrangler d1 info skeptou-strategia
# Expect: tables = [documents, audit_log], views = [live_documents]
```

## Migration log

| File | Description |
|---|---|
| `0001_initial_schema.sql` | documents + audit_log tables; immutability trigger |
| `0002_indexes.sql` | Performance indexes; live_documents view |

## Smoke test (after migrations)

```bash
# Seed a test markdown doc
wrangler r2 object put skeptou-strategia/test/test-doc.md \
  --file /tmp/test-doc.md --content-type text/markdown

wrangler d1 execute skeptou-strategia --remote --command \
  "INSERT INTO documents VALUES ('test-doc','Test Doc','test','cam','brief','text/markdown','test/test-doc.md',1234,strftime('%Y-%m-%dT%H:%M:%SZ','now'),NULL,'[]','{}')"
```
