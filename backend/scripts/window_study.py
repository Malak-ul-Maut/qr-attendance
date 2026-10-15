#!/usr/bin/env python3
"""
window_study.py - how long must students look at the camera (window), and how many recognition attempts is a face
worth (max_attempts)? Measure it on your own clips instead of guessing.

The scan is causal: what happens in the first k frames is exactly what a k-frame scan would have done. So ONE long
run per clip is enough to read off the result of every shorter window and every smaller attempt budget.

Step 1 - run each clip once, with a window longer than you expect to need (default 20 s, one frame per second):
    python scripts/window_study.py run --video f310.avi --truth f310_present.txt
    python scripts/window_study.py run --video f310_2.avi --truth f310_2_present.txt --students-json roster2.json
  --truth (recommended): a text file, one student per line (gallery folder, student id or name; # = comment) of
  everyone who really is in that clip and facing the camera. Without it the "recall" below is only relative to
  whoever the long run itself found, so it cannot see people who are never matched.
  Each run saves window_study/<clip>.json next to this project and prints its own report.

Step 2 - pool every clip into one report (more clips = more trustworthy):
    python scripts/window_study.py report window_study/*.json --target 0.95

What the report shows
  * who was matched, when (frame / second), after how many attempts, with what score;
  * recall by window length (how many frames), and what that costs in processing time on THIS machine;
  * a grid: recall and recognitions for every (window, attempt budget) pair, so you can pick the cheapest pair that
    still reaches your target recall;
  * the recognitions spent on faces that never matched - the price of keeping the budget high.
Timings are for the machine that ran the clips: run it on the laptop you will deploy on (Sparsh / Yash).
"""
import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))       # recognize.py is one folder up (imported only by `run`)


# ================================================================ analysis (needs no models)
def _norm(text):
    return " ".join(str(text).lower().split())


def load_truth(path, enrolled):
    """Set of student_ids named in the truth file. `enrolled` = [{"student_id", "name", "folder"}]."""
    ids, unknown = set(), []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        key = _norm(line)
        exact = [e for e in enrolled if key in (_norm(e["folder"]), _norm(e["student_id"]), _norm(e.get("name") or ""))]
        if not exact:   # a unique "starts with" is accepted too ("hariom" -> "Hariom Kumar")
            exact = [e for e in enrolled if _norm(e.get("name") or "").startswith(key) or _norm(e["folder"]).startswith(key)]
        if len(exact) == 1:
            ids.add(exact[0]["student_id"])
        else:
            unknown.append(line + ("  (matches several)" if exact else "  (not enrolled in this roster)"))
    return ids, unknown


def clip_record(video, result, enrolled, truth_ids, spacing, fps, machine=""):
    """Everything the report needs from one run_attendance() result, as plain JSON."""
    frames = result.get("frame_stats", [])
    position = {f["frame"]: i + 1 for i, f in enumerate(frames)}   # video frame number -> 1, 2, 3 ... (the window length)
    names = {e["student_id"]: e.get("name") or e["folder"] for e in enrolled}
    matches = [{"student_id": r["student_id"], "name": names.get(r["student_id"], str(r["student_id"])),
                "k": position.get(r["frame"], 0), "t": r.get("t"), "attempt": r.get("attempt"),
                "sightings": r.get("sightings"), "score": r.get("best_score")}
               for r in result.get("present_students", [])]
    return {"video": str(video), "fps": fps, "spacing": spacing, "machine": machine,
            "frames": frames, "matches": matches, "tracks": result.get("track_summary", []),
            "enrolled": enrolled, "truth": sorted(map(str, truth_ids)) if truth_ids is not None else None}


def _mean(values):
    values = list(values)
    return sum(values) / len(values) if values else 0.0


def analyse(clips, target=0.95):
    """Pool the clips: recall / cost for every window length k and attempt budget c."""
    max_k = max((len(c["frames"]) for c in clips), default=0)
    max_c = max((max((len(t["attempt_frames"]) for t in c["tracks"]), default=1) for c in clips), default=1)
    max_c = max(max_c, 1)
    have_truth = all(c["truth"] is not None for c in clips)

    wanted, found_cells = 0, {}
    for clip in clips:
        truth = set(clip["truth"]) if clip["truth"] is not None else None
        final = {str(m["student_id"]) for m in clip["matches"]}
        wanted += len(truth) if truth is not None else len(final)
    wanted = max(wanted, 1)

    det_ms = _mean(f["detect_ms"] for c in clips for f in c["frames"])
    rec_total = sum(f["recognize_ms"] for c in clips for f in c["frames"])
    rec_count = sum(f["recognized"] for c in clips for f in c["frames"])
    ms_per_recognition = rec_total / rec_count if rec_count else 0.0

    grid = {}   # (k, c) -> (matched, false_positives, recognitions)
    for k in range(1, max_k + 1):
        for c in range(1, max_c + 1):
            matched = false_pos = recognitions = 0
            for clip in clips:
                truth = set(clip["truth"]) if clip["truth"] is not None else None
                for m in clip["matches"]:
                    if 0 < m["k"] <= k and (m["attempt"] or 1) <= c:
                        if truth is None or str(m["student_id"]) in truth:
                            matched += 1
                        else:
                            false_pos += 1
                for track in clip["tracks"]:
                    recognitions += sum(1 for frame in track["attempt_frames"][:c] if frame <= k)
            grid[(k, c)] = (matched, false_pos, recognitions)

    n_clips = len(clips)
    # smallest window that reaches the target with the full attempt budget, then the smallest budget at that window
    best_k = next((k for k in range(1, max_k + 1) if grid[(k, max_c)][0] / wanted >= target), None)
    best_c = None
    if best_k is not None:
        full = grid[(best_k, max_c)][0]
        best_c = next(c for c in range(1, max_c + 1) if grid[(best_k, c)][0] >= full)
    return {"max_k": max_k, "max_c": max_c, "wanted": wanted, "have_truth": have_truth, "det_ms": det_ms,
            "ms_per_recognition": ms_per_recognition, "grid": grid, "best_k": best_k, "best_c": best_c,
            "n_clips": n_clips, "target": target}


