export type AdminImportJobStatus =
  | 'queued'
  | 'uploading'
  | 'validating'
  | 'processing'
  | 'finalizing'
  | 'partial_failure'
  | 'paused'
  | 'completed'
  | 'failed'

export interface AdminImportJobSummary {
  id: string
  type: 'zip' | 'legacy'
  status: AdminImportJobStatus | string
  source_name: string | null
  package_size: number | null
  package_uploaded: boolean
  total_count: number
  success_count: number
  failure_count: number
  creator_email: string
  created_at: string
  uploaded_at: string | null
  started_at: string | null
  updated_at: string | null
  completed_at: string | null
  last_error_code: string | null
  last_error_message: string | null
  has_error_report: boolean
}

export interface AdminImportJobItem {
  id: string
  folder: string
  title: string
  slug: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  stage: 'preflight' | 'content' | 'media' | 'commit' | 'completed'
  retryable: number
  gallery_id: string | null
  attempt_count: number
  image_count: number
  video_count: number
  error_code: string | null
  error_message: string | null
  created_at: string
  updated_at: string
}

export interface AdminImportJobDetail extends AdminImportJobSummary {
  attempt_count: number
  items: AdminImportJobItem[]
}
