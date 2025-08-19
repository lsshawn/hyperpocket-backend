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
  createdAt: timestamp('created_at').defaultNow().notNull(),
	updatedAt: timestamp('updated_at').defaultNow().notNull(),
	deletedAt: timestamp('deleted_at'),
	name: text(),
	email: text().unique(),
  phone: text(),
	otp: integer(),
	otpExpiry: integer('otp_expiry'),
	otpAttempts: integer('otp_attempts'),
})

export const wallet = pgTable('wallets', {
	id: uuid().defaultRandom().primaryKey().notNull(),
})
export const transaction = pgTable('transactions', {
	id: uuid().defaultRandom().primaryKey().notNull(),
})
