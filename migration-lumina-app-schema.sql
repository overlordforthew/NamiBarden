CREATE SCHEMA IF NOT EXISTS lumina;

CREATE TABLE IF NOT EXISTS lumina.users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  lang VARCHAR(10) DEFAULT 'en',
  start_date DATE DEFAULT CURRENT_DATE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lumina.progress (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES lumina.users(id) ON DELETE CASCADE,
  day_num INTEGER NOT NULL,
  completed_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, day_num)
);

CREATE TABLE IF NOT EXISTS lumina.audio (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES lumina.users(id) ON DELETE CASCADE,
  day_num INTEGER NOT NULL,
  audio_data TEXT NOT NULL,
  UNIQUE(user_id, day_num)
);

CREATE TABLE IF NOT EXISTS lumina.images (
  id SERIAL PRIMARY KEY,
  day_num INTEGER UNIQUE NOT NULL,
  image_data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lumina.checkins (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES lumina.users(id) ON DELETE CASCADE,
  day_num INTEGER NOT NULL,
  state VARCHAR(50) NOT NULL DEFAULT 'ground',
  energy INTEGER DEFAULT 3,
  intention VARCHAR(180),
  note TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, day_num)
);

CREATE TABLE IF NOT EXISTS lumina.reflections (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES lumina.users(id) ON DELETE CASCADE,
  day_num INTEGER NOT NULL,
  body TEXT DEFAULT '',
  favorite BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, day_num)
);

CREATE TABLE IF NOT EXISTS lumina.analytics_events (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES lumina.users(id) ON DELETE SET NULL,
  email VARCHAR(255),
  session_id VARCHAR(80) NOT NULL,
  event_name VARCHAR(80) NOT NULL,
  event_source VARCHAR(40) DEFAULT 'app',
  page_path VARCHAR(255),
  ip VARCHAR(80),
  user_agent TEXT,
  properties JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lumina_progress_user_day ON lumina.progress(user_id, day_num);
CREATE INDEX IF NOT EXISTS idx_lumina_checkins_user_day ON lumina.checkins(user_id, day_num);
CREATE INDEX IF NOT EXISTS idx_lumina_reflections_user_day ON lumina.reflections(user_id, day_num);
CREATE INDEX IF NOT EXISTS idx_lumina_analytics_event_created ON lumina.analytics_events(event_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lumina_analytics_email_created ON lumina.analytics_events(email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lumina_analytics_user_created ON lumina.analytics_events(user_id, created_at DESC);
