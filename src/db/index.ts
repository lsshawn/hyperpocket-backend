import 'dotenv/config';
import * as schema from './schema.js';
import { drizzle } from 'drizzle-orm/node-postgres';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not defined');
}

export const db = drizzle(process.env.DATABASE_URL, { schema });
