CREATE TABLE `club_game_rsvps` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `club_scheduled_games`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `club_game_rsvps_game_user_idx` ON `club_game_rsvps` (`game_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `club_members` (
	`id` text PRIMARY KEY NOT NULL,
	`club_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`joined_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`club_id`) REFERENCES `clubs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `club_members_club_user_idx` ON `club_members` (`club_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `club_scheduled_games` (
	`id` text PRIMARY KEY NOT NULL,
	`club_id` text NOT NULL,
	`name` text NOT NULL,
	`format` text NOT NULL,
	`stakes` text NOT NULL,
	`scheduled_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`club_id`) REFERENCES `clubs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `club_tables` (
	`id` text PRIMARY KEY NOT NULL,
	`club_id` text NOT NULL,
	`room_code` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`club_id`) REFERENCES `clubs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `club_tables_room_code_unique` ON `club_tables` (`room_code`);--> statement-breakpoint
CREATE TABLE `clubs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`invite_code` text NOT NULL,
	`owner_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `clubs_invite_code_unique` ON `clubs` (`invite_code`);