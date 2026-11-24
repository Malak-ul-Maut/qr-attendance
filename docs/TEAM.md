# Working as a team

Four people, one repo, and some things that must **not** be in it: real student data, face photos, CCTV footage and secrets. This page shows how to stay on the same page without committing them.

> The repository appears to be public (the face-engine files are served from it through jsDelivr, which only serves public repos). Treat everything committed as visible to everyone, and it stays in git history even after it is deleted.

## What is shared, and how

| Thing                          | Shared through                         | Committed?        |
| ------------------------------ | -------------------------------------- | ----------------- |
| Code, `schema.sql`             | Git                                    | Yes               |
| Settings (names, defaults)     | [`.env.example`](../.env.example)      | Yes               |
| Your own secrets (`.env`)      | Not shared; everyone has their own     | **No**            |
| Database for development       | `backend/db/demo.db` (anonymised)      | Yes, it is safe   |
| The real database              | Stays on the machine that runs the college deployment | **No** |
| Face gallery and CCTV clips    | A private team folder or private repo  | **No**            |

## Day one for a teammate

```bash
git clone https://github.com/Malak-ul-Maut/qr-attendance.git
cd qr-attendance
npm install
npm run assets            # face-engine files (too big for git)
cp .env.example .env      # then edit it, see below
npm run demo-db           # same demo database as everyone else
npm start
```

Sign in as `admin` / `password`. Faculty are `faculty01`, `faculty02`, ... and students are numbered in **Setup → Students**. Every password in the demo database is `password`. It is for local development only; never expose it through a tunnel for real users.

## `.env`

`.env` is per person and stays out of git.

- Put every setting that should be the same for everybody, with a sensible default, in `.env.example` and commit that.
- `ADMIN_SESSION_SECRET`: everyone makes their own. Each person runs their own server, so it does not need to match.
- `NGROK_AUTHTOKEN` / `NGROK_DOMAIN`: personal to each ngrok account. A free account gets one static domain, so teammates should not share one. Use `TUNNEL=none` when you only need the LAN.
- A secret that really must be shared (for example the password of the classroom camera) goes in a password manager's shared vault such as Bitwarden or 1Password, not in git, chat or a screenshot. If you later want secrets next to the code, an encrypted env file (for example [dotenvx](https://dotenvx.com) or [SOPS](https://github.com/getsops/sops)) can be committed safely.

## The database

The real `database.db` holds students' names, phone numbers, attendance, face data and the login of the classroom cameras, so it never goes into git.

- **Everyone develops against `backend/db/demo.db`.** `npm run demo-db` copies it into place. It has the same shape as the real one (classes, timetable, sessions, 3,700 attendance marks) but placeholder names, no face data and no camera addresses.
- **Refresh it** from a real database with `npm run demo-db:build` (or `npm run demo-db:build -- path/to/other.db`). The source is only read. Open the result and look around before committing it.
- **Changing the schema?** Edit `backend/db/schema.sql`, then rebuild `demo.db` from a database that has the change, in the same pull request. Teammates then run `npm run demo-db -- --force` to replace their local copy. There is no migration tool yet, so the real deployment needs the change applied by hand.
- A brand-new empty database is still created automatically when none exists and you did not run `demo-db`.

## Face gallery and CCTV test clips

These contain real people's faces, so they must not go into a public repository, and you should have your institution's permission to keep them. Prefer a small set of your own team's faces plus a few volunteers over a whole class.

The paths are already settings, so no code change is needed. Keep the files **outside** the project folder, and point `.env` at them:

```
CCTV_TEST_CLIP=../qr-attendance-data/clips/f310.avi
GALLERY_DIR=../qr-attendance-data/gallery
CCTV_GALLERY_DIR=../qr-attendance-data/gallery
```

Where to keep that folder (pick one):

1. **A private GitHub repository** (for example `qr-attendance-data`) that only the four of you can read. Clone it next to the project. It works well for a gallery and a few short clips. GitHub refuses single files over 100 MB, so use [Git LFS](https://git-lfs.com) for long videos (the free quota is small).
2. **A shared drive folder** (Google Drive, OneDrive) that everyone syncs. Simplest for large clips.

Either way, treat the shared copy as a read-only seed and **copy it to a local folder before you run the app**. The app writes to the gallery (face enrolment saves photos there, and the CCTV service adds confirmed crops unless `CCTV_GROW_GALLERY=off`), so four people running against one live folder will overwrite each other.

## If something private was committed

If `.env`, `database.db`, a gallery or a clip was ever pushed to the public repo:

1. **Rotate first.** Change the ngrok token and the RTSP password of the classroom cameras. Deleting a file does not remove it from history.
2. Stop tracking it: `git rm --cached <file>`; the `.gitignore` already lists the right paths.
3. Remove it from history with [`git filter-repo`](https://github.com/newren/git-filter-repo) (or BFG), force-push, and have all four of you re-clone. Take care with the tags the CDN uses in `assets.manifest.json`: after a rewrite they point at new commits and must be re-created before the face engine loads again.