def print_report(clips, target=0.95, margin=1):
    if not clips:
        print("No clips.")
        return
    a = analyse(clips, target)
    spacing = _mean(c["spacing"] for c in clips)
    machine = ", ".join(sorted({c["machine"] for c in clips if c["machine"]})) or "this machine"
    print(f"\n=== window study: {a['n_clips']} clip(s), {a['max_k']} frames at {spacing:g}s spacing, timings from {machine} ===")
    if not a["have_truth"]:
        print("!! No --truth file for at least one clip: recall is measured against whoever the long run itself found.\n"
              "   People who are never matched are invisible to it, so treat the window as a LOWER bound.")

    print("\nWho was matched, and when")
    print(f"  {'clip':<16}{'student':<26}{'frame':>6}{'t (s)':>7}{'attempt':>8}{'seen':>6}{'score':>7}")
    for clip in clips:
        truth = set(clip["truth"]) if clip["truth"] is not None else None
        for m in sorted(clip["matches"], key=lambda m: (m["k"], str(m["name"]))):
            flag = "" if truth is None or str(m["student_id"]) in truth else "  <- NOT in truth (false positive?)"
            print(f"  {Path(clip['video']).stem[:15]:<16}{str(m['name'])[:25]:<26}{m['k']:>6}{(m['t'] or 0):>7.1f}"
                  f"{(m['attempt'] or 0):>8}{(m['sightings'] or 0):>6}{(m['score'] or 0):>7.2f}{flag}")
        if truth is not None:
            got = {str(m["student_id"]) for m in clip["matches"]}
            names = {str(e["student_id"]): (e.get("name") or e["folder"]) for e in clip["enrolled"]}
            for missing in sorted(truth - got):
                print(f"  {Path(clip['video']).stem[:15]:<16}{names.get(missing, missing)[:25]:<26}  NEVER MATCHED (false negative)")

    grid, max_k, max_c = a["grid"], a["max_k"], a["max_c"]
    print(f"\nRecall by window (attempt budget {max_c}); compute = detection of k frames + recognitions, per clip, on this machine")
    print(f"  {'frames':>6}{'seconds':>8}{'matched':>9}{'recall':>8}{'new':>5}{'false+':>8}{'recognitions':>14}{'compute s':>10}")
    previous = 0
    for k in range(1, max_k + 1):
        matched, false_pos, recognitions = grid[(k, max_c)]
        compute = (k * a["det_ms"] * a["n_clips"] + recognitions * a["ms_per_recognition"]) / 1000 / a["n_clips"]
        mark = "  <- target reached" if k == a["best_k"] else ""
        print(f"  {k:>6}{k * spacing:>8.1f}{matched:>9}{matched / a['wanted']:>8.0%}{matched - previous:>5}{false_pos:>8}"
              f"{recognitions / a['n_clips']:>14.0f}{compute:>10.1f}{mark}")
        previous = matched

    caps = sorted({c for c in (1, 2, 3, 4, 5, 6, 8, 10, max_c) if c <= max_c})
    ks = sorted({k for k in (1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, max_k, a["best_k"] or 1) if 1 <= k <= max_k})
    print("\nGrid: recall % / recognitions per clip, for window (rows, frames) x attempt budget (columns)")
    print("  " + f"{'':>8}" + "".join(f"{'<=' + str(c) + ' tries':>16}" for c in caps))
    for k in ks:
        cells = "".join(f"{grid[(k, c)][0] / a['wanted']:>9.0%} /{grid[(k, c)][2] / a['n_clips']:>5.0f}" for c in caps)
        print(f"  {k:>3} fr  {cells}")

    # attempts spent on faces that never matched
    wasted = total = 0
    for clip in clips:
        for track in clip["tracks"]:
            total += len(track["attempt_frames"])
            if track["student_id"] is None:
                wasted += len(track["attempt_frames"])
    if total:
        print(f"\n{wasted} of {total} recognitions ({wasted / total:.0%}) went to faces that never matched anyone; "
              f"that is the price of the attempt budget ({a['ms_per_recognition']:.0f} ms each here).")

    print("\nRecommendation")
    if a["best_k"] is None:
        last = max((m["k"] for c in clips for m in c["matches"]), default=0)
        print(f"  Target {target:.0%} recall was NOT reached inside {max_k} frames (last new match at frame {last}). "
              f"Re-run with a longer --duration, or check the NEVER MATCHED students above (is the face visible? is the gallery photo good?).")
    else:
        window = min(a["best_k"] + margin, max_k)
        print(f"  Window: {a['best_k']} frame(s) reach {target:.0%} recall; with {margin} spare frame(s) use {window} "
              f"frames = {window * spacing:g} s of looking at the camera.")
        budget = min(a["best_c"] + 2, max_c)
        print(f"  Attempt budget: every match came within {a['best_c']} attempt(s); with 2 spare use {budget} attempts per face "
              f"({grid[(a['best_k'], budget)][2] / a['n_clips']:.0f} recognitions per clip in that window, against "
              f"{grid[(a['best_k'], max_c)][2] / a['n_clips']:.0f} with {max_c}).")
        print("  These come from a handful of clips: add more clips (other classes, bad lighting, a late arrival) before fixing the numbers.")


