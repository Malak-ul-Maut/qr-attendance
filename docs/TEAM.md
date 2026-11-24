# Working as a team

Four people, one repo, and some data that must **not** be in it: real student records, face photos, CCTV footage and secrets. This page describes how the team keeps that data in sync without committing it.

> The repository appears to be public (the face-engine files are served from it through jsDelivr, which only serves public repos). Anything committed is visible to everyone and stays in git history even after it is deleted.

## What is shared, and how

| Thing                                  | Shared through                                         | In git? |
| -------------------------------------- | ------------------------------------------------------ | ------- |
| Code and `schema.sql`                  | Git                                                    | Yes     |
| Default settings                       | [`.env.example`](../.env.example)                      | Yes     |
| Personal settings and secrets (`.env`) | Not shared; everyone has their own                     | No      |
| Demo database (placeholder people)     | `backend/db/demo.db`                                   | Yes     |
| Real database, face gallery, CCTV clips | A private Google Drive folder, `npm run team-data`    | No      |

## First run for a new teammate

```bash
git clone https://github.com/Malak-ul-Maut/qr-attendance.git
cd qr-attendance
npm install
npm run assets            # face-engine files (too big for git)
cp .env.example .env      # then edit it, see below
npm run team-data         # real database, gallery and clips from Drive (needs the one-time setup below)
npm start
```

No access to the Drive folder yet, or just trying the app? Use `npm run demo-db` instead of `npm run team-data`. It installs the anonymised demo database; every account in it has the password `password`.

## `.env`

`.env` is personal and stays out of git.

- Settings that should be the same for everyone, with a sensible default, go in `.env.example`.
- `ADMIN_SESSION_SECRET`: everyone makes their own. Each person runs their own server, so it does not need to match.
- `NGROK_AUTHTOKEN` and `NGROK_DOMAIN`: personal to each ngrok account, and a free account gets one static domain. Use `TUNNEL=none` when the LAN is enough.
- A secret the whole team needs (for example the password of the classroom cameras) lives in a shared vault in a password manager such as Bitwarden or 1Password, not in git, chat or a screenshot.

## Private data in Google Drive

### What goes in the folder

```
qr-attendance-data/
  database.db     one-file snapshot of the database
  gallery/        face photos, one folder per student
  clips/          CCTV test videos
```

The gallery folders are named after student ids (`<id>_<first name>_<roll number>`), so **a gallery only matches the database it came from**. The three parts are always bundled and installed together, and the demo database cannot be used with a real gallery.

The bundle holds real names, phone numbers, passwords (stored in plain text, see [Privacy and security](../README.md#privacy-and-security)) and face photos. Only the four team members should be able to open it.

### Owner: share the folder

1. In Drive, create a folder `qr-attendance-data`.
2. Share it with the teammates' Google accounts as **Viewer**. Set general access to **Restricted** and untick *Editors can change permissions and share*.
3. Leave *Viewers and commenters can see the option to download, print, and copy* switched **on**. Turning it off also blocks the download that `npm run team-data` performs.

### Owner: publish a snapshot

On the machine that holds the real data:

```bash
npm run team-data -- bundle      # builds ./team-data from the local database, gallery and clips
```

Then either drag the contents of `team-data/` into the Drive folder, or upload with `npm run team-data -- push` (needs rclone, below). The bundle removes the CCTV camera addresses from the database copy because they contain a login; add `--keep-cameras` if a teammate needs live camera access.

Publish a new snapshot after bigger changes such as a new timetable or new enrolments. Teammates replace their database with `npm run team-data -- --force`.

### Teammates: one-time setup with rclone

[rclone](https://rclone.org) signs in to Google Drive once and then downloads the folder with a single command.

1. Install it: `winget install Rclone.Rclone` (Windows), `brew install rclone` (macOS) or `sudo apt install rclone` (Linux).
2. Run `rclone config`, choose `n` (new remote), name it `gdrive`, pick the storage type `drive`, leave the client id and secret empty, choose the scope `drive.readonly` (the owner needs `drive`, to upload), and accept the browser sign-in with the Google account that was given access.
3. Open the shared folder in Drive. The last part of its address (`.../folders/<this part>`) is the folder id. Put these in `.env`:

   ```
   TEAM_DATA_REMOTE=gdrive:
   TEAM_DATA_FOLDER_ID=<folder id>
   ```

4. Run `npm run team-data`.

### What `npm run team-data` does

- **Download:** copies the Drive folder into `./team-data` (git-ignored). It never deletes anything, and files that have not changed are skipped.
- **Install:** copies `database.db` to `backend/db/`, the gallery to your gallery folder and the clips next to the recognition service. The locations follow your `.env` (`GALLERY_DIR`, `CCTV_GALLERY_DIR`, `CCTV_TEST_CLIP`), so a custom setup keeps working.
- **Your local changes are safe.** An existing `database.db` is kept, and gallery files or clips that already exist are not overwritten. `--force` replaces them. The app writes to the gallery (face enrolment saves photos there, and the CCTV service adds confirmed crops unless `CCTV_GROW_GALLERY=off`), so everyone works on a local copy and nobody runs against the shared folder.

### Without rclone

- **Drive for desktop:** if the shared folder is available as a local folder, run `npm run team-data -- install --from "<path to that folder>"`.
- **Browser download:** download the folder from the Drive website, unzip it into `./team-data` so that `database.db`, `gallery/` and `clips/` sit directly inside, and run `npm run team-data -- install`.

## The demo database

`backend/db/demo.db` has the same structure as the real one (classes, timetable, sessions, attendance marks) with placeholder names, no face data and no camera addresses.

- `npm run demo-db` installs it as `backend/db/database.db`; `npm run demo-db -- --force` replaces an existing one.
- `npm run demo-db:build` rebuilds it from a real database (`npm run demo-db:build -- path/to/other.db` for another file). The source is only read.
- **Changing the schema:** edit `backend/db/schema.sql`, rebuild `demo.db` from a database that has the change, and commit both in the same pull request. Teammates then reinstall their database. There is no migration tool yet, so the real deployment needs the change applied by hand.

## If something private was committed

If `.env`, `database.db`, a gallery or a clip was ever pushed to the public repo:

1. **Rotate first.** Change the ngrok token and the password of the classroom cameras. Deleting a file does not remove it from history.
2. Stop tracking it with `git rm --cached <file>`; `.gitignore` already lists the right paths.
3. Remove it from history with [`git filter-repo`](https://github.com/newren/git-filter-repo) (or BFG), force-push, and have all four of you re-clone. Take care with the tags the CDN uses in `assets.manifest.json`: after a rewrite they point at new commits and must be re-created before the face engine loads again.
