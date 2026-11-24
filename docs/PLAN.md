# Project Plan

> Started 2026-11-23. This is a living document: the plan for what the app will do and in what order.
> Only "What exists today" is built. How it works, and the decisions made so far, are in
> `docs/ARCHITECTURE.md`. Everything else here is still a proposal: once one is decided or built,
> record it (and why) there, and update this plan to match.

## Goal

Automatically build the employee schedule for a Mathnasium center and publish it to Sling.

The schedule is driven by two inputs:

- **Demand**: the students expected, at the center and online. That's the appointments booked in
  Radius, plus the students who come without booking, predicted from their sign-in history. Demand
  decides how many instructors are needed in each part of the day, and whether they have to be at the
  center or can work from home.
- **Supply**: when each employee can work, from the availability the director enters in the app and
  their time off in Sling, plus the hours and preferences the director records for them.

The app generates a draft. The director reviews it, adjusts it if needed, and sends it to Sling,
where it stays unpublished until the director publishes it there.

As a stretch goal, a booking assistant answers parents' appointment requests by email and text: it
checks the schedule, books a time if there's room, and replies.

Everything runs serverless on Cloudflare: a Worker for the web app and API, Workflows for background
jobs, Durable Objects to coordinate sign-ins, and D1 for storage. There is no server to maintain.

## Users

**Only the director uses the app** (in practice the owner or an assistant center director). They
connect Radius and Sling, set the center's scheduling rules, and review and publish schedules.

**Employees never use the app.** They request time off in Sling, as they do today, and
see their published shifts there. The director enters their availability in the app.

**One center.** The app serves this one center, so settings, roster and linked accounts aren't
split by center (answered 2026-11-24).

**Parents** don't use the app either. The booking assistant (feature 11) talks to them by email and
text.

## Glossary

- **Radius**: Mathnasium's center management system (radius.mathnasium.com). Source of truth for
  student appointments and the student-to-instructor ratio. The app reads from it. Only the booking
  assistant (feature 11) writes to it, to book appointments. The school programs aren't in Radius.
- **Sling**: the shift-scheduling app the center uses (getsling.com). Source of truth for employee
  time off and the published schedule. This app reads from it and writes shifts to it. Availability
  is a Premium feature this center doesn't have, so it's entered in the app instead (feature 3).
- **Appointment**: a student's booked session in Radius. Usually 60 minutes for elementary and
  middle school students and 90 minutes for high school, and usually the same length every time for
  a given student.
- **Online appointment**: an appointment taught over video (Mathnasium@home). The student is at home.
  The instructor can be at the center or working from home.
- **Remote shift**: a shift worked from home, for example to teach online appointments. Someone on a
  remote shift doesn't count toward who's at the center.
- **Visit**: one student's actual time at the center, from sign-in to sign-out, as recorded in Radius.
- **Unbooked visit**: a visit with no matching appointment.
- **Level**: how advanced a student's math is. Radius groups grades into levels in each center's
  settings. This center has Great Foundations (Pre K–K), Elementary (1–6), Middle (7–8) and High
  (9–12). Each instructor can teach up to some level.
- **School program**: teaching done off-site at a school (currently Valencia and Rio del Mar), staffed
  by the same employees. Not in Radius; set up in the app.
- **Supervisor**: the owner or an assistant center director. One of them must be at the center
  whenever it's open.
- **Teaching time vs. on-site time**: an employee can be at the center without teaching, for example
  doing admin work. Only teaching time counts toward instructor coverage.
- **Time block**: the unit the scheduler plans in. Proposed: 15 minutes, the same as Radius'
  calendar slots, since appointments start on any 15 minutes.
- **Coverage**: instructors needed vs. instructors scheduled in a time block.
- **Shift**: one continuous stretch of work for one employee in one place (the center, a school
  program, or remote), as published to Sling.
- **Draft**: a generated schedule that hasn't been published to Sling yet.
- **Break**: a paid 10-minute break during a shift of 4 hours or more.
- **Booking assistant**: the bot that answers parents' appointment requests by email and text
  (feature 11).

## What exists today

Login with Radius, linking Sling, the Radius and Sling views embedded in the app, and the Cloudflare
Worker with D1. `docs/ARCHITECTURE.md` describes how they work, along with the decisions made so
far.

This gives the Worker signed-in access to both Radius and Sling, which every feature below builds on.

## Features

### 1. Center setup

The director configures the rules the scheduler uses:

- Operating hours for each day of the week.
- Presence rules: who must be at the center whenever it's open, for example "at least two
  employees, one of them a supervisor". Someone counts as present whether they're teaching, doing
  other work or on a break, but not while working remotely. (The director confirmed 2026-11-24 that
  two people on, one of them on a break, is fine.)
- Locations: the center, remote work, and each school program with its days, times and number of
  instructors needed (Valencia needs 2, Rio del Mar 3). The programs aren't in Radius, so they're only
  set up here. Also the travel time between locations, and a travel allowance for anyone who works
  from home and at the center on the same day.
- Shift rules: minimum and maximum shift length, maximum shifts per day, and time before the first
  appointment and after the last one for setup and cleanup.
