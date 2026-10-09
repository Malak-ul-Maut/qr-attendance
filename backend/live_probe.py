"""
Phase-0 check for a live camera: run this FIRST, on the machine that will run the recognizer.

    python live_probe.py "rtsp://USER:PASS@NVR_IP:554/cam/realmonitor?channel=1&subtype=0"

Prints how long the camera takes to give its first frame, the real frame rate and resolution,
whether this machine can decode the stream faster than real time, and saves one frame
(probe_frame.jpg) so you can check that faces are big and sharp enough. Use the MAIN stream
(subtype=0); the substream (subtype=1) is usually too small for faces at the back of a classroom.
"""
import os
import sys
import time

os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp|fflags;nobuffer|flags;low_delay")
import cv2


def main(url, seconds=10.0):
    shown = url.split("@")[-1] if "@" in url else url
    print(f"Connecting to {shown} ...")
    started = time.perf_counter()
    try:
        cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG, [cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 8000, cv2.CAP_PROP_READ_TIMEOUT_MSEC, 5000])
    except (TypeError, cv2.error):
        cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG)
    if not cap.isOpened():
        sys.exit("Could not open the stream: check the address, login, channel number and network.")
    opened = time.perf_counter() - started

    ok, frame = cap.read()
    if not ok:
        sys.exit("Connected, but no frame arrived.")
    first = time.perf_counter() - started
    height, width = frame.shape[:2]
    cv2.imwrite("probe_frame.jpg", frame)
    print(f"  connected in {opened:.2f}s, first frame after {first:.2f}s   <- the cost a 'warm' connection avoids")
    print(f"  resolution {width}x{height}   (camera reports {cap.get(cv2.CAP_PROP_FPS):.1f} fps - not always reliable)")

    frames, begin = 0, time.perf_counter()
    while time.perf_counter() - begin < seconds:
        if not cap.grab():
            print("  stream stopped delivering frames")
            break
        frames += 1
    elapsed = time.perf_counter() - begin
    cap.release()
    print(f"  measured {frames / elapsed:.1f} frames/s over {elapsed:.1f}s of decoding every frame")
    print("Saved probe_frame.jpg - open it and check that the faces in the back rows are big and sharp.")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1], float(sys.argv[2]) if len(sys.argv) > 2 else 10.0)
