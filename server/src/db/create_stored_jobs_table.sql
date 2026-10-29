USE `AnsibleForms`;
CREATE TABLE `stored_jobs` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(255) NOT NULL,
  `description` TEXT DEFAULT NULL,
  `form_name` VARCHAR(255) NOT NULL,
  `username` VARCHAR(255) NOT NULL,
  `form_data` LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `expires_at` DATETIME DEFAULT NULL,
  `visibility` VARCHAR(10) NOT NULL DEFAULT 'private',
  UNIQUE KEY `uk_user_form_name` (`username`, `form_name`, `name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
