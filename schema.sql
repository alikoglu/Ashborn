-- Ashborn Studios Content Lab — PostgreSQL schema
-- Idempotent: safe to run on every server boot.

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  username       TEXT UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL,
  role           TEXT DEFAULT 'viewer',        -- admin, editor, viewer
  daily_ai_limit INTEGER DEFAULT 20,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT DEFAULT '',
  icon        TEXT DEFAULT '📁',
  owner_id    TEXT NOT NULL,
  is_master   INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id  TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  permission    TEXT DEFAULT 'view',           -- view, edit, delete
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS video_workspaces (
  video_id      TEXT NOT NULL,
  workspace_id  TEXT NOT NULL,
  added_by      TEXT NOT NULL,
  added_at      TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (video_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS ai_usage (
  user_id  TEXT NOT NULL,
  date     TEXT NOT NULL,                       -- YYYY-MM-DD
  count    INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, date)
);

CREATE TABLE IF NOT EXISTS videos (
  video_id                   TEXT PRIMARY KEY,
  video_link                 TEXT DEFAULT '',
  video_title                TEXT DEFAULT '',
  channel_name               TEXT DEFAULT '',
  channel_id                 TEXT DEFAULT '',
  published_at               TEXT DEFAULT '',
  thumbnail_url              TEXT DEFAULT '',
  views_total                TEXT DEFAULT '0',
  likes                      TEXT DEFAULT '0',
  comments                   TEXT DEFAULT '0',
  channel_size               TEXT DEFAULT '0',
  channel_avg_views          DOUBLE PRECISION DEFAULT 0,
  title_length               INTEGER DEFAULT 0,
  has_number                 INTEGER DEFAULT 0,
  has_question               INTEGER DEFAULT 0,
  has_timeframe              INTEGER DEFAULT 0,
  has_difficulty             INTEGER DEFAULT 0,
  has_money                  INTEGER DEFAULT 0,
  starts_with_i              INTEGER DEFAULT 0,
  all_caps_words             INTEGER DEFAULT 0,
  is_series                  INTEGER DEFAULT 0,
  is_collab                  INTEGER DEFAULT 0,
  clickbait_score            INTEGER DEFAULT 0,
  format                     TEXT DEFAULT 'other',
  formula                    TEXT DEFAULT '',
  number_of_tags             INTEGER DEFAULT 0,
  tags                       TEXT DEFAULT '[]',
  video_length               TEXT DEFAULT '',
  video_length_secs          INTEGER DEFAULT 0,
  face_emotion               TEXT DEFAULT '',
  character_present          TEXT DEFAULT '',
  minecraft_skin_visible     TEXT DEFAULT '',
  arrows_circles             TEXT DEFAULT '',
  text_present               TEXT DEFAULT '',
  dominant_color             TEXT DEFAULT '',
  clarity_score              TEXT DEFAULT '',
  thumbnail_style            TEXT DEFAULT '',
  thumbnail_background       TEXT DEFAULT '',
  thumbnail_contrast         TEXT DEFAULT '',
  thumbnail_has_before_after TEXT DEFAULT '',
  thumbnail_num_faces        TEXT DEFAULT '',
  thumbnail_has_item         TEXT DEFAULT '',
  composition_notes          TEXT DEFAULT '',
  thumbnail_text             TEXT DEFAULT '',
  views_per_sub              TEXT DEFAULT '',
  log_views                  TEXT DEFAULT '',
  like_rate                  TEXT DEFAULT '',
  comment_rate               TEXT DEFAULT '',
  engagement                 TEXT DEFAULT '',
  packaging                  DOUBLE PRECISION DEFAULT 0,
  perf_label                 TEXT DEFAULT '',
  perf_score                 DOUBLE PRECISION DEFAULT 0,
  days_since_published       TEXT DEFAULT '',
  views_per_day              TEXT DEFAULT '',
  like_to_comment_ratio      TEXT DEFAULT '',
  relative_perf_index        TEXT DEFAULT '',
  intro_hook_type            TEXT DEFAULT '',
  intro_result_shown         TEXT DEFAULT '',
  intro_goal_stated          TEXT DEFAULT '',
  intro_opening_line         TEXT DEFAULT '',
  intro_tension              TEXT DEFAULT '',
  intro_pacing               TEXT DEFAULT '',
  intro_voice_style          TEXT DEFAULT '',
  intro_face_on_camera       TEXT DEFAULT '',
  intro_music                TEXT DEFAULT '',
  intro_thumbnail_callback   TEXT DEFAULT '',
  intro_score                INTEGER DEFAULT 0,
  intro_transcript           TEXT DEFAULT '',
  created_at                 TIMESTAMPTZ DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS channel_monitor (
  channel_id    TEXT PRIMARY KEY,
  channel_name  TEXT NOT NULL,
  channel_url   TEXT DEFAULT '',
  added_by      TEXT NOT NULL,
  last_checked  TIMESTAMPTZ,
  last_video_id TEXT DEFAULT '',
  active        INTEGER DEFAULT 1,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS video_velocity (
  video_id      TEXT NOT NULL,
  snapshot_type TEXT NOT NULL,   -- '24h' | '48h' | '7d' | '30d'
  views         BIGINT DEFAULT 0,
  likes         BIGINT DEFAULT 0,
  comments      BIGINT DEFAULT 0,
  captured_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (video_id, snapshot_type)
);

CREATE TABLE IF NOT EXISTS video_annotations (
  id            SERIAL PRIMARY KEY,
  video_id      TEXT NOT NULL,
  timestamp_sec INTEGER NOT NULL,          -- seconds into video
  marker_type   TEXT NOT NULL,             -- see MARKER_TYPES below
  note          TEXT DEFAULT '',
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
-- marker_type values: scene_cut | pattern_interrupt | thumbnail_callback |
--   eye_focus | emotional_peak | pacing_dip | escalation | cta | hook_end | other

CREATE TABLE IF NOT EXISTS video_review (
  video_id              TEXT PRIMARY KEY,
  content_skeleton      TEXT DEFAULT '',
  thumbnail_promise     TEXT DEFAULT '',
  ending_style          TEXT DEFAULT '',
  creator_presence      TEXT DEFAULT '',
  rewatchability        TEXT DEFAULT '',
  info_density          TEXT DEFAULT '',
  benchmark_tier        TEXT DEFAULT '',
  general_notes         TEXT DEFAULT '',
  updated_by            TEXT NOT NULL DEFAULT '',
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS video_draws (
  id            SERIAL PRIMARY KEY,
  video_id      TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  start_sec     REAL NOT NULL,
  end_sec       REAL NOT NULL,
  color         TEXT DEFAULT '#f5a623',
  width         INTEGER DEFAULT 3,
  path_data     TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS video_captions (
  id            SERIAL PRIMARY KEY,
  video_id      TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  start_sec     REAL NOT NULL,
  end_sec       REAL NOT NULL,
  caption_text  TEXT NOT NULL,
  color         TEXT DEFAULT '#ffffff',
  font_size     INTEGER DEFAULT 16,
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_wm_user          ON workspace_members(user_id);
CREATE INDEX IF NOT EXISTS idx_vw_workspace     ON video_workspaces(workspace_id);
CREATE INDEX IF NOT EXISTS idx_vw_video         ON video_workspaces(video_id);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user    ON ai_usage(user_id, date);
CREATE INDEX IF NOT EXISTS idx_videos_created   ON videos(created_at);
CREATE INDEX IF NOT EXISTS idx_annotations_vid  ON video_annotations(video_id);
CREATE INDEX IF NOT EXISTS idx_annotations_ts   ON video_annotations(video_id, timestamp_sec);
CREATE INDEX IF NOT EXISTS idx_draws_vid        ON video_draws(video_id, start_sec);
CREATE INDEX IF NOT EXISTS idx_captions_vid     ON video_captions(video_id, start_sec);

-- Migrations: safely add user_id if tables existed before this column was introduced
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='video_draws' AND column_name='user_id') THEN
    ALTER TABLE video_draws ADD COLUMN user_id TEXT NOT NULL DEFAULT '';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='video_captions' AND column_name='user_id') THEN
    ALTER TABLE video_captions ADD COLUMN user_id TEXT NOT NULL DEFAULT '';
  END IF;
  -- Drop pos_x / pos_y if they exist (removed from design)
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='video_captions' AND column_name='pos_x') THEN
    ALTER TABLE video_captions DROP COLUMN pos_x;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='video_captions' AND column_name='pos_y') THEN
    ALTER TABLE video_captions DROP COLUMN pos_y;
  END IF;
END $$;
