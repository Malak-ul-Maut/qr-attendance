# Smart Attendance Marker: words and formats

One name for each thing, in every screen, button, toast and error. Code names can stay as they are; this is what
people read. Items marked **pending** need a decision before Stage 7.

## Terms

| Say | Means | Code name | Do not say |
|---|---|---|---|
| **Term** | One academic session, like `2026-2027 ODD` | `academic_session` | "Session" for this (see Session below), "Academic session" in headings |
| **Class** | Branch + semester + section inside a term, like `CSE 5A` | `classes` | |
| **Classroom** | One home room plus the class or classes that use it. `CSE-5A` is one class in one classroom; `DS/AIML-5D` is two classes sharing one classroom | `classroomMap()` in `routes/admin/common.js` | Using "class" and "classroom" for each other |
| **Home room** | The room a classroom normally uses | `room_id` on the class | |
| **Room** | A physical place: classroom, lab or seminar hall, like `F-307` | `rooms` | |
| **Period** | One timetable slot with a start and end time. Students and faculty see "Period 3" or "P3" | `slots` | "Slot" in any screen text |
| **Double lecture** | Two or more consecutive periods of the same subject, faculty, room and batch, drawn as one block. Attendance is still recorded per period | `groupRows()` in `today-logic.js` | "Lab block", "merged period" |
| **Batch** | A lab group inside a class, like `G1` | `batch` | |
| **Session** | One attendance run that a faculty member starts for one or more periods | `/api/session/*` | Using it for a Term |
| **Regular / Extra** | The two ways to start a session. **Extra** covers extra classes, borrowed periods and merged classes, and only offers classes the faculty teaches | `arranged` | "Arranged", "borrow" or "merge" in headings |
| **QR / Camera** | The two ways a student is marked. A third source, **Teacher**, is a manual mark | `method`, `marked_by` | "CCTV" in student-facing text |
| **Face photos** | The photos a student saves so the camera can recognise them. States: Not added, Waiting for approval, Approved | `enrollment` | "Enrolment" in screen text |
| **Present / Absent** | The two outcomes. Percentages are measured against the 75% line | | |
| **Teacher** | What students call their faculty member | | |
| **Faculty** | What staff and admin call them | `faculty` | |
| **Draft / Published** | The two states of a timetable. Published ones show "w.e.f." (with effect from) a date | | |
| **Setup** | The admin tab for terms, classes, rooms, subjects, faculty and students | `master` | "Master" in screen text |

**Pending:** the admin Setup table titled "Classes". If its rows stay one per class, the title stays "Classes". If you
want "Classrooms", the rows must group by classroom, with the branch shown inside, so `DS 5D` and `AIML 5D` become one
`DS/AIML-5D` row. Decide this before Stage 7.

## Formats

- Dates: `20/10/2026`. With the weekday: `Tue, 20/10/2026`. In headings and chart axes: `Tue, 20 Oct` or `20 Oct`.
- Times: `1:30 pm` and `10:42 am`. Lower-case, no leading zero, no 24-hour clock.
- All of these come from `frontend/js/format.js`. Do not call `toLocaleDateString` or `toLocaleTimeString`: they print
  differently on every phone.
- Percentages: whole numbers, `78%`. Counts: `18 of 62`.

## Writing rules

- Sentence case everywhere: "Start session", not "Start Session".
- A button says what happens, with a verb and an object: "Start session", "Save changes", "Discard session". The toast
  that follows uses the same words: "Session discarded".
- Errors say what happened and what to do next. They never apologise and never blame the person.
- Empty screens point to the next action.
- Keep the face-photo and attendance screens short. A line that updates while someone is moving should be one short
  English phrase. The Hindi pose name is the only Hindi text there.
- No emoji in the interface.
