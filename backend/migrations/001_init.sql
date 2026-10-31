-- IO Digital Broadcast - initial PostgreSQL schema
-- Uses only PostgreSQL-native syntax: TEXT + CHECK constraints instead of ENUM, JSONB, timestamptz, UUID keys.

BEGIN;

-- ---------- Security ----------
CREATE TABLE roles (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE CHECK (name IN ('ADMIN', 'OPERATOR', 'VIEWER')),
  permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  description TEXT
);

CREATE TABLE permissions (
  id          SERIAL PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  description TEXT
);

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL,
  display_name  TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role_id       INTEGER NOT NULL REFERENCES roles(id),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));

CREATE TABLE refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);

CREATE TABLE api_keys (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at   TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ
);

CREATE TABLE audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  resource    TEXT NOT NULL,
  resource_id TEXT,
  ip          TEXT,
  status_code INTEGER,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);

-- ---------- Channels ----------
CREATE TABLE channels (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name              TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description       TEXT NOT NULL DEFAULT '',
  category          TEXT NOT NULL DEFAULT 'General',
  language          TEXT NOT NULL DEFAULT 'en',
  timezone          TEXT NOT NULL DEFAULT 'UTC',
  status            TEXT NOT NULL DEFAULT 'INACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'ARCHIVED')),
  epg_channel_id    TEXT,                       -- XMLTV channel id (tvg-id); never the display name
  logo_url          TEXT,
  encoding_profile  JSONB NOT NULL DEFAULT '{}'::jsonb,
  recording_config  JSONB NOT NULL DEFAULT '{"enabled": false, "retentionDays": 14}'::jsonb,
  created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX channels_category_idx ON channels (category);
CREATE INDEX channels_epg_idx ON channels (epg_channel_id);

CREATE TABLE channel_branding (
  channel_id      UUID PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  primary_color   TEXT NOT NULL DEFAULT '#FFFFFF',
  secondary_color TEXT NOT NULL DEFAULT '#1A1A1A',
  font_family     TEXT NOT NULL DEFAULT 'Inter',
  logo_position   TEXT NOT NULL DEFAULT 'TOP_RIGHT' CHECK (logo_position IN ('TOP_LEFT','TOP_RIGHT','BOTTOM_LEFT','BOTTOM_RIGHT')),
  extra           JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE channel_logos (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  width      INTEGER,
  height     INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE channel_streams (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id  UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('PRIMARY', 'BACKUP')),
  source_type TEXT NOT NULL CHECK (source_type IN ('URL', 'LAVFI_TEST', 'FILE')),
  source_url  TEXT NOT NULL,                  -- validated (http/https/rtmp/srt/rtsp or lavfi/file spec)
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel_id, role)
);

-- ---------- Playlists ----------
CREATE TABLE playlists (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 TEXT NOT NULL,
  source_type          TEXT NOT NULL CHECK (source_type IN ('FILE', 'URL')),
  source_url           TEXT,
  source_content       TEXT,                  -- uploaded FILE playlists keep their text so they can be refreshed/re-parsed
  auto_refresh_minutes INTEGER NOT NULL DEFAULT 0 CHECK (auto_refresh_minutes >= 0),
  channel_count        INTEGER NOT NULL DEFAULT 0,
  duplicate_count      INTEGER NOT NULL DEFAULT 0,
  last_refreshed_at    TIMESTAMPTZ,
  last_error           TEXT,
  created_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE playlist_channels (
  id           BIGSERIAL PRIMARY KEY,
  playlist_id  UUID NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  title        TEXT NOT NULL,
  tvg_id       TEXT,
  tvg_name     TEXT,
  tvg_logo     TEXT,
  group_title  TEXT,
  ext_group    TEXT,
  stream_url   TEXT NOT NULL,                  -- stored for server-side use only; never returned verbatim to viewers
  stream_hash  TEXT NOT NULL,
  url_valid    BOOLEAN NOT NULL DEFAULT TRUE,
  is_duplicate BOOLEAN NOT NULL DEFAULT FALSE,
  attributes   JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (playlist_id, stream_hash, position)
);
CREATE INDEX playlist_channels_playlist_idx ON playlist_channels (playlist_id, position);
CREATE INDEX playlist_channels_group_idx ON playlist_channels (group_title);
CREATE INDEX playlist_channels_tvg_idx ON playlist_channels (tvg_id);
CREATE INDEX playlist_channels_title_idx ON playlist_channels (lower(title));

-- ---------- EPG ----------
CREATE TABLE epg_sources (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  url              TEXT,
  channel_count    INTEGER NOT NULL DEFAULT 0,
  program_count    INTEGER NOT NULL DEFAULT 0,
  last_imported_at TIMESTAMPTZ,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE epg_programs (
  id            BIGSERIAL PRIMARY KEY,
  source_id     UUID NOT NULL REFERENCES epg_sources(id) ON DELETE CASCADE,
  epg_channel_id TEXT NOT NULL,
  start_at      TIMESTAMPTZ NOT NULL,
  stop_at       TIMESTAMPTZ NOT NULL CHECK (stop_at > start_at),
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL DEFAULT '',
  UNIQUE (source_id, epg_channel_id, start_at)
);
CREATE INDEX epg_programs_lookup_idx ON epg_programs (epg_channel_id, start_at);

-- ---------- Graphics ----------
CREATE TABLE graphics_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  template_path TEXT NOT NULL,                -- relative to CasparCG media folder
  fields      JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE graphics_layers (
  id          SERIAL PRIMARY KEY,
  channel_id  UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  layer       INTEGER NOT NULL CHECK (layer BETWEEN 1 AND 8),
  template_id UUID REFERENCES graphics_templates(id) ON DELETE SET NULL,
  state       TEXT NOT NULL DEFAULT 'EMPTY' CHECK (state IN ('EMPTY', 'LOADED', 'PLAYING')),
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel_id, layer)
);

CREATE TABLE graphics_events (
  id            BIGSERIAL PRIMARY KEY,
  channel_id    UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  layer         INTEGER NOT NULL CHECK (layer BETWEEN 1 AND 8),
  template_slug TEXT,
  action        TEXT NOT NULL CHECK (action IN ('LOAD', 'PLAY', 'UPDATE', 'STOP', 'CLEAR')),
  status        TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'VERIFIED', 'FAILED')),
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  error         TEXT,
  operator_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);
