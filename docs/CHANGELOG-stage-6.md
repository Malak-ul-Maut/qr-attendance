# Stage 6: Face enrolment pipeline

Files changed: `frontend/js/enroll.js`, `pose.js`, `pose-guide.js`, `face-verify.js`, `api.js`, `frontend/student.html`, `frontend/css/student.css`, and a comment in `backend/routes/student.routes.js`. New: `frontend/js/face/loop-stats.js`, `frontend/js/face/box-smoother.js`, `tests/student-ui/enrol-stage6.test.mjs`.

**Read this first.** I could not test on an older phone, and every face in my tests was scripted (no real person on a real camera). What I did measure and test is listed at the bottom. To get the real numbers, open the page with `?debug=1` on the phone: it shows a strip under the camera (frame rate, detection time, light-check time, which gate fired how often) and logs every gate change to the console.

## Measured first (real face engine, headless Chromium, fake camera, CPU slowed to imitate weaker phones)

| per camera frame | normal CPU | 4× slower | 6× slower |
|---|---|---|---|
| find the face (round trip) | 27 ms | 100 ms | 124 ms |
| light / blur / glare checks | 0.6 ms | 64 ms | 104 ms |
| 960 px snapshot of the frame | 5 ms | 49 ms | 80 ms |
| whole turn of the old loop | 52 ms | 254 ms | 368 ms |

So on a slow CPU the per-frame pixel reading (checks plus snapshot) cost more than the face finding itself, which matches the plan's second and third suspects. The old loop also paused up to 110 ms after every turn. (Slowed-down desktop numbers are only a guide, not a phone.)

## Slider lag

- **Display pose.** The gauge dot now shows a lightly smoothed pose with a short look-ahead (90 ms) for the detection delay. The photo is still decided by the original, steadily smoothed pose; a test proves that one is unchanged.
- **Light checks every third frame.** Face size is still checked every frame. Frames are kept as photo candidates only when their sharpness was just measured, and until two are kept, every frame is checked, so the "best of two" still has two to choose from. From the table that is about a third of the pixel work per turn (about 113 ms down to about 38 ms per turn at 4×; arithmetic from the measurements, not re-measured).
- **No fixed pause.** The loop is driven by new camera frames (`requestVideoFrameCallback`) and runs as fast as the phone can find faces. Because frames now arrive faster, "hold still" is also time-based (at least 450 ms and 3 good frames), so it does not get shorter.
- **Result, simulated** (head turning with a modelled 100 ms detection delay): the gauge's average error is 12–41% of what it was (best for normal-speed turns). A still head's dot shakes no more than the input noise.

## Dropped bounding box

- Every turn now records which gate fired (no face, more than one face, not shaped like a face, too far/close, light, pose) and the `?debug=1` strip and console show it.
- **Grace window.** A face lost for under 400 ms (or one not shaped like a face) keeps the hold-still count and kept frames, and the last box stays on screen in amber. Longer than that, or more than one face, starts over. Tested: a 250 ms dropout is ridden out; a 900 ms one is reported.
- **Smoothed box.** The drawn box glides instead of jumping.
- **Wide turns and the deep chin-down only** now use a detector limit of 0.5 (others stay 0.7) and a relaxed face-shape check. Ceiling-fan-style shapes still fail. Target angles are unchanged (a test pins every window).
- **What I could not confirm:** on a synthetic face model, the original shape check already accepted the wide-turn target (about 39°), so it may not be what drops the box. The 0.7 detector limit and the old reset-on-one-lost-frame behaviour are the likelier causes, and both are addressed. The relaxed shape check only adds margin at about 65–75° turns. The gate log will show which one it really is.

## Text

- Every status line is English only, with no direction words on screen ("Hold still", "Move closer", "More light", "Photo 3 of 11 saved", "Match the pose", "Stop there", "Slowly… almost there").
- Sentences that name a direction ("A bit more to the left", "Chin down a little more") are read to screen readers only, at most one every 1.5 s, and each pose is also announced in words when it starts. The arrow and gauge show the way visually.
- The bilingual pose name above the camera is the only Hindi left (a test enforces it).

## Photos and upload

- **One photo per pose** is uploaded (11, or 12 with glasses), the sharpest frame. The runner-up frame still goes into the embedding average but is never encoded or uploaded: the upload is about half the size (about 2.9 MB in the test).
- **Upload progress ring** (XMLHttpRequest, since fetch cannot report upload progress): it fills with the bytes sent, then turns while the server checks and files the photos. Cancel is off during upload, so a "cancelled" upload cannot still be saved.
- **Retry:** a dropped connection, a stall (no byte for 30 s) or a server error retries by itself twice ("Trying again (2 of 3)…"), then offers **Try again**, which re-sends the same photos without retaking them. If an answer was lost but the server did save them, the next try is refused as "already saved"; the page now asks the server and shows success instead of an error.
- The "What the camera saw" line is only shown with `?debug=1`.
- Backend: no behaviour change (6 to 24 photos are accepted); only a comment, since older copies of the page still send two per pose.

## Checked

- 13 unit tests (`node --test tests/student-ui/enrol-stage6.test.mjs`): face-shape check (never rejects what the original accepted; non-faces still fail), pinned target angles, gauge lag, jitter, steady pose unchanged, English-only rule and the direction flag on every possible sentence, loop statistics, box smoother.
- Browser, real capture loop with a scripted face: a full 11-pose run, the status and screen-reader text, one photo per pose uploaded, detector limits per shot, the debug strip, the progress ring on a throttled connection, retry, three failures then Try again, the lost-answer case, 250 ms and 900 ms dropouts, and the debug-only line. The Stage 5 browser tests still pass.

## Not done

- Anything on a real older phone, or with real faces. Please run one enrolment with `?debug=1` and send me the strip and the console lines.
- `npm test` and the project's own contrast audit were not run (`tests/` and `tools/` were not in the zip, and `package.json` has no test script); the new tests run with `node --test`.
