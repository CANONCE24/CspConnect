CREATE TABLE IF NOT EXISTS feedback_email_outbox (
  id CHAR(36) NOT NULL PRIMARY KEY,
  feedback_id INT UNSIGNED NOT NULL,
  history_id INT UNSIGNED NOT NULL,
  kind ENUM('Acknowledged','Resolved','Rejected','StatusUpdated') NOT NULL,
  recipient VARCHAR(254) NOT NULL,
  payload_json TEXT NOT NULL,
  state ENUM('Pending','Processing','Sent','Failed') NOT NULL DEFAULT 'Pending',
  attempt_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  lease_token CHAR(36) NULL,
  lease_expires_at DATETIME(3) NULL,
  last_error VARCHAR(50) NULL,
  accepted_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY feedback_email_event (history_id),
  KEY feedback_email_ready (state,next_attempt_at),
  KEY feedback_email_feedback (feedback_id,created_at),
  FOREIGN KEY (feedback_id) REFERENCES feedback(id),
  FOREIGN KEY (history_id) REFERENCES feedback_status_history(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS feedback_email_attempts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  notification_id CHAR(36) NOT NULL,
  attempt_number TINYINT UNSIGNED NOT NULL,
  outcome ENUM('Processing','Accepted','TemporaryFailure','Failed','Unconfirmed') NOT NULL,
  error_code VARCHAR(50) NULL,
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at DATETIME(3) NULL,
  UNIQUE KEY feedback_email_attempt (notification_id,attempt_number),
  FOREIGN KEY (notification_id) REFERENCES feedback_email_outbox(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS feedback_email_retries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  notification_id CHAR(36) NOT NULL,
  requested_by INT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (notification_id) REFERENCES feedback_email_outbox(id),
  FOREIGN KEY (requested_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