- Break rule: a paid 10-minute break for anyone working 4 hours or more.
- Planning horizon and cadence. Employees should have their schedule at least 3 days before it
  starts. With weeks starting Monday (Sling's setting), the week is in Sling by Friday, so the draft
  is generated earlier, for example Wednesday, to leave time for review.
- How Radius and Sling line up: which Sling location and positions correspond to the center, remote
  work, the school programs and the center's roles.

The student-to-instructor ratio isn't entered here: the app reads it from Radius, where the center
already sets it. Radius' Center Settings has an in-center ratio and an online ratio for each level.
This center's are:

| Level | Grades | In-center | Online |
| --- | --- | --- | --- |
| Great Foundations | Pre K, K | 1:1 | 1:1 |
| Elementary | 1–6 | 4:1 | 3:1 |
| Middle | 7–8 | 4:1 | 3:1 |
| High | 9–12 | 3:1 | 2:1 |

Radius also has its own booking capacity (Scheduling → Default capacity): groups of days and hours,
each with a number of instructors (for example Monday and Wednesday, 1–6 PM, 3 instructors).
Radius multiplies that by the ratio to decide how many seats parents can book, so 3 instructors at
4:1 gives 12 seats. This is the center's guess at staffing, not the Sling schedule. If the app's
schedule staffs a time differently, the director may want this capacity updated to match.

How that capacity works, from Mathnasium's myMathnasium Center Admin Guide (October 2026):

- Each row has a name, days, a time range, delivery methods, a number of instructors (decimals
  allowed) and the session types its instructors can teach. Rows with different names that overlap
  add up. Rows with the same name that overlap don't: the most recently added one wins.
- A session type is "what an instructor can teach", and each grade range is assigned one. Standard
  covers elementary and middle school; High School, Great Foundations and Private are separate. The
  guide recommends separate rows for Great Foundations and Private so they don't use up the others'
  capacity.
- A row with both In-Center and Online checked shares its instructors between the two. Separate rows
  give each its own capacity. This matches question 22: one instructor can take both.
- Capacity can be by instructors (ratio-based, as here) or by seats (all ratios set to 1:1), chosen
  in Radius' Scheduling settings.
- Pods (Radius calls them groups) are optional sub-capacities where a student works with one
  instructor. Groups don't share capacity. Parents never see pods or instructors, only open times.
  This center doesn't use pods (confirmed 2026-11-24), so the app can ignore `PodLabel`.
- Times with no capacity can't be booked, so they work as drop-in times.
- The default capacity applies to every future week that hasn't been edited by hand. A week can be
  edited on its own, which is how capacity could follow each week's schedule (open question 27).
- Booking start times can be limited to :00, :15, :30 or :45 in Radius' Scheduling settings, and
  only franchise owners can open Radius Settings.

### 2. Employee roster

- Import employees from Sling (people, positions, locations) and keep the list in sync.
- Any employee can be scheduled, whatever their role (answered 2026-11-24).
- The director records what Sling doesn't have:
  - Role: owner, assistant center director, instructor, front desk. Presence rules use roles
    (for example "a supervisor on site").
  - Highest level they can teach (for example "up to middle school"), and other qualifications
    (SAT/ACT prep, can run assessments). Levels follow the student's grade (answered 2026-11-24).
  - Teaching limit, for people with other duties: the largest share of their time on site that
    should be teaching (for example Carol: 50% at most). The rest is on-site time for other work.
  - Preferred programs: employees who should be first choice for a school program.
  - Remote work: whether they can work from home, for example to teach online appointments. Today
    everyone can, so this defaults to yes.
  - Priority or seniority, used to break ties.

### 3. Employee availability and preferences

**From Sling**, read fresh every time the app generates a schedule:

- **Time off**: approved time off blocks scheduling. Pending requests are shown to the director so
  they can decide before generating. Time off works on the free plan. Requests need approval.

**From the director**, in the app, for what Sling doesn't hold:

- **Availability**: the weekly windows each employee can work, entered in the app (decided
  2026-11-24). Sling only has it on Premium ("unavailability"; reading it on this center's free plan
  answers 402). To save typing, the app can suggest each person's windows from the shifts they've
  worked in Sling, for the director to confirm or correct. Availability can change over time, so
  each entry can have a start date (for example a new school term).
- **Hours**: minimum, preferred and maximum hours per week.
- **Preferences**: days or times an employee would like to work or avoid. Unlike availability, these
  are wishes the scheduler tries to honor, not hard limits.
- **Shift length preference**: for example "no shifts under 2 hours".
- **Work-from-home days**: days they'd rather work from home (for example Carol on Sundays and
  Wednesdays). On those days the scheduler only puts them at the center if nobody else can cover.

Before generating, the app flags employees with no availability entered, so the director can check
with them.

### 4. Demand

**At the center** (from Radius):

- Read the appointments for the planning horizon from Radius. Appointment Management's data request
  returns any date range at once, with each appointment's grade, session type, delivery method,
  status and length. The calendar's `/Scheduling/CalendarData` returns one day. See "Radius
  endpoints found so far".
- Count in-center students in each time block by level, and convert that to instructors needed at
  each level using the ratio from Radius. For example, four high school students need enough
  instructors who can teach high school, not just enough instructors. Each appointment carries the
  student's grade, which maps to a level through the center's grade ranges.
- Appointments are usually 60 minutes for elementary and middle school and 90 for high school, and
  usually the same length each time for a given student. They start on any 15 minutes (Radius'
  calendar counts seats in 15-minute slots), so the scheduler plans in 15-minute blocks.
- Account for appointments that need specific skills (assessments, test prep).
- Skip appointments left over from ended enrollments. Radius doesn't cancel a student's future
  recurring appointments when their enrollment ends: staff have to remove them by hand. Until
  Mathnasium's planned fix ships, those appointments look like real demand. Check each appointment's
  enrollment, or flag recurring appointments for students who no longer attend.
- Add the students predicted to come without an appointment (feature 5). Most students book, so
  booked appointments are most of the demand and the prediction fills in the rest.
- Add the presence rules on top: two employees, one of them a supervisor, whenever the center is
  open, even if no students are booked.

**Online** (from Radius): online appointments are counted the same way, by level, but separately.
They don't need anyone at the center: an instructor at the center can take them alongside
in-center students (answered 2026-11-24), or someone on a remote shift. Each appointment has a delivery method ("In-Center" or "Online"), and online students
use the online ratio, which is lower. Online appointments are rare today: 13 of about 3,400 between
June and November 2026.

**School programs** (off-site): each program's days, times and instructors needed come from center
setup (Valencia needs 2, Rio del Mar 3). This demand is fixed, not predicted.

### 5. Predicted attendance

Most students book appointments, but some don't and still come in on a predictable pattern, for
example every Tuesday and Thursday after school. The app predicts them from their history of signing
in and out. This corrects booked demand rather than replacing it, so the scheduler is useful before
prediction exists.

- **History**: Radius' Student Attendance Report (`/StudentAttendanceMonthlyReport`) has one row per
  visit: student, date, arrival time, departure time, length and delivery (in-center or @home), for
  any date range. Visits don't record the instructor. The app reads the data behind that report,
  imports past visits once, then keeps them up to date daily. This center's history starts on
  2023-01-03: about 16,400 visits so far, roughly 4,700 a year. See "Radius endpoints found so far".
- **Find unbooked visits**: Radius seems to mark them already. Appointment Management lists entries
  with the status "Drop-In", with no pod assigned, which look like check-ins without a booking.
  Confirm this with the director. Other statuses are Scheduled, Attended, Cancelled, Late cancelled
  and No show, so no-shows are marked too. Matching visits to appointments is the fallback.
- **Learn each student's pattern**: for each weekday, how likely the student is to come, when they
  usually arrive and how long they stay. Length is usually the same each visit, and follows grade
  (60 minutes, 90 for high school) when there's little history. Recent weeks count more than old ones, so a student who stops
  coming fades out instead of being predicted forever.
