# Hardware and platform adapter boundary

P01 local defaults are explicit implementation choices, not evidence about a Pi prototype. Person 1 owns the later adapters; Josue supplies physical hardware decisions before P05/P07 hardware gates.

- `Camera.capture() -> bytes, contentType`: synthetic 32x32 PNG now. Pi/OS/camera driver, orientation, normalization, exposure, and capacity remain unresolved.
- `Clock.sample() -> instant, timeZone, offset, quality`: fixed UTC sample now. Real clock synchronization and boot without network remain P05 inputs. Untrusted samples are quarantined from journal assignment.
- `Location.sample() -> Location?`: returns null now. GNSS versus phone samples, accuracy and age limits await hardware selection.
- `PauseControl.state()/resume()`: explicit resume; no automatic timeout; a restart stays paused until explicitly resumed. IMU gestures, false-positive targets, and physical interaction await P05. Capture interval default is ten minutes; no scheduler is activated here.
- `Display.show(DeviceState)`: diagnostic output only. Screen driver and privacy indicator await P05.
- `Power.sample() -> battery?, charging?`: unknown now. Board telemetry and low-power thresholds await P05.
- `ObjectProtection.write/read/delete`: synthetic filesystem bytes only. Real data must wait for an approved encryption/key-unlock strategy. No claim of theft protection or secure deletion on removable media.
- `SetupTransport.establish(challenge)/confirmPossession()`: unavailable adapter now, no pretend BLE pairing. Pi BLE capability, authenticated out-of-band mechanism, and possession confirmation await P07.
- `DeviceTransport.begin/grants/put/complete`: loopback HTTP now; later IoT control plus S3 data transfer. Identity is transport-derived, never accepted from a payload owner field.
- iPhone `JournalRepository`, `AuthSession`, `DeviceService`, `SyncService`, `CalendarSource`: local fixture/HTTP adapters now; Cognito, BLE, and read-only EventKit adapters are P06/P07/P09 work. A calendar source reports unavailable separately from a complete empty snapshot.
- Backend `JournalStore`, `ObjectStore`, `ObservationProvider`, `RecapProvider`: local persisted JSON/files and deterministic fixtures now; AWS and paid provider adapters remain P04/P08.

Prototype retention defaults to seven days as metadata only. There is no expiry worker. Real data retention, backup expiry, journal timezone changes, and automatic nightly activation need later decisions. Nightly is a synthetic trigger string in the finite scenario, not a scheduled job.
