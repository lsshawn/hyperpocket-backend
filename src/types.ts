export interface ApiResponse<T = any> {
	data: T;
	pagination?: Pagination;
	message?: string;
}

export interface ApiResponseList<T = any> {
	data: T[];
	pagination?: Pagination;
	message?: string;
}

export interface ApiResponseError {
	error: string;
	details?: string;
	message?: string;
}

export interface Pagination {
	page: number; // current page (1-based)
	pageSize: number; // items per page
	totalItems: number; // total number of items
	totalPages: number; // total number of pages
}
