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
