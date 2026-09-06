# gist-decrypt

A small Docker service that downloads an encrypted Gist on every request,
authenticates and decrypts AES-256-GCM content, and returns the original file.
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

Edit `.env` with the **existing key used to encrypt your Gist**:

```dotenv
GIST_URL=https://gist.githubusercontent.com/OWNER/GIST_ID/raw/Proxy-List.txt
PROXY_ENCRYPTION_KEY=YOUR_EXISTING_32_BYTE_KEY_IN_BASE64
```

These are the only service configuration variables. You can alternatively set
both values directly in the `environment` section of `docker-compose.yml`.
Do not commit real keys or secret Gist URLs. No GitHub token is required to read
a secret Gist using its raw URL. Use the URL without a commit/revision segment
so future Gist updates are picked up. HTML `gist.github.com` pages are not accepted.

```sh
docker compose pull
docker compose up -d
curl --fail http://127.0.0.1:8080/Proxy-List.txt
```

The image is `ghcr.io/rsivanov-git/gist-decrypt:latest`. For reproducible updates,
replace `latest` with a published version such as `1.0.0` or an image digest.
The example binds **only to host localhost**, not all host interfaces.
The container runs as a non-root user with a read-only filesystem and dropped
Linux capabilities. No volumes or writable files are needed.

### Tailscale access

With Tailscale already installed and connected on the Docker host:

```sh
tailscale serve --bg http://127.0.0.1:8080
tailscale serve status
```

Append `/Proxy-List.txt` to the HTTPS address printed by Tailscale and use it
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
| `GET /Proxy-List.txt` | Fresh upstream fetch, authenticated decryption, original bytes with `text/plain; charset=utf-8` |
| `GET /healthz` | `200 ok`; process liveness only, without contacting GitHub |
| Other paths | `404` |
| Methods other than GET | `405` |
| Upstream error, timeout, invalid JSON, wrong key or altered data | `502`; no plaintext is returned |

Port is fixed at `8080`. Upstream timeout is 15 seconds; maximum encrypted
response size is 1 MiB. Redirects are rejected. The configured URL is restricted
to HTTPS raw files on `gist.githubusercontent.com`, without query strings,
credentials or revision IDs. The Gist URL cannot be supplied by an HTTP client.
Client disconnects abort the fetch. Keys, Gist URLs and response contents are not
logged. Conditional request headers are not forwarded; the service never returns
an application-generated `304`.

## Encryption compatibility

The file must be a UTF-8 JSON envelope:

```json
{
  "version": 1,
  "algorithm": "AES-256-GCM",
  "nonce": "BASE64_12_BYTES",
  "tag": "BASE64_16_BYTES",
  "data": "BASE64_CIPHERTEXT"
}
```

- Key: exactly 32 random bytes encoded in canonical standard Base64.
- Nonce: 12 bytes; authentication tag: 16 bytes.
- Additional authenticated data (AAD): UTF-8 `surge-personal/Proxy-List.txt/v1`.
- The complete authentication tag is verified before any plaintext is returned.

This matches the Proxy-List Gist publisher format. A different AAD, key, or
format fails authentication. The service does not generate or rotate keys.

## Local development and tests

With Node.js 24 or newer:

```sh
npm test
node --env-file=.env src/server.mjs
```

Tests use synthetic encrypted fixtures and mock upstream responses; they do not
require private Gists or real secrets. They cover byte preservation, tampering,
wrong keys/AAD, configuration validation, fresh fetches, upstream failures,
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
