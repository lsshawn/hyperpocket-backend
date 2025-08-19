import {
	pgTable,
	foreignKey,
	uuid,
	timestamp,
	text,
	bigint,
	json,
	real,
	jsonb,
	boolean,
	integer,
	unique,
	varchar,
	pgPolicy,
	check,
	numeric,
	date,
	serial,
	index,
	doublePrecision,
	primaryKey,
	pgView,
	pgSequence,
	pgEnum
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const user = pgTable('users', {
	id: uuid().defaultRandom().primaryKey().notNull(),
	createdAt: CreatedAt,
	updatedAt: UpdatedAt,
	name: text('name'),
	email: text('email').unique(),
	otp: integer('otp'),
	otpExpiry: integer('otp_expiry'),
	otpAttempts: integer('otp_attempts'),
})

