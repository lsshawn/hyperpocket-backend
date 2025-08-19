import {config} from 'dotenv'
import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
config({ path: '.env'})

if (!DATABASE_URL) throw new Error('db/index.ts: DATABASE_URL is not set');

const client = neon(DATABASE_URL);

export const db = drizzle(client);

