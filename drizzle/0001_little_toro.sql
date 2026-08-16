CREATE TABLE `tables` (
	`room_code` text PRIMARY KEY NOT NULL,
	`seat_count` integer NOT NULL,
	`occupied_count` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
