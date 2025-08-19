import {z} from 'zod'

const envSchema = z.object({
	DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
})

function validateEnv() {
	try {
		return envSchema.parse(process.env)
	} catch (error) {
		throw error
	}
}

export const env = validateEnv()

export const config = {
	apiSettings: {
		paginationLimit: 100,
	},
}

