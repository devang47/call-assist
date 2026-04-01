CREATE TABLE `call_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`practice_id` text NOT NULL,
	`call_sid` text NOT NULL,
	`stream_sid` text,
	`caller_phone` text,
	`patient_id` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	`duration_seconds` integer,
	`outcome` text,
	`outcome_details` text,
	`cost_cents` integer,
	`stt_cost_cents` integer,
	`llm_cost_cents` integer,
	`tts_cost_cents` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`practice_id`) REFERENCES `practices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`patient_id`) REFERENCES `patients`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `call_logs_call_sid_unique` ON `call_logs` (`call_sid`);--> statement-breakpoint
CREATE TABLE `call_transcripts` (
	`id` text PRIMARY KEY NOT NULL,
	`call_log_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`tool_name` text,
	`tool_input` text,
	`tool_output` text,
	`timestamp` text NOT NULL,
	`sequence` integer NOT NULL,
	FOREIGN KEY (`call_log_id`) REFERENCES `call_logs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `google_oauth_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`practice_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text NOT NULL,
	`expiry_date` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`practice_id`) REFERENCES `practices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `google_oauth_tokens_practice_id_unique` ON `google_oauth_tokens` (`practice_id`);--> statement-breakpoint
CREATE TABLE `patients` (
	`id` text PRIMARY KEY NOT NULL,
	`practice_id` text NOT NULL,
	`phone` text NOT NULL,
	`name` text,
	`notes` text,
	`call_count` integer DEFAULT 0 NOT NULL,
	`last_call_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`practice_id`) REFERENCES `practices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `patients_practice_phone_idx` ON `patients` (`practice_id`,`phone`);--> statement-breakpoint
CREATE TABLE `practices` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`timezone` text DEFAULT 'America/New_York' NOT NULL,
	`phone` text DEFAULT '',
	`address` text DEFAULT '',
	`twilio_number` text NOT NULL,
	`staff_phone` text,
	`appointment_duration_minutes` integer DEFAULT 30 NOT NULL,
	`business_hours` text NOT NULL,
	`google_calendar_id` text DEFAULT 'primary' NOT NULL,
	`system_prompt_override` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `practices_slug_unique` ON `practices` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `practices_twilio_number_unique` ON `practices` (`twilio_number`);