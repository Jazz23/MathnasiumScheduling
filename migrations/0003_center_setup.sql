-- Center setup and the employee roster (phase 2): what the director records
-- that neither Radius nor Sling holds. One center, so settings are one row.
-- Times of day are 'HH:MM' (24-hour, the center's local time). Weekdays are
-- 0 = Sunday … 6 = Saturday.

CREATE TABLE center_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  radius_center_id INTEGER NOT NULL DEFAULT 3600,
  timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  -- Presence rules: people at the center whenever it's open (on a break counts,
  -- remote doesn't), and how many of them must be supervisors.
  min_staff_on_site INTEGER NOT NULL DEFAULT 2,
  min_supervisors_on_site INTEGER NOT NULL DEFAULT 1,
  -- Shift rules.
  min_shift_minutes INTEGER NOT NULL DEFAULT 120,
  max_shift_minutes INTEGER NOT NULL DEFAULT 480,
  max_shifts_per_day INTEGER NOT NULL DEFAULT 1,
  setup_minutes INTEGER NOT NULL DEFAULT 0,   -- before the first appointment
  cleanup_minutes INTEGER NOT NULL DEFAULT 0, -- after the last one
  -- Break rule: a paid break of break_minutes for shifts of break_after_minutes or more.
  break_after_minutes INTEGER NOT NULL DEFAULT 240,
  break_minutes INTEGER NOT NULL DEFAULT 10,
  -- Travel allowance between home and the center on the same day.
  home_travel_minutes INTEGER NOT NULL DEFAULT 0,
  -- Cadence: employees get the schedule this many days ahead; the draft is
  -- generated on generate_weekday.
  publish_lead_days INTEGER NOT NULL DEFAULT 3,
  generate_weekday INTEGER NOT NULL DEFAULT 3 CHECK (generate_weekday BETWEEN 0 AND 6),
  -- Sling locations for center and remote shifts (Sling group IDs).
  sling_center_location_id INTEGER,
  sling_remote_location_id INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT INTO center_settings (id) VALUES (1);

-- Opening hours. A weekday with no row is closed. Several rows per day are
-- allowed (for example a midday closure).
CREATE TABLE operating_hours (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  open_time TEXT NOT NULL,
  close_time TEXT NOT NULL,
  CHECK (open_time < close_time)
);

-- Off-site school programs (Valencia, Rio del Mar). Not in Radius.
CREATE TABLE school_programs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sling_location_id INTEGER,
  instructors_needed INTEGER NOT NULL DEFAULT 1,
  travel_minutes INTEGER NOT NULL DEFAULT 0, -- each way, from the center
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE program_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id INTEGER NOT NULL REFERENCES school_programs(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  CHECK (start_time < end_time)
);
CREATE INDEX program_sessions_program ON program_sessions(program_id);

-- The roster: one row per Sling user, imported from Sling, plus the details
-- the director records. Sling stays the source for name, email and active.
CREATE TABLE employees (
  sling_user_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  active INTEGER NOT NULL DEFAULT 1,       -- active in Sling
  sling_position_ids TEXT NOT NULL DEFAULT '[]', -- JSON array
  role TEXT NOT NULL DEFAULT 'instructor'
    CHECK (role IN ('owner', 'assistant_director', 'instructor', 'front_desk')),
  -- Highest grade they can teach: -1 = Pre K, 0 = K, 1–12. NULL = not set.
  max_grade INTEGER CHECK (max_grade BETWEEN -1 AND 12),
  test_prep INTEGER NOT NULL DEFAULT 0,
  assessments INTEGER NOT NULL DEFAULT 0,
  -- Largest share of their time on site that should be teaching, 0–100. NULL = no limit.
  teaching_limit_pct INTEGER CHECK (teaching_limit_pct BETWEEN 0 AND 100),
  can_work_remote INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,      -- higher wins ties
  min_hours REAL,
  preferred_hours REAL,
  max_hours REAL,
  min_shift_minutes INTEGER,                -- their own preference, on top of the center's rule
  wfh_weekdays TEXT NOT NULL DEFAULT '[]',  -- JSON array of weekdays they'd rather work from home
  schedulable INTEGER NOT NULL DEFAULT 1,   -- the director can leave someone out
  notes TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- School programs an employee should be first choice for.
CREATE TABLE employee_programs (
  sling_user_id INTEGER NOT NULL REFERENCES employees(sling_user_id) ON DELETE CASCADE,
  program_id INTEGER NOT NULL REFERENCES school_programs(id) ON DELETE CASCADE,
  PRIMARY KEY (sling_user_id, program_id)
);

-- Weekly availability, entered in the app (Sling's is Premium only). Rows
-- with the same effective_from form one weekly pattern; the pattern in force
-- on a date is the one with the latest effective_from on or before it.
CREATE TABLE availability (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sling_user_id INTEGER NOT NULL REFERENCES employees(sling_user_id) ON DELETE CASCADE,
  effective_from TEXT NOT NULL, -- 'YYYY-MM-DD'
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  CHECK (start_time < end_time)
);
CREATE INDEX availability_user ON availability(sling_user_id, effective_from);

-- Days or times an employee would like to work or avoid. Wishes, not limits.
CREATE TABLE employee_preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sling_user_id INTEGER NOT NULL REFERENCES employees(sling_user_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('prefer', 'avoid')),
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  CHECK (start_time < end_time)
);
CREATE INDEX employee_preferences_user ON employee_preferences(sling_user_id);
