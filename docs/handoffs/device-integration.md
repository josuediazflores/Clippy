# Device integration with the P04/P08 cloud

For the P05 (device) and P07 (pairing) owners. It describes the prototype hardware, observed read-only, and exactly how it should talk to the AWS stack on `p04-backend` / `p08-processing`. The device code is P05's; nothing here was installed on the device.

## Prototype hardware (read-only inspection, 2026-11-07, host `clippy` on the tailnet)

| Part | Observed | Consequence |
| --- | --- | --- |
| Board | Raspberry Pi Zero W Rev 1.1, ARMv6 (`armv6l`), 1 core, 512 MB, Raspberry Pi OS Trixie (32-bit), kernel 6.18 | Only armhf/ARMv6 builds run. Native-extension Python packages may need long source builds. Keep the device agent single-process and light. |
| Camera | Sony IMX219 (Camera Module v2), 3280x2464 max; full-field binned 1640x1232 at 81 fps; `rpicam-still` present | See capture profile below. |
| IMU | Bosch BNO085 on I2C-1 at `0x4B` (400 kHz), Adafruit CircuitPython driver in `~/sensors` venv; rotation vector and accelerometer reports work | Stays on the device (see IMU). |
| GPS | u-blox NEO-6M on `/dev/serial0`, 9600 baud NMEA; RMC/GGA/GSA/GSV/VTG/GLL parse cleanly; no fix and no satellites in view during inspection (indoors) | Maps to `Capture.location` (see GPS). Cold start outdoors can take minutes. |
| Bluetooth | BCM43438 controller present (Bluetooth 4.1 + LE); powered off, rfkill soft-blocked | 4.1 has no LE Secure Connections, which matters for P07 (see Pairing). |
| Wi-Fi | 2.4 GHz only (BCM43438) | Nightly upload over 2.4 GHz; keep photos small. |
| Clock | No real-time clock; `systemd-timesyncd` when online | Time is wrong after an offline boot until NTP or a GPS fix. |
| Display | None attached (no framebuffer, SPI disabled) | `Display.show` remains an adapter. |
| Power | No battery gauge exposed (`/sys/class/power_supply` empty); not throttled, 42 °C idle | `batteryPercent`/`charging` stay `null`, which the contract allows. |

Security note for the device owner: SSH accepts password login for user `clippy` with a default-style password on a tailnet-reachable host. Prefer key-only login (`PasswordAuthentication no`).

## Cloud protocol the device must speak

