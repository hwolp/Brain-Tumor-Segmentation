export interface PatientsListParams {
  q?: string;
  page: number;
  pageSize: number;
}

export interface AdminUsersListParams {
  q?: string;
  status: string;
  page: number;
  pageSize: number;
}

export interface AdminJobsListParams {
  q?: string;
  status: string;
  page: number;
  pageSize: number;
}

export interface AdminAuditEventListParams {
  q?: string;
  page: number;
  pageSize: number;
}

export interface AdminBenchmarksListParams {
  q?: string;
  state?: string;
  workerId?: string;
  page: number;
  pageSize: number;
}
