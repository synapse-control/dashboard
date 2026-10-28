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

Open `http://<this machine>:8080`. The first visit asks you to make the admin account. Then plug a
board in and open **Add a Board**.

## What the dashboard does

| Page | What it shows and does | Where it comes from |
|---|---|---|
| Overview | device counts, the latest readings of a channel, recent activity, the health of the hub, the stream and the node door | the hub's node list every second, the dashboard's own recordings |
| Connected Nodes | every board on the hub with its status LED (beacon) and protocol traffic live; survey a board to say what is wired to it; its pins; disconnect | hub tools `list_nodes`, `wire_log`, `identify_circuit`, `describe_node`, `disconnect_node` |
| Device Fleet | every board that has ever reached this hub, with your name and description, online or last seen, searchable; forget a board | the dashboard's registry, filled from the hub as boards arrive |
| A device | read any pin (volts with its uncertainty, or logic), drive it high or low, run PWM, set its mode, release your pins, blink its LED to find it, record a pin as a channel | hub tools `read`, `write`, `set_mode`, `release`, `run_sequence` |
| Add a Board | boards on this server's USB as they are plugged in, with what each runs: add it (as it is, for Firmata or MicroPython), ask its chip, or install or update its firmware (backed up first); the saved copies, each one put back on a board with one press; a board on your own computer's USB, set up from the page in Chrome or Edge (firmware, then Wi-Fi for an ESP32, or carried through the tab); the bridge command for another Linux machine; the node door and key (admins only); connect by address | hub tools `list_ports`, `scan_devices`, `connect_node`, `flash_node`, `list_backups`, `restore_node`, the hub's `/firmware` files, Web Serial in the browser |
| Live Telemetry | channels: a pin read at the interval you set, scaled into a unit (sensor presets for a TMP36, an LM35, percent of supply), live value, uncertainty and sparkline | the dashboard's sampler calling `read` |
| Historical Data | a channel over 15 minutes to 30 days, with min to max bands, rule thresholds and a CSV download | the recordings, one file a day |
| Alerts & Notifications | boards dropping off, failsafes, brownouts, rules that could not act, the hub going quiet; the bell counts what you have not seen | the dashboard's activity log |
| Automations | rules: when a channel crosses a threshold, drive a pin high, low or to a PWM duty, with an otherwise action; templates; simulate against a fresh reading; executions and logs | the dashboard's rule engine calling `write` |
| Account | theme, sidebar, data retention, roles, people, webhooks (signed with HMAC-SHA256) | the dashboard's settings |

A rule runs on every reading of its channel. When its condition turns true it drives its pin, when
it turns false it applies the otherwise action, and it re-asserts every 30 seconds, so a board that
reset or redialled returns to the right state. Rules act as `user:rules` on the hub; a person's lease
on the same pin blocks a rule until that lease lapses.

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
| `/firmware/<file>` | the Add a Board page installing firmware from your browser | a dashboard sign-in |
| `/mcp/manifest`, `/mcp/call/<tool>` | agents such as Claude Code | the hub's read or write token |
| `/health` | your monitoring | nothing; it says only whether the dashboard and hub are up |

All state lives in the `synapse-data` volume: the hub's tokens and node key in `/data/tokens`,
the dashboard's accounts, session key, registry, channels, rules, webhooks and activity log in
`/data/dashboard`, and its recordings in `/data/dashboard/readings`, one file a day, deleted after
the retention you set (30 days by default). Removing or replacing the containers keeps it.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `SYNAPSE_PORT` | `8080` | the port on this machine |
| `SYNAPSE_PUBLIC_URL` | empty | the address people and boards use, such as `https://synapse.example.com`; with `https` the session cookie is marked secure; needed for OIDC |
| `SYNAPSE_NODES_URL` | `<SYNAPSE_PUBLIC_URL>/nodes` as `ws://` or `wss://` | the node door boards are told to dial, when it lives at another address (a public door for boards away from home) |
| `SYNAPSE_HUB_TAG`, `SYNAPSE_DASHBOARD_TAG` | `0.4`, `0.4` | which release line to run |
| `SYNAPSE_NODES` | `auto` | boards on the hub's own USB to connect at start; empty connects none, and Add a Board adds them |
| `SYNAPSE_SERIAL_GID` | `dialout` | the group that owns the USB serial ports on this machine (`stat -c %g /dev/ttyUSB0`); `dialout` fits Debian, Ubuntu and Raspberry Pi OS, Arch and Fedora use the number of `uucp` or `dialout` |
| `DASHBOARD_LOCAL_LOGIN` | `true` | `false` turns off name-and-password sign-in, leaving OIDC only |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | empty | sign in through your identity provider (Authelia, Authentik, Keycloak, Pocket ID, Google); register `<SYNAPSE_PUBLIC_URL>/auth/callback` as the redirect |
| `OIDC_REDIRECT_URL` | `<SYNAPSE_PUBLIC_URL>/auth/callback` | the callback to use when your identity provider already has another one registered |
| `OIDC_ADMIN_GROUP` | empty | when set, only members of this group are admins and everyone else signed in by OIDC is a viewer; when empty, every OIDC user is an admin; the `groups` scope is asked for only when this is set (`OIDC_GROUPS_CLAIM` names the claim, default `groups`) |

