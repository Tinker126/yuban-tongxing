-- Administrators do not have a student grade. Students must always have grades 3–6.
ALTER TABLE users ALTER COLUMN grade DROP NOT NULL;
UPDATE users SET grade = NULL WHERE role = 'admin';
ALTER TABLE users
  ADD CONSTRAINT users_role_grade CHECK (
    (role = 'student' AND grade BETWEEN 3 AND 6)
    OR (role = 'admin' AND grade IS NULL)
  );
