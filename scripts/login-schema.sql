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
