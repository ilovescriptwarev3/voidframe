# keychain :8087

Encrypted secret store for Voidframe. Secrets are sealed with AES-256-GCM, keyed
by `scrypt(VF_MASTER_KEY)` with a per-file IV and auth tag, and written to
`data/secrets.json` with an atomic rename. Values are returned only when a single
secret is read by name; list responses never include them.

Set `VF_KEYCHAIN_DATA_DIR` to store the file elsewhere, `PORT` to change the port
and `VF_SERVICE_TOKEN` to change the service token (default `dev-token-change-me`).

Every route except `GET /healthz` requires `x-vf-token: $VF_SERVICE_TOKEN`.

## Endpoints

### Health

```sh
curl http://localhost:8087/healthz
```

### Service description

```sh
curl -H "x-vf-token: dev-token-change-me" http://localhost:8087/
```

### Create or replace a secret

```sh
curl -X POST http://localhost:8087/v1/secrets \
  -H "x-vf-token: dev-token-change-me" \
  -H "content-type: application/json" \
  -d '{"name":"OPENAI_KEY","value":"sk-...","meta":{"provider":"openai"}}'
```

### List secret names and metadata (never values)

```sh
curl -H "x-vf-token: dev-token-change-me" http://localhost:8087/v1/secrets
```

### Read one secret (decrypted)

```sh
curl -H "x-vf-token: dev-token-change-me" http://localhost:8087/v1/secrets/OPENAI_KEY
```

### Rotate a secret

```sh
curl -X POST http://localhost:8087/v1/secrets/OPENAI_KEY/rotate \
  -H "x-vf-token: dev-token-change-me" \
  -H "content-type: application/json" \
  -d '{"value":"sk-new"}'
```

### Delete a secret

```sh
curl -X DELETE -H "x-vf-token: dev-token-change-me" \
  http://localhost:8087/v1/secrets/OPENAI_KEY
```

### Redact known secrets from text

```sh
curl -X POST http://localhost:8087/v1/redact \
  -H "x-vf-token: dev-token-change-me" \
  -H "content-type: application/json" \
  -d '{"text":"my key is sk-..."}'
```

Redacted occurrences become `[redacted:<name>]`, longest value first.

## Errors

| status | code                  | when                                         |
| ------ | --------------------- | -------------------------------------------- |
| 400    | `invalid_json`        | body is not a JSON object                    |
| 400    | `invalid_name`        | name is empty, too long or has bad characters|
| 400    | `invalid_value`       | value is not a string                        |
| 400    | `invalid_meta`        | meta is not an object                        |
| 400    | `invalid_text`        | redact request has no string `text`          |
| 401    | `unauthorized`        | missing or wrong `x-vf-token`                |
| 404    | `secret_not_found`    | the named secret does not exist              |
| 404    | `not_found`           | unknown route                                |
| 405    | `method_not_allowed`  | method not supported on that path            |
| 413    | `payload_too_large`   | body exceeds 1 MiB                           |

## Test

```sh
node test.mjs
```
