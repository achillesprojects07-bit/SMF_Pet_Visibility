CREATE TABLE IF NOT EXISTS photo_sessions (
  session_id TEXT PRIMARY KEY,
  user_name TEXT NOT NULL,
  team TEXT NOT NULL,
  store_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS photo_uploads (
  upload_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  store_key TEXT NOT NULL,
  photo_type TEXT NOT NULL,
  base_type TEXT NOT NULL,
  is_extra INTEGER NOT NULL DEFAULT 0,
  file_id TEXT,
  folder_id TEXT,
  file_name TEXT,
  file_url TEXT,
  mime TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_photo_uploads_session ON photo_uploads(session_id);
CREATE INDEX IF NOT EXISTS idx_photo_uploads_status ON photo_uploads(status);
CREATE INDEX IF NOT EXISTS idx_photo_uploads_store ON photo_uploads(store_key);
