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