# ============================================================================== running clips
def run(args):
    import cv2
    import recognize
    from datetime import datetime

    cap = cv2.VideoCapture(str(args.video))
    if not cap.isOpened():
        sys.exit(f"Cannot open {args.video}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    cap.release()
    every = max(1, round(fps * args.spacing))

    print("Loading models ...")
    model = recognize.FaceModel(args.models, recognize.parse_det_size(args.det_size), args.det_thresh, args.rec_model)
    print(f"  {model.describe()}")
    if args.students_json:
        identity_map = recognize.build_identity_map(recognize.load_roster(args.students_json))
        cache_key = args.class_id or recognize.roster_cache_key(identity_map)
    else:
        identity_map = recognize.identity_map_from_gallery(args.gallery)
        cache_key = "all"
    enrolled = [{"student_id": str(v["student_id"]), "name": v.get("name"), "folder": folder}
                for folder, v in identity_map.items()]
    truth_ids = None
    if args.truth:
        truth_ids, unknown = load_truth(args.truth, enrolled)
        for line in unknown:
            print(f"  warning: truth entry not used: {line}")
        print(f"  truth: {len(truth_ids)} student(s) who should be found")

    overrides = {"every": every, "duration": args.duration, "max_attempts": args.max_attempts}
    if args.threshold is not None:
        overrides["threshold"] = args.threshold
    if args.accept_threshold is not None:
        overrides["accept_threshold"] = args.accept_threshold
    settings = recognize.make_settings(**overrides)
    result = recognize.run_attendance(model, str(args.video), identity_map, settings, args.gallery, cache_key)

    record = clip_record(args.video, result, enrolled, truth_ids, args.spacing, fps, machine=model.backend_summary())
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{Path(args.video).stem}_{datetime.now():%Y%m%d_%H%M%S}.json"
    out.write_text(json.dumps(record, indent=1))
    print(f"\nSaved {out}")
    print_report([record], args.target, args.margin)


def report(args):
    clips = [json.loads(Path(p).read_text()) for p in args.files]
    print_report(clips, args.target, args.margin)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    run_p = sub.add_parser("run", help="scan one clip with a long window and save what happened")
    run_p.add_argument("--video", required=True)
    run_p.add_argument("--truth", default=None, help="text file: who is really in the clip, one per line")
    run_p.add_argument("--duration", type=float, default=20.0, help="seconds of video to scan (longer than you expect to need)")
    run_p.add_argument("--spacing", type=float, default=1.0, help="seconds between processed frames")
    run_p.add_argument("--max-attempts", type=int, default=10, help="keep this high: the report shows what a lower budget would do")
    run_p.add_argument("--threshold", type=float, default=None)
    run_p.add_argument("--accept-threshold", type=float, default=None)
    run_p.add_argument("--students-json", default=None, help="roster of this class (omit: every gallery folder is a student)")
    run_p.add_argument("--class-id", default=None)
    run_p.add_argument("--gallery", default=str(HERE / "gallery"))
    run_p.add_argument("--models", default=str(HERE / "models"))
    run_p.add_argument("--rec-model", default="adaface_ir101_webface4m.onnx")
    run_p.add_argument("--det-size", default="1920x1080")
    run_p.add_argument("--det-thresh", type=float, default=0.3)
    run_p.add_argument("--out-dir", default=str(HERE / "window_study"))
    run_p.add_argument("--target", type=float, default=0.95, help="recall you want, e.g. 0.95")
    run_p.add_argument("--margin", type=int, default=1, help="spare frames added to the window the report finds")
    run_p.set_defaults(func=run)

    rep_p = sub.add_parser("report", help="pool saved runs into one report")
    rep_p.add_argument("files", nargs="+")
    rep_p.add_argument("--target", type=float, default=0.95)
    rep_p.add_argument("--margin", type=int, default=1)
    rep_p.set_defaults(func=report)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
