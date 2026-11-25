-- Fresh CSPC Suggestion & Feedback System schema.
-- Select a NEW database before importing this file. No existing tables are modified.

CREATE TABLE users (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  google_id VARCHAR(191) NULL,
  name VARCHAR(200) NOT NULL,
  email VARCHAR(254) NOT NULL,
  password_hash VARCHAR(255) NULL,
  must_change_password TINYINT(1) NOT NULL DEFAULT 0,
  email_verified_at DATETIME(3) NULL,
  password_verified_at DATETIME(3) NULL,
  session_version INT UNSIGNED NOT NULL DEFAULT 0,
  legacy_active TINYINT(1) NOT NULL DEFAULT 0,
  affiliation ENUM('Student','Faculty','Staff','Visitor') NULL,
  affiliation_email VARCHAR(254) NULL,
  avatar_url VARCHAR(2048) NULL,
  role ENUM('student', 'admin', 'security') NOT NULL DEFAULT 'student',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY users_google_id_unique (google_id),
  UNIQUE KEY users_email_unique (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE categories (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY categories_name_unique (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE feedback (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT UNSIGNED NOT NULL,
  category_id INT UNSIGNED NOT NULL,
  reference VARCHAR(40) NULL,
  type ENUM('Suggestion', 'Complaint', 'Concern', 'General Feedback', 'Appreciation') NOT NULL,
  title VARCHAR(150) NOT NULL,
  description TEXT NOT NULL,
  is_anonymous TINYINT(1) NOT NULL DEFAULT 0,
  attachment_path VARCHAR(255) NULL,
  attachment_mime VARCHAR(50) NULL,
  status ENUM('Submitted', 'Under Review', 'In Progress', 'Resolved', 'Closed') NOT NULL DEFAULT 'Submitted',
  is_published TINYINT(1) NOT NULL DEFAULT 0,
  published_at DATETIME NULL,
  resolved_at DATETIME(3) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY feedback_reference_unique (reference),
  KEY feedback_owner_created (user_id, created_at, id),
  KEY feedback_publication (is_published, published_at, id),
  KEY feedback_status_created (status, created_at),
  KEY feedback_type_category (type, category_id),
  CONSTRAINT feedback_user_fk FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT feedback_category_fk FOREIGN KEY (category_id) REFERENCES categories (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE feedback_status_history (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  feedback_id INT UNSIGNED NOT NULL,
  previous_status ENUM('Submitted', 'Under Review', 'In Progress', 'Resolved', 'Closed') NULL,
  status ENUM('Submitted', 'Under Review', 'In Progress', 'Resolved', 'Closed') NOT NULL,
  changed_by INT UNSIGNED NOT NULL,
  resolution_summary TEXT NULL,
  additional_message TEXT NULL,
  rejection_reason TEXT NULL,
  request_key CHAR(36) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY feedback_status_request (feedback_id, request_key),
  KEY history_feedback_time (feedback_id, created_at, id),
  CONSTRAINT history_feedback_fk FOREIGN KEY (feedback_id) REFERENCES feedback (id) ON DELETE CASCADE,
  CONSTRAINT history_user_fk FOREIGN KEY (changed_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE feedback_responses (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  feedback_id INT UNSIGNED NOT NULL,
  admin_id INT UNSIGNED NOT NULL,
  body TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY responses_feedback_time (feedback_id, created_at, id),
  CONSTRAINT response_feedback_fk FOREIGN KEY (feedback_id) REFERENCES feedback (id) ON DELETE CASCADE,
  CONSTRAINT response_admin_fk FOREIGN KEY (admin_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE feedback_reactions (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  feedback_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  kind ENUM('support', 'not_helpful') NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY reactions_feedback_user_unique (feedback_id, user_id),
  KEY reactions_feedback_kind (feedback_id, kind),
  KEY reactions_user (user_id),
  CONSTRAINT reaction_feedback_fk FOREIGN KEY (feedback_id) REFERENCES feedback (id) ON DELETE CASCADE,
  CONSTRAINT reaction_user_fk FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE feedback_comments (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  feedback_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  body VARCHAR(500) NOT NULL,
  is_hidden TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY comments_feedback_visibility_time (feedback_id, is_hidden, created_at, id),
  KEY comments_moderation (is_hidden, created_at),
  KEY comments_user (user_id),
  CONSTRAINT comment_feedback_fk FOREIGN KEY (feedback_id) REFERENCES feedback (id) ON DELETE CASCADE,
  CONSTRAINT comment_user_fk FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sessions (
  session_id VARCHAR(128) NOT NULL,
  expires BIGINT UNSIGNED NOT NULL,
  data MEDIUMTEXT NOT NULL,
  PRIMARY KEY (session_id),
  KEY sessions_expiry (expires)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS emergency_reports (
  id CHAR(36) NOT NULL PRIMARY KEY,
  reporter_id INT UNSIGNED NOT NULL,
  request_key CHAR(36) NOT NULL,
  type ENUM('Medical','Fire','Accident','Security Threat','Other') NOT NULL,
  location VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  contact_number VARCHAR(16) NULL,
  status ENUM('Submitted','Acknowledged','Responding','Resolved') NOT NULL DEFAULT 'Submitted',
  acknowledged_by INT UNSIGNED NULL,
  acknowledged_at DATETIME(3) NULL,
  resolved_at DATETIME(3) NULL,
  escalated_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY emergency_request (reporter_id, request_key),
  KEY emergency_pending (status, created_at),
  KEY emergency_owner (reporter_id, created_at),
  FOREIGN KEY (reporter_id) REFERENCES users(id),
  FOREIGN KEY (acknowledged_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS emergency_history (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  report_id CHAR(36) NOT NULL,
  actor_id INT UNSIGNED NULL,
  action VARCHAR(40) NOT NULL,
  previous_status VARCHAR(20) NULL,
  status VARCHAR(20) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY emergency_history_report (report_id, id),
  FOREIGN KEY (report_id) REFERENCES emergency_reports(id),
  FOREIGN KEY (actor_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS emergency_settings (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  guardhouse_number VARCHAR(16) NOT NULL DEFAULT '',
  number_verified TINYINT(1) NOT NULL DEFAULT 0,
  escalation_minutes INT UNSIGNED NOT NULL DEFAULT 3,
  updated_by INT UNSIGNED NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (updated_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS emergency_settings_history (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  actor_id INT UNSIGNED NOT NULL,
  settings_json TEXT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (actor_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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


CREATE TABLE IF NOT EXISTS account_action_tokens (
  token_hash CHAR(64) NOT NULL PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  purpose ENUM('verify','reset') NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  used_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY account_token_requests (user_id,purpose,created_at),
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS email_verifications (
  email VARCHAR(254) NOT NULL PRIMARY KEY,
  challenge_id CHAR(64) NOT NULL UNIQUE,
  code_hash CHAR(64) NOT NULL,
  name VARCHAR(200) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  expected_hash VARCHAR(255) NULL,
  user_id INT UNSIGNED NULL,
  expires_at DATETIME(3) NOT NULL,
  attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  sent_at DATETIME(3) NOT NULL,
  consumed_at DATETIME(3) NULL,
  hour_started_at DATETIME(3) NOT NULL,
  send_count TINYINT UNSIGNED NOT NULL DEFAULT 1,
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS login_migrations (
  name VARCHAR(100) NOT NULL PRIMARY KEY,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS support_tickets (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  reference VARCHAR(32) NULL,
  user_id INT UNSIGNED NOT NULL,
  affiliation ENUM('Student','Faculty','Staff','Visitor') NULL,
  category ENUM('Account Issues','Feedback Concerns','Technical Support','Privacy Concerns','General Inquiry','Others') NOT NULL,
  subject VARCHAR(150) NOT NULL,
  status ENUM('Open','Pending','Closed') NOT NULL DEFAULT 'Open',
  version INT UNSIGNED NOT NULL DEFAULT 1,
  request_key CHAR(36) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY support_reference (reference),
  UNIQUE KEY support_submission (user_id,request_key),
  KEY support_owner_updated (user_id,updated_at,id),
  KEY support_status_updated (status,updated_at,id),
  CONSTRAINT support_owner_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS support_messages (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  ticket_id INT UNSIGNED NOT NULL,
  sender_id INT UNSIGNED NOT NULL,
  sender_role ENUM('student','admin') NOT NULL,
  body TEXT NOT NULL,
  request_key CHAR(36) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY support_message_request (ticket_id,sender_id,request_key),
  CONSTRAINT support_message_ticket_fk FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE RESTRICT,
  CONSTRAINT support_message_sender_fk FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS support_history (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  ticket_id INT UNSIGNED NOT NULL,
  actor_id INT UNSIGNED NOT NULL,
  action ENUM('Created','UserReply','AdminReply','StatusChanged') NOT NULL,
  previous_status ENUM('Open','Pending','Closed') NULL,
  status ENUM('Open','Pending','Closed') NOT NULL,
  version INT UNSIGNED NOT NULL,
  request_key CHAR(36) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY support_action_request (actor_id,request_key),
  KEY support_history_ticket (ticket_id,id),
  CONSTRAINT support_history_ticket_fk FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE RESTRICT,
  CONSTRAINT support_history_actor_fk FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS feedback_notifications (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT UNSIGNED NOT NULL,
  feedback_id INT UNSIGNED NULL,
  support_ticket_id INT UNSIGNED NULL,
  kind ENUM('StatusUpdated','AdminResponse','Published','Unpublished','SupportNew','SupportReply','SupportStatus') NOT NULL,
  message VARCHAR(600) NOT NULL,
  event_key VARCHAR(100) NOT NULL,
  read_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY notification_event (event_key),
  KEY notification_owner_unread (user_id,read_at,id),
  CONSTRAINT notification_owner_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT notification_support_fk FOREIGN KEY (support_ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE,
  CONSTRAINT notification_feedback_fk FOREIGN KEY (feedback_id) REFERENCES feedback(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS comment_moderation (
  comment_id INT UNSIGNED NOT NULL PRIMARY KEY,
  state ENUM('Published','Pending','Approved','Removed') NOT NULL DEFAULT 'Published',
  reasons_json JSON NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  reviewed_by INT UNSIGNED NULL,
  reviewed_at DATETIME(3) NULL,
  KEY comment_review_state (state,comment_id),
  FOREIGN KEY (comment_id) REFERENCES feedback_comments(id) ON DELETE CASCADE,
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
