# Live CCTV (RTSP) - setup notes

The recorded clip still works. Nothing changes until you set `CCTV_SOURCE`.

## Turning it on
| `CCTV_SOURCE` | Behaviour |
|---|---|
| `clip` (default) | always the test clip (old behaviour) |
| `auto` | the room's `camera_url` if it has an `rtsp://` one, otherwise the clip |
| `live` | always the room's `camera_url`; a room without one returns `no_camera_configured` |

Other settings (all optional): `CCTV_STREAM_IDLE_SEC` (default 600: close a camera nobody used for this long),
`CCTV_MAX_STREAMS` (default 12: cameras kept open at once).

## Camera address (`rooms.camera_url`)
Dahua and CP Plus NVRs normally use:
`rtsp://USER:PASSWORD@NVR_IP:554/cam/realmonitor?channel=N&subtype=0`
`channel` is the camera's number on the NVR; `subtype=0` is the main stream. Test it in VLC first.
Use a **view-only** NVR account, and percent-encode special characters in the password (`@` -> `%40`).
The URL is masked (`rtsp://***@...`) in every log, error and API reply.
The recognition service must be on a network that can reach the NVR (the college LAN / VPN). Do not expose the NVR to the internet.

## How a live scan works
1. Starting a CCTV session tells the service to open that room's camera (`/stream/warm`). Finalizing the session closes it again (`/stream/release`), unless another CCTV session in that room is still open. Idle connections also close by themselves after `CCTV_STREAM_IDLE_SEC`.
2. A background thread per camera keeps only the newest frame (so frames never pile up).
3. The scan takes a fresh frame about every `sample_interval` (0.72 s), for `duration` seconds (at most `duration / sample_interval + 1` frames), and skips frames it has no time for.
4. A camera that is offline gives `camera_unreachable` after `first_frame_timeout` (10 s). It can never block other rooms.

## Several classes at once
The models still run one frame at a time, but the lock is taken per **frame**, not per scan. While one class waits for its camera's next frame, another class's frame is recognised, so classes starting at the same time overlap instead of queueing. Time spent waiting for the models does not use up a scan's duration, and every scan gets the same number of frames. `GET /queue` (service) and `GET /api/attendance/cctv/queue` (Node) report how many scans are running; the faculty page uses it to show "N other classes are being scanned too".

The page also has a **Scan again** button after a result. Students already marked stay marked; a new scan adds the ones the camera sees now.

## Check a camera before using it
`python live_probe.py "<rtsp url>"` - time to first frame, real fps, resolution, decode speed, and a saved frame.