## People

There are three roles. A viewer sees every board, reading and alert live, reads pins, runs surveys
and simulates rules, none of which drive an output. An operator also drives pins, connects and
disconnects boards, records channels, writes rules and names devices. An admin also manages people,
webhooks and data retention, sees the node key and forgets devices. With OIDC, members of
`OIDC_ADMIN_GROUP` are admins and everyone else is a viewer. The dashboard holds the hub's tokens
itself: a browser never sees them, and the hub records each person's name on the leases they take.

## Boards

Open **Add a Board** and plug the board in:

- **Into the machine that runs the hub.** It shows up on the page within two seconds with what it
  runs. Press **Add to the hub** for Synapse firmware. A board running StandardFirmata or
  MicroPython gets **Add as it is**: nothing on the board changes, the hub speaks its firmware for
  it, and the board's card says where its failsafe and timing live (Firmata's on the hub,
  MicroPython's on the board). **Install Synapse firmware** replaces whatever runs; **Ask the chip**
  resets the board into its bootloader and reads the chip without writing. The hub saves a copy of
  the old flash in `/data/backups` before it installs anything, and **Saved copies of boards** puts
  a copy back byte for byte after checking that the board has the same chip. The hub sees USB
  because `compose.yaml` binds the host's `/dev` read-only at `/host/dev` and allows only the USB
  serial device classes (ttyUSB and ttyACM). A board that leaves stays gone until it is plugged in
  again, and the dashboard brings USB boards back when the hub restarts for an update.
- **Into your own computer**, in Chrome or Edge. Press **Choose the board**. The page reads what
  it runs, installs Synapse firmware from the hub if it needs it, and then for an ESP32 asks for
  the Wi-Fi. The ESP32 stores the Wi-Fi, the hub's address and the node key, and the page shows
  it joining Wi-Fi, dialling and arriving on the hub. From then on it dials in by itself on any
  power supply. A board with no radio, such as an Uno, is carried to the hub by the open tab.
- **Into another Linux machine**, for good. The page gives an admin one `docker run` command for
  that machine. It watches the machine's USB and brings every board on it that runs Synapse
  firmware, Firmata or MicroPython to this hub.

Each board dials `<public url>/nodes` and presents the node key as its first line. Its LED shows
its state.

To reach boards outside your network, expose only `/nodes` on a public address (a reverse proxy,
Tailscale Funnel or Cloudflare Tunnel) and keep the rest private. The hub drops a board that sends
the wrong key, stays silent for 6 seconds, or sends a line over 256 KiB.

## Updates

Each release is a version tag that publishes signed images for amd64 and arm64. The compose file
follows a release line (`0.4` takes every `0.4.x` fix), so `docker compose pull && docker compose up -d`
picks up security patches with no other change. To pin an exact version, set the tag in `.env`.
Check that an image came from this repository with:

```sh
cosign verify ghcr.io/synapse-control/dashboard:0.4 \
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
with no build step, embedded in the binary; `web/static/vendor/esptool.js` is esptool-js 0.7.0
bundled into one file for installing ESP32 firmware from the browser (licenses in
`web/static/vendor/LICENSES.txt`). The typeface is Fira Code under the SIL Open Font
License (`web/static/fonts/OFL.txt`).
