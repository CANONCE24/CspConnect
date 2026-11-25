CREATE TABLE IF NOT EXISTS comment_moderation (
  comment_id INT UNSIGNED NOT NULL PRIMARY KEY,
  state ENUM('Published','Pending','Approved','Removed') NOT NULL DEFAULT 'Published',
  reasons_json JSON NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  reviewed_by INT UNSIGNED NULL,
  reviewed_at DATETIME(3) NULL,
  KEY comment_review_state (state,comment_id),
  FOREIGN KEY (comment_id) REFEzRENCES feedback_comments(id) ON DELETE CASCADE,
  FOREIGN KEY (reviewed_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS comment_reports (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  comment_id INT UNSIGNED NOT NULL,
  reporter_id INT UNSIGNED NOT NULL,
  reason ENUM('harassment','offensive','spam','inappropriate','other') NOT NULL,
  details VARCHAR(300) NOT NULL DEFAULT '',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  resolved_at DATETIME(3) NULL,
  resolved_by INT UNSIGNED NULL,
  UNIQUE KEY comment_reporter_unique (comment_id,reporter_id),
  KEY comment_open_reports (comment_id,resolved_at),
  FOREIGN KEY (comment_id) REFERENCES feedback_comments(id) ON DELETE CASCADE,
  FOREIGN KEY (reporter_id) REFERENCES users(id),
  FOREIGN KEY (resolved_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS comment_moderation_history (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  comment_id INT UNSIGNED NOT NULL,
  actor_id INT UNSIGNED NOT NULL,
  action ENUM('Submitted','Edited','Reported','Approved','Removed','Restored') NOT NULL,
  state ENUM('Published','Pending','Approved','Removed') NOT NULL,
  version INT UNSIGNED NOT NULL,
  body_snapshot VARCHAR(500) NOT NULL,
  reasons_json JSON NULL,
  note VARCHAR(300) NOT NULL DEFAULT '',
  request_key VARCHAR(100) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY comment_action_key (comment_id,request_key),
  KEY comment_history_time (comment_id,id),
  FOREIGN KEY (comment_id) REFERENCES feedback_comments(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
