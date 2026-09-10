# gist-decrypt

A small Docker service that downloads an encrypted Gist on every request,
decrypts Clash Mi AES-128-CBC content, and returns the original file.
Built on Node.js 24 LTS with no third-party runtime dependencies.

**No application cache, no saved plaintext, no stale fallback.** Each download
request makes its own upstream request. Responses include `Cache-Control: no-store`.
Upstream requests also request cache revalidation; GitHub's CDN behavior remains
outside this service's control.

## Quick start

Download `docker-compose.yml` and `.env.example`, or clone this repository:

```sh
git clone https://github.com/rsivanov-git/gist-decrypt.git
cd gist-decrypt
cp .env.example .env
chmod 600 .env
```

Edit `.env` with the same password used in Clash Mi's **Decrypt Password** field:

```dotenv
GIST_URL=https://gist.githubusercontent.com/OWNER/GIST_ID/raw/Proxy-List.txt
DECRYPT_PASSWORD='YOUR_CLASH_MI_PASSWORD'
```

These are the two service configuration variables. The password is used as exact
UTF-8 text, without trimming or Base64 decoding. Use single quotes in `.env` for
literal values containing `$`, `#` or spaces (follow Compose dotenv escaping rules
if the password itself contains quotes). `PROXY_ENCRYPTION_KEY` and `AAD` are no
longer used. You can also set the two variables directly in Compose.
Do not commit real keys or secret Gist URLs. No GitHub token is required to read
a secret Gist using its raw URL. Use the URL without a commit/revision segment
so future Gist updates are picked up. HTML `gist.github.com` pages are not accepted.

```sh
docker compose pull
docker compose up -d
curl --fail http://127.0.0.1:8080/
```

The image is `ghcr.io/rsivanov-git/gist-decrypt:latest`. For reproducible updates,
replace `latest` with a published version from the Clash Mi-compatible release or an image digest.
The example binds **only to host localhost**, not all host interfaces.
The container runs as a non-root user with a read-only filesystem and dropped
Linux capabilities. No volumes or writable files are needed.

### Tailscale access

With Tailscale already installed and connected on the Docker host:

```sh
tailscale serve --bg http://127.0.0.1:8080
tailscale serve status
```

Open the HTTPS address printed by Tailscale (the root `/` returns the file) and use it
from an authorized tailnet device. HTTPS setup may require enabling HTTPS in
the tailnet. If this host already has a Serve configuration, choose an unused
Serve port or integrate the route instead of overwriting an existing service.
This example uses the existing host identity and requires no tag or SSH changes.

Use Tailscale **Serve**, not Funnel, to keep the endpoint within the tailnet.
The application has no separate authentication: tailnet access policy controls
who can retrieve plaintext. Do not expose port 8080 publicly. Caddy is optional;
if used, it only needs to reverse proxy to this service.

Reference: [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve).

## HTTP interface

| Request | Result |
| --- | --- |
| `GET /` | Fresh upstream fetch, decryption, original bytes with `text/plain; charset=utf-8` |
| `GET /healthz` | `200 ok`; process liveness only, without contacting GitHub |
| Other paths | `404` |
| Methods other than GET | `405` |
| Upstream error, timeout, invalid Base64, padding or UTF-8 | `502`; no plaintext is returned |

Port is fixed at `8080`. Upstream timeout is 15 seconds; maximum encrypted
response size is 1 MiB. Redirects are rejected. The configured URL is restricted
to HTTPS raw files on `gist.githubusercontent.com`, without query strings,
credentials or revision IDs. The Gist URL cannot be supplied by an HTTP client.
Client disconnects abort the fetch. Keys, Gist URLs and response contents are not
logged. Conditional request headers are not forwarded; the service never returns
an application-generated `304`.

## Encryption compatibility

The file is a Base64 string containing `IV || ciphertext`, without a JSON envelope:

- Cipher: AES-128-CBC with PKCS7 padding.
- Key: the 16 raw bytes of MD5 of the UTF-8 password, not the ASCII hex digest.
- IV: the first 16 decoded bytes; ciphertext: all remaining bytes.
- Plaintext: non-empty, valid UTF-8. Its original bytes are preserved.
- Leading/trailing whitespace and embedded CR/LF are accepted; URL-safe Base64
  and omitted padding are supported as in Dart's Base64 decoder.

Implementation reference: [Clash Mi ProfileDecryptUtils](https://github.com/KaringX/clashmi/blob/92b4bfc6639328513b601a0a75b7d7b90ff85f82/lib/app/utils/profile_decrypt_utils.dart).

This format has **no authentication tag**. Padding and UTF-8 validation cannot
reliably detect tampering or every wrong password. MD5 here is required for
compatibility and is not a slow password KDF. Use a strong password and a trusted
HTTPS source. This service buffers the result until validation finishes.

The service decrypts every upstream body using this format; it does not require
an `encryption-subscription` header. Its response is plaintext, so clients fetching
from this service should leave **Decrypt Password** empty.

## Local development and tests

With Node.js 24 or newer:

```sh
npm test
node --env-file=.env src/server.mjs
```

Tests use synthetic encrypted fixtures and mock upstream responses; they do not
require private Gists or real secrets. They cover UTF-8 byte preservation, malformed ciphertext,
padding and encoding validation, password derivation, configuration validation, fresh fetches, upstream failures,
response size limits, timeouts, health and routing.

Build locally:

```sh
docker build -t gist-decrypt:local .
docker run --rm --env-file .env -p 127.0.0.1:8080:8080 gist-decrypt:local
```

## Release images

CI tests every push to `main` and pull request and validates the Docker build.
Publishing a GitHub Release triggers `.github/workflows/release-image.yml`:

1. Run tests on the release revision.
2. Build and push `linux/amd64` and `linux/arm64` images to GHCR.
3. Publish release and semantic version tags; stable releases also update `latest`.

For a stable `v1.2.3` release the tags are `v1.2.3`, `1.2.3`, `1.2`, `1`,
and `latest`. Prereleases do not update `latest`. Use semantic version release
tags. Publish releases from `main` after CI succeeds. The workflow follows the
same release-image approach as `lampa-imdb-ratings` and uses `GITHUB_TOKEN` with
`packages: write`; no personal registry token or decryption key is needed in CI.

After the first image publication, ensure the GHCR package visibility is public
in its package settings: GitHub packages can initially be private even when the
source repository is public. Public packages support anonymous pulls.

Reference: [GitHub Container Registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

## Upgrade from AES-GCM versions (v1.x)

This is a breaking format change. Re-encrypt the upstream Gist using the Clash Mi
format above and the chosen password. Existing AES-256-GCM JSON files cannot be
read by this version. Replace `PROXY_ENCRYPTION_KEY` and `AAD` in `.env` with
`DECRYPT_PASSWORD`, and use the updated Compose file. Coordinate the Gist and
service switch to avoid requests failing during migration.

Until a compatible release image is published, build this revision locally using
the commands above; pulling an older `latest` image will not install these changes.
After publication, run `docker compose pull` and `docker compose up -d`.

For the existing Tailscale Service named `proxy-list`, the backend remains:

```sh
sudo tailscale serve --bg --service=svc:proxy-list --https=443 http://127.0.0.1:8080
```
