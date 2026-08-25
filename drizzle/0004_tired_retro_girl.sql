ALTER TABLE `tables` ADD `small_blind` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `tables` ADD `big_blind` integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE `tables` ADD `min_buy_in` integer DEFAULT 40 NOT NULL;--> statement-breakpoint
ALTER TABLE `tables` ADD `max_buy_in` integer DEFAULT 200 NOT NULL;--> statement-breakpoint
ALTER TABLE `tables` ADD `is_lounge` integer DEFAULT false NOT NULL;