CREATE INDEX graphics_events_channel_idx ON graphics_events (channel_id, created_at DESC);

-- ---------- Streams / recordings ----------
CREATE TABLE streams (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id           UUID NOT NULL UNIQUE REFERENCES channels(id) ON DELETE CASCADE,
  state                TEXT NOT NULL DEFAULT 'STOPPED' CHECK (state IN ('STOPPED','STARTING','RUNNING','DEGRADED','FAILING_OVER','FAILED')),
  desired_state        TEXT NOT NULL DEFAULT 'STOPPED' CHECK (desired_state IN ('RUNNING', 'STOPPED')),  -- operator intent; restored after restart
  active_source_role   TEXT CHECK (active_source_role IN ('PRIMARY', 'BACKUP')),
  pid                  INTEGER,
  profile              JSONB NOT NULL DEFAULT '{}'::jsonb,
  restart_count        INTEGER NOT NULL DEFAULT 0,
  last_error           TEXT,
  started_at           TIMESTAMPTZ,
  last_state_change_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE recordings (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id       UUID REFERENCES channels(id) ON DELETE SET NULL,
  status           TEXT NOT NULL CHECK (status IN ('RECORDING', 'COMPLETED', 'FAILED', 'STOPPED')),
  file_path        TEXT NOT NULL,              -- internal only; API exposes the recording id
  file_size_bytes  BIGINT NOT NULL DEFAULT 0,
  duration_seconds NUMERIC(12,2),
  resolution       TEXT,
  codec            TEXT,
  pid              INTEGER,
  requested_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at         TIMESTAMPTZ,
  retention_until  TIMESTAMPTZ,
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX recordings_status_idx ON recordings (status, started_at DESC);

-- ---------- Scheduling ----------
CREATE TABLE schedules (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  channel_id   UUID REFERENCES channels(id) ON DELETE CASCADE,
  action       TEXT NOT NULL CHECK (action IN ('START_STREAM','STOP_STREAM','RESTART_STREAM','START_RECORDING','STOP_RECORDING','GRAPHICS_PLAY','GRAPHICS_STOP','SYSTEM_EVENT')),
  recurrence   TEXT NOT NULL CHECK (recurrence IN ('ONCE', 'DAILY', 'WEEKLY')),
  time_of_day  TEXT CHECK (time_of_day IS NULL OR time_of_day ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  days_of_week INTEGER[] NOT NULL DEFAULT '{}',   -- 0=Sunday .. 6=Saturday, used by WEEKLY
  run_at       TIMESTAMPTZ,                       -- used by ONCE
  timezone     TEXT NOT NULL DEFAULT 'UTC',
  params       JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  next_run_at  TIMESTAMPTZ,
  last_run_at  TIMESTAMPTZ,
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX schedules_due_idx ON schedules (next_run_at) WHERE enabled;

CREATE TABLE schedule_runs (
  id            BIGSERIAL PRIMARY KEY,
  schedule_id   UUID NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  scheduled_for TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  error         TEXT,
  UNIQUE (schedule_id, scheduled_for)           -- idempotency: one execution per occurrence
);

CREATE TABLE automation_rules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('STREAM_FAILED', 'DISK_LOW', 'EPG_STALE')),
  action      TEXT NOT NULL,
  params      JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Observability ----------
CREATE TABLE system_events (
  id         BIGSERIAL PRIMARY KEY,
  level      TEXT NOT NULL CHECK (level IN ('INFO', 'WARN', 'ERROR')),
  source     TEXT NOT NULL,
  type       TEXT NOT NULL,
  message    TEXT NOT NULL,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX system_events_created_idx ON system_events (created_at DESC);

CREATE TABLE analytics_events (
  id         BIGSERIAL PRIMARY KEY,
  type       TEXT NOT NULL,
  channel_id UUID REFERENCES channels(id) ON DELETE SET NULL,
  session_id TEXT,
  measured   BOOLEAN NOT NULL DEFAULT TRUE,   -- FALSE = estimated value
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE service_health (
  service    TEXT PRIMARY KEY,
  status     TEXT NOT NULL CHECK (status IN ('UP', 'DOWN', 'DEGRADED', 'UNKNOWN')),
  details    JSONB NOT NULL DEFAULT '{}'::jsonb,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- User preferences ----------
CREATE TABLE user_favorites (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, channel_id)
);

CREATE TABLE watch_history (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  watched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX watch_history_user_idx ON watch_history (user_id, watched_at DESC);

-- ---------- Seed data ----------
INSERT INTO roles (name, description, permissions) VALUES
  ('ADMIN', 'Full platform administration', '["*"]'),
  ('OPERATOR', 'Channel and broadcast controls, graphics, recordings, schedules', '["channels:read","channels:write","streams:control","graphics:control","recordings:control","schedules:write","playlists:write","epg:write","system:read"]'),
  ('VIEWER', 'Authorized channel viewing, EPG and read-only information', '["channels:read","epg:read","playlists:read","system:read"]');

INSERT INTO permissions (code, description) VALUES
  ('channels:read', 'View channels'),
  ('channels:write', 'Create, update and delete channels'),
  ('streams:control', 'Start, stop and restart streams'),
  ('graphics:control', 'Load, play, update and stop graphics'),
  ('recordings:control', 'Start and stop recordings'),
  ('schedules:write', 'Create, update and delete schedules'),
  ('playlists:write', 'Import and manage playlists'),
  ('epg:write', 'Import EPG sources'),
  ('epg:read', 'Read EPG'),
  ('playlists:read', 'Read playlists'),
  ('system:read', 'Read system health and metrics'),
  ('users:manage', 'Manage users');

-- Graphics package seed (templates are generated by graphics/build-templates.mjs)

COMMIT;
