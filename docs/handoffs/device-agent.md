# Device agent and printed-QR pairing

Prototype runtime for the Pi Zero W (no screen, no pause gesture yet). Decision D50.

## What runs

- `device/clippy_device/agent.py`, installed on the Pi at `~/clippy-agent`, run by the `clippy-agent` systemd service as user `clippy`.
- Unclaimed: connects to AWS IoT with its own certificate and polls `device.status` every 20 seconds. The cloud answers 403, so it captures nothing.
- Claimed: captures a 1280x960 JPEG every `captureIntervalSeconds` (default 600) into `~/.clippy/data` (SQLite queue plus files), reports state every 5 minutes, and uploads a snapshot when the app's Sync now is pending or once a night after `nightlyUtc` (default 02:00 UTC). Files are deleted only after the server receipt.
- GPS location is attached when the NEO-6M has a fix younger than 2 minutes; otherwise `location` is null.

## Operate

- Logs: `journalctl -u clippy-agent -f`
- Stop: `sudo systemctl stop clippy-agent`. Disable at boot: `sudo systemctl disable --now clippy-agent`.
- Faster captures for a demo: set `"captureIntervalSeconds": 60` in `~/.clippy/config.json`, then `sudo systemctl restart clippy-agent`.

## Provision a new device

```sh
AWS_PROFILE=... AWS_REGION=us-east-1 npx tsx tools/provision-device.ts --device-id dev_clippy_002
```

Copy `certificate.pem`, `private.key` and `config.json` from `.local/devices/<id>/` into the Pi's `~/.clippy/` (mode 600) and restart the service. Print `qr.png`. The QR is the possession proof until it is claimed: keep it out of sight (inside the case or on the box). It is single-use.

## Remove a device

1. `aws iot detach-thing-principal` and `aws iot detach-policy` for its certificate, `aws iot update-certificate --new-status INACTIVE`, `aws iot delete-certificate`, `aws iot delete-thing`.
2. Delete the `DEVICE#<id>` items (`IDENTITY`, `STATE`) in the Devices table, and the owner's `DEVICE#<id>` reference in the Accounts table if it was claimed.

## Not implemented

Wi-Fi setup (configure the Pi's Wi-Fi directly), pause gesture and pause notification, battery telemetry, local image encryption, device reset/transfer, configuration commands from the app.
