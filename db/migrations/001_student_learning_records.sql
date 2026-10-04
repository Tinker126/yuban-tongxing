CREATE TABLE users (
  id UUID PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  grade SMALLINT NOT NULL CHECK (grade BETWEEN 3 AND 6),
  role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_username_format CHECK (username ~ '^[a-z0-9_]{3,32}$'),
  CONSTRAINT users_name_length CHECK (char_length(btrim(name)) BETWEEN 1 AND 80)
);

CREATE TABLE auth_sessions (
  id UUID PRIMARY KEY,
  token_hash CHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT auth_sessions_expiry CHECK (expires_at > created_at)
);
CREATE INDEX auth_sessions_user_expiry_idx ON auth_sessions (user_id, expires_at);

CREATE TABLE practice_sessions (
  id UUID PRIMARY KEY,
  student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic TEXT NOT NULL CHECK (char_length(btrim(topic)) BETWEEN 1 AND 100),
  grade SMALLINT NOT NULL CHECK (grade BETWEEN 3 AND 6),
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER CHECK (duration_seconds >= 0),
  turn_count SMALLINT NOT NULL DEFAULT 0 CHECK (turn_count BETWEEN 0 AND 30),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'abandoned')),
  CONSTRAINT practice_sessions_time_order CHECK (ended_at IS NULL OR ended_at >= started_at),
  CONSTRAINT practice_sessions_completion CHECK (
    (status = 'active' AND ended_at IS NULL AND duration_seconds IS NULL)
    OR (status IN ('completed', 'abandoned') AND ended_at IS NOT NULL AND duration_seconds IS NOT NULL)
  )
);
CREATE INDEX practice_sessions_student_started_idx ON practice_sessions (student_id, started_at DESC);

CREATE TABLE practice_turns (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES practice_sessions(id) ON DELETE CASCADE,
  turn_number SMALLINT NOT NULL CHECK (turn_number BETWEEN 1 AND 30),
  student_text TEXT NOT NULL CHECK (char_length(btrim(student_text)) BETWEEN 1 AND 600),
  ai_reply TEXT NOT NULL CHECK (char_length(btrim(ai_reply)) BETWEEN 1 AND 1000),
  feedback JSONB NOT NULL CHECK (jsonb_typeof(feedback) = 'object' AND feedback ? 'highlight' AND feedback ? 'suggestion'),
  input_mode TEXT NOT NULL CHECK (input_mode IN ('speech', 'text')),
  recognition_confidence DOUBLE PRECISION CHECK (recognition_confidence BETWEEN 0 AND 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  pronunciation_score NUMERIC(5,2) CHECK (pronunciation_score BETWEEN 0 AND 100),
  fluency_score NUMERIC(5,2) CHECK (fluency_score BETWEEN 0 AND 100),
  accuracy_score NUMERIC(5,2) CHECK (accuracy_score BETWEEN 0 AND 100),
  pronunciation_errors JSONB,
  CONSTRAINT practice_turns_order UNIQUE (session_id, turn_number)
);
