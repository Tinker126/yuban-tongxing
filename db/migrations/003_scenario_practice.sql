-- Scenario snapshots are nullable so existing free-chat records remain unchanged.
ALTER TABLE practice_sessions
  ADD COLUMN scene_id TEXT,
  ADD COLUMN scene_title TEXT,
  ADD COLUMN scenario_progress JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN scenario_completed_at TIMESTAMPTZ,
  ADD CONSTRAINT practice_sessions_scenario_progress_object
    CHECK (jsonb_typeof(scenario_progress) = 'object'),
  ADD CONSTRAINT practice_sessions_scenario_metadata_pair
    CHECK ((scene_id IS NULL AND scene_title IS NULL) OR (scene_id IS NOT NULL AND scene_title IS NOT NULL));

CREATE INDEX practice_sessions_scene_started_idx
  ON practice_sessions (scene_id, started_at DESC)
  WHERE scene_id IS NOT NULL;
