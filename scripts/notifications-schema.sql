CREATE TABLE IF NOT EXISTS feedback_notifications (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT UNSIGNED NOT NULL,
  feedback_id INT UNSIGNED NOT NULL,
  kind ENUM('StatusUpdated','AdminResponse','Published','Unpublished') NOT NULL,
  message VARCHAR(600) NOT NULL,
  event_key VARCHAR(100) NOT NULL,
  read_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY notification_event (event_key),
  KEY notification_owner_unread (user_id,read_at,id),
  CONSTRAINT notification_owner_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT notification_feedback_fk FOREIGN KEY (feedback_id) REFERENCES feedback(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
