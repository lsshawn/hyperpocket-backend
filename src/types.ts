export interface ApiResponse<T = any> {
	data: T
	pagination?: Pagination
}

export interface ApiResponseList<T = any> {
	data: T[]
	pagination?: Pagination
}

export interface ApiResponseError {
	error: string
	details?: string
}