- **Predict a week**: for each time block, expected students = booked appointments + the chance that
  each regular unbooked student is there. A student who has an appointment that day is counted once,
  through the appointment.
- **Calendar effects**: school holidays, center closures and seasons (summer, exam time) change who
  comes. The director can mark these dates. Later, the history can reveal them on its own.
- **Show and override**: show demand split into booked and predicted. List the students behind each
  prediction with how confident it is, and let the director correct it (for example "comes
  Wednesdays now" or "has stopped coming").
- **Check accuracy**: compare predicted and actual attendance, for past weeks and then every week,
  and show the difference, so the director knows how much to trust the predictions.
- **Booked appointments, too**: the same history shows which students often miss appointments, or
  stay longer or shorter than booked. Predictions can adjust for that.
- **Sessions left this month**: Radius tracks how many sessions each student has left in the month
  (the check-in screen's "Remaining Sessions"). A student with many left near the end of the month is
  more likely to come; one with none left is unlikely to.

**Approach:** start with simple per-student weekday frequencies, weighted toward recent weeks. Only
try something more complex if the accuracy checks show it's needed.

### 6. Schedule generation

Builds a draft from the demand, the employees' availability and preferences, and the center rules.

**Hard constraints** (never broken):

- Only schedule an employee inside their availability and outside their time off.
- Stay within each employee's maximum hours, and within shift length limits.
- Only assign work that needs a qualification to qualified employees. An instructor only counts
  toward students at levels they can teach.
- Keep at least two employees at the center whenever it's open, at least one of them a supervisor.
  People on a remote shift don't count; people on a break do.
- Students at the center are covered only by instructors at the center. Online students can be
  covered by instructors at the center or on a remote shift.
- Only give remote shifts to employees who can work remotely.
- Leave travel time when someone works in two places on the same day (the center, a school program,
  or home).

**Soft goals** (weighed against each other):

- Cover every time block at every level. Understaffing costs much more than overstaffing. Predicted
  students are staffed for at their expected number, with no extra margin (decided 2026-11-24). A
  margin can be added later as a setting if the accuracy checks show it's needed.
- Get each employee close to their preferred hours, and at least their minimum.
- Honor preferred and avoided times.
- Spread hours, and unpopular shifts, fairly.
- Stay consistent with previous weeks (same people on the same days), so schedules are predictable.
- Prefer fewer, longer shifts over fragmented ones.
- Keep each employee's teaching within their teaching limit, so people with other duties have time
  for them.
- Staff each school program with its preferred employees first.
- When someone is needed only for online students, give them a remote shift instead of bringing them
  to the center. Online students go to instructors already at the center first, if they have room.
  Anyone can work remotely.
- Honor work-from-home days, and avoid splitting a day between home and the center. Work-from-home
  days are for admin work: don't give that person online students on those days.
- Give everyone working 4 hours or more a paid 10-minute break, timed so the instructors still
  teaching meet the ratio. The person on a break still counts toward the two-person minimum, so the
  scheduler doesn't add a third person just for breaks. A break can only be missed when the ratio
  can't be met without that person; report those.

**Output:**

- Draft shifts for each employee. Each shift says where it is (the center, a school program, or
  remote), which parts are teaching and which are other work, and when the break is.
- A coverage report: needed vs. scheduled for every time block, with each gap explained (for example
  "nobody available Tue 6:30–7:00 pm"). It also lists breaks that couldn't fit.
- For each employee: scheduled hours vs. preferred hours, and which preferences couldn't be met.

**Approach (proposed 2026-11-24):** an integer program solved with HiGHS (npm `highs`), instead of
starting with a greedy heuristic. A test on a synthetic week (`spikes/highs/`) solved it to the
optimum in about a second, in the Workers runtime, using 44 MB. Shifts have to be written in the
compact form (working or not per person and block, plus where each shift starts): listing every
possible shift went over Workers' 128 MB. It runs in a Workflow step, so it has to fit in up to 5
minutes of CPU and 128 MB of memory. A greedy heuristic stays the fallback.

### 7. Review and edit

- Show the draft as a calendar, both by employee and by time block, with coverage highlighted.
- Let the director add, move and remove shifts.
- Lock shifts so regenerating keeps them, then regenerate the rest around them.
- Warn when a manual edit breaks a rule (outside availability, over max hours, coverage gap).

### 8. Publish to Sling

- Create the shifts in Sling through its API, which the Worker already reaches with the stored token.
- **Leave them unpublished** (decided 2026-11-24): the app creates shifts with Sling's `planning`
  status, and the director gives them a last look and publishes them in Sling. This may become
  automatic later.
- Put each shift under the Sling location and position for where it is (the center, a school
  program, or remote).
- **Remote shifts**: Sling has no remote shift type, but every shift has a location and an account
  can have several. Remote shifts go under a "Remote" location. If the center uses Sling's time clock
  with geofencing, leave that location's address and IP blank: Sling's help says that exempts a
  location from geofence restrictions, so people can clock in from home. Sling already has an
  "Online" location, which could be used for this. The time clock is off at this center (checked
  2026-11-24), so geofencing doesn't matter today.
- Show each shift's break in Sling: shifts have a `breakDuration` field in minutes. No shift uses it
  today, and Sling's automatic breaks are off.
- Store the Sling ID of every shift the app creates. Publishing again updates or removes those shifts
  instead of duplicating them. The app never changes shifts it didn't create.
- **Existing repeating shifts**: most of today's schedule is hand-made repeating shifts in Sling
  (weekly, many ending in mid-December 2026). The app won't touch them, so a draft has to either
  treat them as fixed (like locked shifts) or wait until they end. See open question 26.
- Sling notifies employees of their new shifts on its own once the director publishes them there.

### 9. Automation

- **Scheduled runs** (Cloudflare Cron Triggers): for example, generate next week's draft every
  Wednesday and notify the director that it's ready for review, so it can be in Sling by Friday,
  3 days before the week starts.
- **Change detection**: keep re-reading Radius after a schedule is published. If new or cancelled
  appointments open a coverage gap or a large surplus, alert the director and suggest a fix (for
  example, an available employee who is under their preferred hours).
- **Background jobs**: anything slow (a Sling sign-in can take a minute because of the captcha;
  generating a schedule may be CPU-heavy) runs as a Cloudflare Workflow instead of inside a web
  request. See "Planned architecture".
- **Notifications**: to the director only (draft ready, coverage gap, employees missing
  availability). Employees hear about their shifts from Sling.

### 10. History and reporting (later)

- Keep past schedules alongside the demand that actually happened.
- Reports: hours per employee, coverage achieved, how well preferences were met.
- Use more than a few months of history to improve predictions (feature 5), for example patterns that
  repeat each school year.

### 11. Booking assistant for parents (stretch goal)

A bot that handles parents' appointment requests by email and text. It reads the message, checks the
schedule, books the appointment in Radius if there's room, and replies. When a parent gives a window
("any afternoon next week") and several times work, it picks the best one.

Parents can already book themselves in Mathnasium's parent app (myMathnasium). The bot is for
parents who email or text instead.

**Flow** (one Workflow per incoming message):

1. **Receive**: emails arrive through Cloudflare Email Routing, which hands each message to the
   Worker. Texts arrive from an SMS provider (for example Twilio) as a webhook.
2. **Identify**: match the sender's email address or phone number to a family in Radius. Messages
   from unknown senders go to the director.
3. **Understand**: Claude reads the message and returns a structured request: what the parent wants
   (book, reschedule, cancel, or a question), which student, and which days and times work. Anything
   else (billing, complaints, unclear messages) goes to the director.
4. **Find times**: code, not the model, lists the open times in the parent's window and ranks them
   (below).
5. **Book**: create the appointment in Radius.
6. **Reply**: Claude writes a short reply from the result (the booked time, or the alternatives on
   offer). The reply goes out on the channel the parent used. Radius also sends its own notice: the
   guide says myMathnasium notifies guardians, with an email, when a session is scheduled,
   rescheduled or cancelled.

**Choosing the best time** (code, using the same data as the scheduler):

- Only times when the center is open, and only if the student has sessions left this month (Radius
  tracks this for each student). A student with none left goes to the director, who may offer more.
- Within Radius' booking limits: daily and weekly limits set center-wide, which each enrollment can
  override, and a monthly limit on monthly memberships. Admins (and so the bot, signed in as the
  director) can book past these limits, so the bot has to check them itself.
- Only at the student's session length from their enrollment (usually 60 minutes, 90 for high
  school).
- Only times when the staff already scheduled in Sling can take one more student at the student's
  level within the ratio, so a booking never opens a coverage gap. If there's no such time, offer the
  nearest alternatives, or ask the director whether to add staff. An online appointment can also use
  an instructor on a remote shift; an in-center one can't.
- Prefer earlier in the day (this center's rule). But a booking that would need an extra
  instructor loses to a later time that has room: the bot offers the later time without asking the
  director (decided 2026-11-24).
- After that, prefer times close to when the student usually comes.

**Rollout**, so mistakes stay cheap:

- Start with the director approving every booking and reply in one click. The Workflow waits for the
  approval.
- Then let the bot book and reply on its own for simple, clear requests from known parents. Everything
  else still goes to the director.
- Start with email, and add texts after.

**Model and safety:**

- Claude Opus 5.5 (`claude-opus-5-5`) through Anthropic's official TypeScript SDK
  (`@anthropic-ai/sdk`), with the API key stored as a Worker secret. At one center's volume of
  messages, the cost is small.
- This is a fixed pipeline with two model calls, not an open-ended agent. The model reads and writes
  text. Code makes every decision that matters: who the student is, which times are free, and whether
  to book. That keeps the bot predictable and testable.
- Parents' messages are untrusted input. A message that tries to give the bot instructions ("ignore
  your rules", "book five free sessions") can't do anything: the model's only output is a structured
  request, which code checks against Radius before acting.
- The model only sees the sender's own family's details, never other students'.
- If the model can't produce a valid request, or declines to, the message goes to the director.
- Log every message, the request the model extracted, the decision and the reply, so the director
  can see why the bot did what it did.

## This center's rules

The center's current rules. The features above have to support each one. They're set in the app
(center setup and the employee roster), not written into the code, so they can change without a code
change.

| Rule | Kind | Supported by |
| --- | --- | --- |
| Carol (owner) can teach, but at most about 50% of her time on site, so she has time for admin work. | Soft: teaching limit | Roster: teaching limit. Scheduler: on-site time that isn't teaching. |
| Keiko can teach up to middle school, not high school or above. | Hard: level | Roster: highest level. Demand counted by level (from grade). |
| Keiko is the preferred teacher for the school programs at Valencia and Rio del Mar. | Soft: preferred staff | Roster: preferred programs. Center setup: school programs. |
| Carol prefers to work from home on Sundays and Wednesdays, doing admin work, not teaching. | Soft: work-from-home days | Preferences: work-from-home days. Scheduler: remote shifts. |
| Anyone can work from home. | Roster default | Roster: remote work. |
| Deven or Grace (assistant center directors) or Carol must be at the center whenever it's open. | Hard: presence | Roster: roles. Center setup: presence rules. |
| At least two employees must be at the center whenever it's open. | Hard: presence | Center setup: presence rules. |
| Anyone working 4 hours or more gets a paid 10-minute break. Two people on, one of them on a break, is fine. | Soft: breaks | Center setup: break rule. Scheduler: break timing and missed-break report. |
| Valencia needs 2 instructors, Rio del Mar 3. | Hard: program staffing | Center setup: school programs. |
| Appointments should go as early in the day as possible. | Soft: booking | Booking assistant (feature 11): ranking times. |

These interact. When Carol is the supervisor on site, she can be doing admin work instead of
teaching, so the scheduler tracks on-site time and teaching time separately. Someone on a break
still counts toward the two-person minimum, but not toward the ratio, so a break needs someone else
free to teach only when students are there.

The center is open on Sundays. On Sundays and Wednesdays, Carol at home doesn't count toward the
presence rules, so Deven or Grace has to be at the center whenever it's open those days. If neither can be, the scheduler brings Carol
in and reports that her preference wasn't met.

No employees are minors, so the app doesn't need labor rules for minors.

## Planned architecture

```
Browser (React app, static assets) ── /api/* ──┐
Parents' emails (Email Routing) ───────────────┤
Parents' texts (SMS provider webhook) ─────────┼──> Worker
Cron Triggers ─────────────────────────────────┘      │ starts
                                                      ▼
        Workflows: weekly run, nightly Radius sync, Sling sign-in, booking requests

The Worker and the Workflows both use:
   D1               settings, roster details, visits, drafts, Sling shift IDs, booking log
   Durable Objects  one per linked account: sign-in lock and current token
   Radius           appointments, ratio, sign-in/out history (read); appointments (write, booking only)
   Sling            roster, time off (read); shifts (write, unpublished)
   Claude API       reads parents' messages and writes replies (booking assistant)
```

- **Integrations**: `worker/radius.ts` and `worker/sling.ts` grow typed functions for the data
  the scheduler needs (appointments and whether each is online, ratio and visits; users, positions,
  locations, time off, shifts). Nothing else talks to Radius or Sling directly, so when either one changes, only these
  files change.
- **Scheduler**: a pure module (planned as `worker/scheduler/`) with no network or database
  access. It takes demand, employees, rules and locked shifts, and returns shifts and a report. That
  keeps it easy to test and lets it run in a request, a background job or locally.
- **Predictor**: also pure, next to the scheduler. It takes visit history, appointments and marked
  dates, and returns expected students per time block. Its output is the scheduler's demand input.
- **Jobs**: background work runs in Workflows as the director's linked Radius and Sling accounts,
  using the credentials already stored.
- **Storage (tentative)**: tables for center settings, locations and school programs, roster details
  (roles, levels, teaching limits, preferred programs, remote work, work-from-home days, hour
  preferences, availability), student visits, attendance
  overrides and marked dates, schedule runs, draft shifts, and the mapping from draft shifts to Sling
  shift IDs. Time off stays in Sling. Each schedule run saves a copy of the inputs it
  used, so a draft can be explained later even after Sling or Radius change.

### Cloudflare building blocks

Researched 2026-11-23 against developers.cloudflare.com. Recommendations, not final decisions:
record each one in `docs/ARCHITECTURE.md` once it's made.

| Work | Runs on | Why |
| --- | --- | --- |
| Web app and `/api/*` | Worker with Static Assets (as today) | Already in place. |
| Weekly run: read Radius and Sling, predict, generate, save the draft, notify | Workflow, started by a Cron Trigger | Each step is retried and its result saved, so a failure partway through resumes instead of starting over. A fixed instance ID per week (for example `weekly-2026-W48`) means a cron that fires twice can't run the week twice. |
| Nightly Radius sync (visit history, appointment changes) | Workflow, one step per page of results | Each step writes its rows to D1 and passes on only where to continue, which keeps step results small. |
| Sling sign-in (captcha wait of up to 2 minutes) | Workflow step | Steps have no wall-clock limit. The captcha solve and the login go in the same step, because a solved captcha expires quickly. Linking Sling from the UI starts the Workflow and the page polls for the result. Built 2026-11-23. |
| One sign-in at a time per linked account | Durable Object per account, holding the lock | Two jobs that find an expired token at the same time share one sign-in instead of solving two captchas. It also records the running sign-in, in case the object is restarted mid-sign-in. Built 2026-11-23; the token stays in D1. |
| Schedule generation | Pure TypeScript in a Workflow step, with a raised CPU limit | A step can use up to 5 minutes of CPU. |
| Notifications to the director | Email through Cloudflare Email Service (`send_email` binding) | Still in beta and needs a sending domain. The fallback is a transactional email API (Resend, Postmark) called with `fetch`. |
| Parent emails (booking assistant) | Cloudflare Email Routing, which passes each message to the Worker's `email` handler. The Worker starts a booking Workflow. | Email intake without a server. Needs a domain whose email runs through Cloudflare. The center's current address can forward booking emails to it. |
| Parent texts (booking assistant) | An SMS provider (for example Twilio) calling a Worker webhook | Cloudflare doesn't send or receive texts itself. |
| Director approval of a booking | The booking Workflow pauses until the app sends it the director's decision | No polling, and nothing runs while it waits. |
| Reading parents' messages and writing replies | Claude API (Claude Opus 5.5) through the official TypeScript SDK, called from a Workflow step | Each model call is a retried step, so a temporary API error doesn't lose the message. |
| Queues | Not used | Workflows cover the background work and save each step's result; Queues would add nothing. |

**Limits that shape the design** (Workers Paid plan):

| Limit | Value |
| --- | --- |
| CPU per request | 30 s by default, up to 5 min (`limits.cpu_ms`) |
| Workflow step | 30 s to 5 min of CPU, no wall-clock limit, result up to 1 MiB, retried 5 times by default |
| Memory | 128 MB per isolate, including WebAssembly |
| Cron Triggers | UTC only |
| Work after a response (`waitUntil`) | 30 s |
| Outgoing requests | 10,000 per invocation |
| D1 | 10 GB per database; 100 bound parameters per query; 1,000 queries per invocation (a `batch()` counts as one) |

**Practices:**

- **Plan**: Workers Paid ($5/month) is needed from phase 3. The Free plan already includes Durable
  Objects and Workflows, so phases 1 and 2 can run on it. Its limits are 10 ms of CPU per request or
  Workflow step (waiting on the network doesn't count) and 50 outgoing requests per invocation. Big
  reads, like the first import of visit history, are split into Workflow steps so each step stays
  within those limits. The scheduler needs more CPU than that. One center should stay within Paid's
  included usage.
  Other costs: CapMonster for each Sling sign-in, and a domain for sending email.
- **Time zone**: Cron Triggers run on UTC, but the center runs on Pacific time with daylight saving.
  Fire hourly, check the local hour in code, and rely on the weekly instance ID to prevent duplicate
  runs.
- **Types**: done, see `docs/ARCHITECTURE.md`. Still to do: run `bun run typecheck` in CI.
- **Environments**: staging is set up in `wrangler.jsonc` (see `docs/ARCHITECTURE.md`), but its D1
  database isn't created yet: `wrangler d1 create mathnasium-scheduling-staging`, then put its ID in
  `wrangler.jsonc`.
- **Deploys**: Workers Builds (Cloudflare's CI, which has Bun) runs the tests, applies D1 migrations,
  then deploys.
- **Testing**: `bun test` for the pure scheduler and predictor. Add Cloudflare's Vitest integration
  only for code that needs D1, Workflows or Durable Objects to run.
- **D1**: schema and indexes in migrations. Use `batch()` for writes that must succeed or fail
  together (it runs as one transaction). Split bulk inserts, like the first import of visit history,
  to stay under 100 bound parameters per query.
- **Backups**: D1 Time Travel restores the database to any minute in the last 30 days. For longer,
  export to R2 on a schedule.
- **Secrets**: keep `wrangler secret put`. Cloudflare's Secrets Store is still in beta.

**To verify early:**

- ~~Whether a WebAssembly solver (for example HiGHS) runs in Workers and solves a real week within
  the limits.~~ Tested 2026-11-24 in local workerd (see `spikes/highs/README.md`): yes, about a
  second and 44 MB for a synthetic week. Still to check in a deployed Worker, where the CPU and
  memory limits apply.
- Email Service onboarding: the daily quota for new accounts, and what the sending domain needs.
- Whether the pinned Wrangler version can schedule Workflows directly (a newer feature), or whether a
  Cron Trigger has to start them.

### Radius endpoints found so far

Radius has no public API. These were first found in Radius' own public scripts and in public GitHub
projects that automate Radius (PhiPrime/mnco, labozo123321/mathnasium,
NeemaJ/MathnasiumCalendarExpander). The ones marked confirmed were called while signed in on
2026-11-23, with the requests captured from Radius' own pages.

**How Radius' data requests work:**

- Grids use Kendo UI. A grid's data request is a form POST with `sort`, `page`, `pageSize`, `group`
  and `filter`, plus the page's own filters, and returns `{ Data: [...], Total }`.
- Every POST needs the anti-forgery token in the body (`__RequestVerificationToken`, from a hidden
  input on any Radius page), along with the cookie of the same name. Without it Radius answers with a
  generic 500 error page. GETs don't need it.
- Requests name the center (`centerId`, this center is 3600), so there's no center to select first.
- Dates come back as `/Date(ms)/`, alongside ready-made strings such as `11/20/2026` and `12:15 PM`.
- Radius blocks clients that send many requests quickly: after about 30 requests in a few minutes,
  some pages answered with 403 for a while. Space requests out, and page through large ranges
  instead of firing them in parallel.

| Path | What it has | Use |
| --- | --- | --- |
| `POST /AppointmentManagement/GetAppointments` (confirmed) | Appointments for a date range (`startDate`, `endDate` as `yyyy-MM-dd`; filters `deliveryMethod` = `online` or `in_center`, `sessionTypes`, `gradeRanges`, `sessionStatuses`). Each has student ID, date, time, `SessionDuration` in minutes, `SessionType` (Standard, HighSchool, Great Foundations, Private, or the membership name), `SessionStatus` (Scheduled, Attended, Drop-In, Cancelled, Late cancelled, No show), `DeliveryMethod` ("In-Center" or "Online"), `Grade` ("Pre K", "K", "1"–"12", "College") and `PodLabel`. | Booked demand (feature 4), unbooked visits and no-shows (feature 5). |
| `GET /Scheduling/CalendarData?centerKey=3600\|False\|False&date=yyyy-MM-dd` (confirmed) | One day of the scheduling calendar. `CalendarItems`: each appointment's start and end time, `SessionType`, `DeliveryType` (`in_center`), status and pod. `Seats`: for each 15-minute slot, seats booked in-center and online and seats still free. Also the day's opening hours and the maximum physical and online seats. | Booked demand for one day. Radius' free seats for the booking assistant. |
| `/Membership/CenterSettings/{centerId}` (confirmed, a page) | The center's levels, embedded in the page as JSON (`radius.utilities.levels`): name, first and last grade (Pre K = 13, K = 14), `InCenterRatio`, `OnlineRatio` and `SessionTypeId`. | The ratio and the grade-to-level mapping (features 1 and 4). |
| `GET /CenterAvailability/GetDefaultCapacity?centerId=&isVirtual=false` (confirmed) | Radius' booking capacity: maximum physical and online seats, and groups of days and hours with a number of instructors per session type. | Comparing Radius' capacity with the schedule (feature 1). |
| `POST /StudentAttendanceReport/StudentAttendanceReport_Read` (confirmed) | The Student Attendance Report's visits: one row per visit with student ID, enrollment ID, date, arrival, departure, `DurationInMinutes`, `Delivery` ("In-Center" or "Hybrid") and `DeliveryText` ("In-Center" or "@home"), membership type, `SessionsPerMonth` and `SessionsRemaining`. Body: `start` and `end` as `MM/dd/yyyy 12:00:00 AM`, `centerId`, `schoolPartnership=2` (all), and empty `membershipTypeList`, `selectStudent`, `delivery` and `ctrIds`. No instructor. | Visit history (feature 5). |
| `POST /StudentAttendanceMonthlyReport/StudentAttendanceMonthlyReport_Read` | The same report's month-by-month summary per student. Same parameters, not called yet. | Not needed yet. |
| `GET /Attendance/StudentAttendances_Read?centerId=` (confirmed) | Every active student: check-in state, last visit, main enrollment (`PrimaryTypeName` such as Monthly Sessions, After School Program or Sessions Package) with `PrimaryCount` = sessions remaining, and any private package with `PrivateCount`. Enrollment type 1 has no count. | Sessions left this month, for the booking assistant and prediction. Maybe a live "who's here now" view. |
| `/Attendance/Roster` | A day's roster with check-in flags. Probably where staff fix arrival and departure times. | Not needed yet. |
| `/EmployeeAttendance/InstructorTimeSheet` | Instructor hours. | Not needed yet. Could later compare scheduled vs. actual hours. |
| `/Scheduling/PlanSchedule`, `/Scheduling/Schedule` (not called) | The calendar's booking requests: plan a booking, then make it. | Booking assistant (feature 11). Capture them when staff book an appointment. |

### Sling endpoints found so far

Sling's web app embeds its own API description (Swagger 2.0, 329 paths, mostly without response
types) in its JavaScript bundle. The endpoints below were called with GET only, with the linked
token, on 2026-11-24. All are under `https://api.getsling.com/v1`. Date ranges are
`dates=<ISO start>/<ISO end>` with offsets, for example
`2026-11-16T00:00:00-08:00/2026-12-14T00:00:00-08:00`.

**This center's account:** organization 210998, on the free plan. The linked account (Deven) is an
admin. The session's `orgSettings.orgFeatures` lists which features the plan has. On the free plan,
recurring shifts, copying shifts, shift templates and time off are on. Unavailability, leave types
and reports are off.

| Path | What it has | Use |
| --- | --- | --- |
| `GET /account/session` | The signed-in user, the organization (plan, `isPremium`) and `orgSettings`: features, time clock settings, break settings, shift templates, first day of the week (Monday). | Checking which features exist before relying on them. |
| `GET /users/concise` | `{ users, groups }`: every user, active or not, with name, email, `timezone`, `hoursCap` (0 for everyone here), `role` (`admin`, `manager`, `user`), `active`, `deactivatedAt` and `groupIds`. 36 users, 8 active. | Roster (feature 2). |
| `GET /groups` | Positions, locations and the "Everyone" group, with `type`, `archivedAt` and `memberCount`. Locations: Aptos (the center), Online, Rio Del Mar Elementary School, Valencia Elementary School, and an archived "Mathnasium of Santa Cruz". Active people's positions: Owner, Assistant Center Director, Aptos Instructor. Center Director, Instructor and Lead Instructor only have inactive members. | Mapping locations and positions (feature 1). |
| `GET /calendar/{orgId}/users/{userId}?dates=` | Everyone's shifts and approved time off in the range, not only that user's, when the user is an admin. Shifts (`type: "shift"`) have `dtstart`, `dtend`, `user`, `location`, `position`, `breakDuration`, `status` (`published`, also `planning`), `slots` and, for repeating shifts, `rrule` (`freq`, `byday`, `interval`, `from`, `until`) with an ID of the form `<rrule id>:<date>`. Time off (`type: "leave"`) has `fullDay`, `approved` and the user. Four weeks held 68 shifts and 4 time-off entries. | Existing shifts and time off (features 3, 6 and 8). Whether pending requests appear here is still to check. |
| `GET /calendar/summaries?dates=` | Counts for the range: all, published, unpublished, unassigned and available shifts, and paid minutes. | A quick check after publishing. |
| `GET /leave/types` | Vacation, unpaid vacation, sick and so on. Leave types are a Premium feature, so time off here has no type. | Not needed. |
| `GET /leave` | Only the signed-in user's own time off, ignoring `dates`. | Not useful; use the calendar. |
| `GET /availability?userId=` | Answers 402 "Feature available only in Sling Premium". | Would be availability (feature 3). |
| `GET /reports/leave?dates=` | Answers 402, Premium only. | Not available. |
| `POST /shifts`, `PUT /shifts/{id}`, `POST /shifts/bulk`, `POST /shifts/delete`, `POST /shifts/unpublish` (not called) | Writing shifts. The `Shift` body has `user`, `location`, `position`, `dtstart`, `dtend`, `breakDuration`, `summary`, `rrule` and `status`. | Publishing (feature 8). |

**What the current schedule shows** (2026-11-16 to 2026-12-13): the center (Aptos) is staffed
Monday to Thursday from about 12–1 PM to 6 PM, and Sunday 12–4 PM. School programs: Valencia on
Mondays 2:15–3:45 PM and Fridays 12:15–1:45 PM, usually two people; Rio Del Mar on Tuesdays and
Thursdays 2:15–3:45 PM, two to four people. Program shifts use the program's location with the
person's usual position. Carol's shifts are in Sling like everyone else's.

## Roadmap

Each phase is useful on its own. For example, after phase 3 the director can copy a generated draft
into Sling by hand. Most students book, so schedules built from booked appointments are useful
before predicted attendance exists. Prediction comes after publishing, and Radius' past sign-in
records let its accuracy be checked against past weeks right away.

| Phase | Scope | Status |
| --- | --- | --- |
| 0. Foundations | Login with Radius, link Sling, embedded views, Cloudflare + D1 setup | Done |
| 1. Read the data | Groundwork: generated types, staging environment, a Durable Object sign-in lock per account, Sling sign-in moved into a Workflow. Then read Radius appointments (with student levels, and whether each is online) and the ratio, and the Sling roster, locations, time off and existing shifts. Show booked demand per time block in the app. | In progress: groundwork built 2026-11-23 (staging still needs its D1 database). Reading the data is next. |
| 2. Setup | Center setup (hours, presence rules, school programs, the Remote location). Roster details: roles, levels, teaching limits, preferred programs, remote work, work-from-home days, hour preferences. Availability for each employee, suggested from past Sling shifts. | Planned |
| 3. Generate drafts | Switch to Workers Paid for the scheduler's CPU time. Scheduler v1 (heuristic) with the coverage report. No publishing yet. | Planned |
| 4. Review and edit | Calendar view of the draft, manual edits, locking, regenerate around locks. | Planned |
| 5. Publish | Create, update and remove the app's shifts in Sling. | Planned |
| 6. Predict attendance | Read students' sign-in/out history, learn unbooked students' patterns, show booked vs. predicted demand, director overrides, accuracy checks against past weeks. | Planned |
| 7. Automation | Weekly run and nightly sync as Workflows on Cron Triggers, change detection, email to the director. | Planned |
| 8. History | Stored history, reports, longer-term prediction patterns, better solver if needed. | Planned |
| 9. Booking assistant (stretch) | Email first, with the director approving every booking and reply. Then automatic handling of simple requests from known parents. Then texts. | Planned |

## Risks

- **Unofficial integrations**: neither Radius nor Sling offers a public API for this. The app uses the
  same web endpoints their own sites use, which can change without notice. Keep that code isolated,
  check responses, and fail loudly instead of publishing a schedule built on bad data.
- **Terms of service**: check that Radius' and Sling's terms allow automated access like this.
- **Sling sign-in cost**: every Sling sign-in costs a CapMonster captcha solve and up to a minute.
  Reuse the token and sign in again only when it expires.
- **Workers limits**: the scheduler has to fit in one Workflow step (up to 5 minutes of CPU, 128 MB).
  Test early with a realistic week (all employees, all appointments).
- **Stored credentials**: Radius and Sling passwords are stored encrypted under one key. Anyone with
  that key and the database can read them.
- **Late changes**: appointments booked or cancelled after publishing make the schedule wrong. Change
  detection (feature 9) is the answer, so it shouldn't slip too far.
- **Prediction errors**: predicted attendance will sometimes be wrong. Show booked and predicted
  demand separately, check accuracy every week, and let the director choose how much margin to staff
  for.
- **Student data**: visit history is about students, most of them minors. Store only what prediction
  needs, and delete old records once they stop being useful.
- **Rest breaks**: if the center is in California, employers must give a paid 10-minute rest break
  for every 4 hours worked (or major part of 4 hours). For each day a break is missed, the employee
  is owed an extra hour of pay. The center's breaks are paid, and a break with only two people on is
  fine, so a break is missed only when the ratio can't spare the person; the scheduler reports
  those.
- **Writing to Radius**: booking is the app's only write to Radius, and a bad booking affects a real
  family. Keep the director approving bookings until the bot has a track record.
- **Booking assistant mistakes**: the model can misread a message. Code checks every request
  against Radius, anything unclear goes to the director, and every decision is logged.
- **Texting**: in the US, sending business texts from an app needs the number registered with the
  carriers (A2P 10DLC) through the SMS provider. That takes time and costs a fee.

## Open questions

Answered questions are kept, struck through, with their answers.

1. ~~Where in Radius is the student-to-instructor ratio set, and does it vary by level or appointment
   type?~~ Answered 2026-11-23: in Center Settings, per level, with separate in-center and online
   ratios (feature 1).
2. ~~Does Sling store weekly hour limits or preferences for employees, or does the director enter them
   in the app?~~ Answered 2026-11-24: users have an `hoursCap`, but it's 0 (unset) for everyone, and
   preferences aren't in Sling. The director enters them in the app.
3. ~~How long are appointments, and what time block size should the scheduler use?~~ Answered
   2026-11-24: usually 60 minutes for elementary and middle school and 90 for high school, and usually
   the same length each time for a given student. They start on any 15 minutes, so the scheduler
   plans in 15-minute blocks (proposed, not yet built).
4. ~~One center, or several?~~ Answered 2026-11-24: one center.
5. ~~How far ahead is the schedule made, and when do employees need to see it?~~ Answered 2026-11-24:
   employees should have it 3 days ahead (feature 1).
6. ~~Visit history: what request does the Student Attendance Report make for its data, and how far
   back does this center's history go? Does a visit record the instructor? Can a walk-in be told
   apart from a booked visit other than by matching visits to appointments?~~ Answered 2026-11-23:
   see "Radius endpoints found so far". History starts 2023-01-03. Visits don't record the
   instructor. Walk-ins seem to appear as "Drop-In" appointments; confirm with the director.
7. ~~Should the app publish shifts straight to employees, or leave them unpublished in Sling for a
   final check there?~~ Answered 2026-11-24: leave them unpublished for now (feature 8).
8. How should the app notify the director: email (needs a domain to send from), or something else?
9. ~~Besides instructors, which roles need scheduling?~~ Answered 2026-11-24: any employee can be
   scheduled.
10. Is a heuristic scheduler good enough, or is an optimization solver needed, and does one fit in
    Workers? Partly answered 2026-11-24: HiGHS runs in Workers and solves a synthetic week in about a
    second (feature 6, `spikes/highs/`). Still open: a deployed run, and choosing it. The week is small: about 8 employees, 6 open days of roughly 28 15-minute blocks, and
    3 places to work. The hard part is how the rules interact (a supervisor and two people on site,
    levels, Carol's teaching limit, minimum shift lengths, locked shifts, preferred hours). A greedy
    heuristic fills one block at a time and can paint itself into a corner; it needs repair passes
    and can't tell "impossible" from "missed". An integer program states each rule once and returns
    the best schedule, or proof that a rule can't be met, which the coverage report can explain. At
    this size it should solve in seconds. The candidate is HiGHS compiled to WebAssembly (npm
    `highs`, about 4.5 MB unpacked, within Workers' size limit), but it loads its WebAssembly in a way
    Workers may not allow, so it needs a quick test. Google's CP-SAT has no WebAssembly build, so it
    would need a server or a Cloudflare Container.
11. ~~How cautious should staffing be for predicted students?~~ Answered 2026-11-24: the expected
    number, no margin.
12. ~~How much teaching does Carol want?~~ Answered 2026-11-24: ideally not much, 50% of her time on
    site at most.
13. ~~Does Carol's time go into Sling like everyone else's, or does the app only plan around it?~~
    Answered 2026-11-24: her shifts are in Sling, under the Owner position.
14. ~~Is grade the right measure of a student's level, or the level of math they're working on? Can
    Keiko teach middle school?~~ Answered 2026-11-24: use grade for now. Keiko can teach middle
    school. Still open: does test prep need its own level?
15. For the Valencia and Rio del Mar programs: which days and times, how many instructors, are they in
    Radius or Sling already, and how long is the drive from the center? Answered 2026-11-24 except the
    drive: both are Sling locations (days and times in "Sling endpoints found so far"), they're not in
    Radius, and Valencia needs 2 instructors, Rio del Mar 3. Still open: the drive time from the
    center to each.
16. ~~Are breaks paid or unpaid, and should the scheduler aim for a third person whenever someone is
    due a break?~~ Answered 2026-11-24: paid. No third person: two people on, one of them on a
    break, is fine.
17. Booking assistant: which email address and phone number do parents use today, and who controls
    them? That decides how the bot receives messages and where replies come from.
18. ~~Do bookings made in myMathnasium show up in Radius' calendar right away? Can the center limit
    which times parents can pick there?~~ Answered by the myMathnasium guide: myMathnasium books
    straight into Radius' integrated scheduler, so yes. Parents can only pick times that have
    capacity, at the allowed start times. Steering them earlier would mean giving later times less
    capacity.
19. ~~Besides sessions left this month, does anything else limit booking?~~ Answered by the guide:
    daily and weekly booking limits (center-wide, overridable per enrollment), a monthly limit for
    monthly memberships, and each enrollment's session length (feature 11).
20. ~~If the earliest time in a parent's window would need an extra instructor but a later time has
    room, should the bot offer the later time, or ask the director first?~~ Answered 2026-11-24: offer
    the later time.
21. ~~How does Radius mark an online appointment: a field on the appointment, a separate resource,
    or something else? Is the ratio the same for online students?~~ Answered 2026-11-23: a delivery
    method field on the appointment. Online students have their own, lower ratio.
22. ~~Can an instructor at the center teach online students alongside in-center ones?~~ Answered
    2026-11-24: yes. Still open: how a mixed group is counted against the ratio. Proposed: each
    student uses up their own ratio's share (an in-center elementary student 1/4 of an instructor, an
    online one 1/3), and the total can't pass one instructor.
23. ~~Besides Carol, who can work from home? Does the center use Sling's time clock with
    geofencing?~~ Answered 2026-11-24: anyone can. The time clock is off. Still open: should remote
    shifts use Sling's existing "Online" location?
24. ~~On Carol's days at home, should the scheduler give her online students to teach, or keep those
    days for admin work? Is the center open on Sundays?~~ Answered 2026-11-24: keep them for admin
    work. The center is open on Sundays.
25. ~~Where does availability come from, since this center's Sling plan doesn't have it?~~ Answered
    2026-11-24: it's built into the app (feature 3).
26. What happens to the hand-made repeating shifts already in Sling? The app can treat them as fixed
    and schedule around them, or the director can let them end and have the app take over those
    times.
27. Should the app keep Radius' booking capacity in line with each week's schedule? Radius lets a
    single week's capacity be edited without changing the default, so the app could set each week's
    instructors per time from the published schedule. Parents would then only see times that are
    really staffed. It would be a second kind of write to Radius, after booking.
28. ~~Is this center set up as a Scheduling Center (the myMathnasium integrated scheduler), and are
    any pods or groups used in Default capacity?~~ Answered 2026-11-24: it uses myMathnasium's
    scheduler, and it doesn't use pods, so capacity is just the default capacity rows.
