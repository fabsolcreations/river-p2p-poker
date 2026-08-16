CREATE TABLE `hand_participants` (
	`id` text PRIMARY KEY NOT NULL,
	`hand_id` text NOT NULL,
	`user_id` text NOT NULL,
	`seat` integer NOT NULL,
	`net_result` integer NOT NULL,
	FOREIGN KEY (`hand_id`) REFERENCES `hands`(`hand_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `hands` (
	`hand_id` text PRIMARY KEY NOT NULL,
	`room_code` text NOT NULL,
	`seat_count` integer NOT NULL,
	`bundle` text NOT NULL,
	`completed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