1. **Identity.** A per-device X.509 certificate attached to an IoT thing whose name equals the `deviceId`, with the `clippy-<env>-device` policy (P07 provisions this). Connect to the account's ATS endpoint on 8883 with client ID equal to the thing name, or the policy refuses the connection. The private key never leaves the device.
2. **Client library.** AWS IoT Device SDK v2 for Python depends on the native `awscrt` extension; on ARMv6 expect a long source build (not verified here). `paho-mqtt` is pure Python and sufficient: TLS 1.2, client certificate, QoS 1.
3. **Requests.** Publish to `clippy/v1/devices/<thing>/requests`. Subscribe to `clippy/v1/devices/<thing>/responses/+` and `.../commands`. The envelope (proposed D24, not yet frozen in `contracts/`) is `{schemaVersion: 1, requestId, type, snapshotId, body}`; the response is `{schemaVersion: 1, requestId, type, status, body}` on `.../responses/<requestId>`. Request types: `sync.begin`, `upload.grants`, `sync.complete`, `state.report`. Bodies are the frozen v1 types (`BeginSync`, `GrantRequest`, `CompleteSync`, `DeviceState`). Reuse the same `requestId` when retrying: responses are idempotent receipts.
4. **Uploads.** PUT each object to the returned `putURL` with exactly the `requiredHeaders` (`If-None-Match: *`, `Content-Type`, `X-Clippy-SHA256`) and nothing else that S3 signs. No bearer token. A 412 means the object already exists; still call `sync.complete`, which verifies everything server-side. Grants last 15 minutes; renew with a new `requestId`.
5. **Acknowledgement.** A `sync.complete` receipt means durable acceptance. Keep local files until the receipt is persisted on the device (the P03 simulator's checkpoint semantics).

## Capture profile (proposal, to be measured)

- Capture the full-field binned mode scaled to **1280x960 JPEG, quality about 85**: `rpicam-still --width 1280 --height 960 --quality 85 --nopreview --immediate`. Expected a few hundred KB per photo (unmeasured), well under the 5 MB contract and 3.75 MB model bounds, and quick to encode on one ARMv6 core.
- Why not full resolution: 3280x2464 JPEGs are several MB, slow to encode and upload over 2.4 GHz, and cost more model input for little journal value.
- Model cost scales with pixels (about width × height / 750 input tokens per image for Claude vision): roughly 1,600 tokens at 1280x960, 2,700 at 1640x1232, 1,050 at 1024x768. At 96 photos a day that is about 160k, 260k or 100k observation input tokens per user-day. The P08 evaluation should compare at least two of these sizes before the profile is frozen (`preprocessingVersion` records the choice).
- Measuring real sizes needs one test capture on the device. Pipe it to a byte counter and discard it (`rpicam-still ... -o - | wc -c`), with the device owner's agreement, because it photographs whatever is in front of the camera.

## GPS to `Capture.location`

- Only from a GGA or RMC fix with quality > 0. `latitude`/`longitude` from the fix; `sampledAt` is the fix time (UTC); `source: "gnss"`.
- `accuracyMeters`: the NEO-6M reports HDOP, not accuracy. Use an estimate such as `HDOP × 5 m` and document it; the backend ignores fixes worse than 250 m and fixes sampled more than 15 minutes from the capture.
- No fix gives `location: null`. Never repeat an old fix as if current.
- In the cloud, coordinates are stored with the capture but never put in object keys or logs. With place labels enabled (`places.provider: "amazon-location"`), the pipeline rounds them to about 110 m before reverse geocoding, and the model only sees an area label such as "Harbor District, Test City".

## Clock quality

- `synchronized`: NTP synced (`timedatectl show -p NTPSynchronized`) or a current GPS fix with valid date and time.
- `estimated`: time carried since the last sync without reboot.
- `untrusted`: after a reboot with no sync. The backend accepts those captures but **quarantines them from days** (no recap). The GPS module is the offline fix for this, so prefer syncing the system clock from RMC when NTP is unavailable.

## IMU (BNO085)

- Raw motion and orientation stay on the device. The cloud contract has no motion fields, and none should be added without a privacy decision.
- Useful locally: the pause gesture (the BNO08x tap and shake detector reports, or a deliberate flip), skipping frames when the stability classifier reports motion or the camera faces down or is covered, and a physical confirmation for pairing (see below).
- Reported to the cloud only as `DeviceState.captureState` (`paused`, `capturing`, and so on) via `state.report`.

## Pairing (input for P07)

- Bluetooth 4.1 means LE legacy pairing only (LE Secure Connections arrived in 4.2). Do not rely on BLE link-layer pairing for confidentiality. Run an established, reviewed authenticated key exchange at the application layer, keyed from material in the device's QR (for example the Noise framework with a static key shown in the QR), then send Wi-Fi credentials inside that channel. This follows architecture section 6: no home-made cryptography.
- Physical possession: the IMU allows "tap or shake the device to confirm" as the agreed interaction before the device sends `claim.prove`. This is a proposal for Josue and the device owner to decide.
- Bluetooth is currently rfkill soft-blocked; enabling it is a device configuration change for the device owner.

## What the cloud already handles for this hardware

- JPEG and PNG validated by header parsing; oversized or degenerate frames are recorded as gaps without model spend.
- Untrusted clocks quarantined; backlogs grouped by capture time.
- Capture location accepted and, optionally, turned into coarse place labels (off by default; `geo-places:ReverseGeocode` granted only when enabled).
- `batteryPercent`/`charging` null handled; stale state reports ignored (newer `observedAt` wins).
