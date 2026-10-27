# Synapse Control dashboard

The part of Synapse Control that runs: the hub that boards dial into, and the dashboard where you
watch and drive them. It installs like any self-hosted app, from published images and one compose
file, on a laptop, an old PC, a Raspberry Pi, a homelab or a rented server.

## Install

You need Docker with Compose. In an empty folder:

```sh
curl -fsSLO https://raw.githubusercontent.com/synapse-control/dashboard/main/compose.yaml
docker compose up -d
```

Open `http://<this machine>:8080`. The first visit asks you to make the admin account. The
"Add a board" page then shows the node key and the exact commands for your boards.

To change a setting, copy `.env.example` to `.env` beside `compose.yaml`, edit it and run
`docker compose up -d` again.

## What runs

| Container | Image | Job |
|---|---|---|
| `hub` | `ghcr.io/synapse-control/hub` | speaks to the boards, keeps leases and failsafes, serves the tools agents call |
| `dashboard` | `ghcr.io/synapse-control/dashboard` | the web page, sign-in, and the one public port |

Everything is reached through the dashboard's port (8080):

| Path | Who uses it | Guarded by |
|---|---|---|
| `/` and the pages | people | a dashboard sign-in |
| `/nodes` | boards dialling in (WebSocket) | the node key |
| `/mcp/manifest`, `/mcp/call/<tool>` | agents such as Claude Code | the hub's read or write token |
| `/health` | your monitoring | nothing; it says only whether the dashboard and hub are up |

All state lives in the `synapse-data` volume: the hub's tokens and node key in `/data/tokens`,
the dashboard's accounts and session key in `/data/dashboard`. Removing or replacing the
containers keeps it.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `SYNAPSE_PORT` | `8080` | the port on this machine |
| `SYNAPSE_PUBLIC_URL` | empty | the address people and boards use, such as `https://synapse.example.com`; with `https` the session cookie is marked secure; needed for OIDC |
| `SYNAPSE_HUB_TAG`, `SYNAPSE_DASHBOARD_TAG` | `0.2`, `0.1` | which release line to run |
| `SYNAPSE_NODES` | `auto` | boards on the hub's own USB to connect at start |
| `DASHBOARD_LOCAL_LOGIN` | `true` | `false` turns off name-and-password sign-in, leaving OIDC only |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | empty | sign in through your identity provider (Authelia, Authentik, Keycloak, Pocket ID, Google); register `<SYNAPSE_PUBLIC_URL>/auth/callback` as the redirect |
| `OIDC_ADMIN_GROUP` | empty | when set, only members of this group are admins and everyone else signed in by OIDC is a viewer; when empty, every OIDC user is an admin |

## People

An admin drives pins, connects and disconnects boards, sees the node key and adds people. A viewer
sees every board live, reads pins and runs surveys, which drive no outputs. The dashboard holds the
hub's tokens itself: a browser never sees them, and the hub records each person's name on the leases
they take.

## Boards

Boards come to the hub, not the other way round: each one dials `<public url>/nodes` and presents
the node key. An ESP32 stores Wi-Fi and the hub address in its own flash and dials in from any power
supply; a board on a computer's USB gets a small bridge beside it. The "Add a board" page prints
both commands with your address and key filled in.

To reach boards outside your network, expose only `/nodes` on a public address (a reverse proxy,
Tailscale Funnel or Cloudflare Tunnel) and keep the rest private. The hub drops a board that sends
the wrong key, stays silent for 6 seconds, or sends a line over 256 KiB.

Boards plugged into the machine that runs the hub can also be passed into the `hub` container: see
the commented `devices` lines in `compose.yaml`.

## Updates

Each release is a version tag that publishes signed images for amd64 and arm64. The compose file
follows a release line (`0.1` takes every `0.1.x` fix), so `docker compose pull && docker compose up -d`
picks up security patches with no other change. To pin an exact version, set the tag in `.env`.
Check that an image came from this repository with:

```sh
cosign verify ghcr.io/synapse-control/dashboard:0.1 \
  --certificate-identity-regexp '^https://github.com/synapse-control/dashboard/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Develop

```sh
go test -race ./...
SYNAPSE_HUB_URL=http://127.0.0.1:4010 SYNAPSE_TOKEN_DIR=../harness/.tokens DASHBOARD_DATA=.data DASHBOARD_ADDR=127.0.0.1:8080 go run .
```

Go standard library for the server and pages, `golang.org/x/crypto/bcrypt` for passwords,
`coreos/go-oidc` and `golang.org/x/oauth2` for single sign-on. The page script is plain JavaScript
with no build step, embedded in the binary.
