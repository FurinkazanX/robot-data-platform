import axios from 'axios'

const api = axios.create({ baseURL: '/api' })

export default api

// ── Files ──────────────────────────────────────────────────────────────────

export interface FileItem {
  name: string
  path: string
  is_dir: boolean
  size: number | null
  mtime: number
  ext: string | null
}

export const listFiles = (path?: string) =>
  api.get<{ path: string; items: FileItem[] }>('/files/list', { params: { path } }).then(r => r.data)

export const localMkdir = (path: string) =>
  api.post('/files/mkdir', { path }).then(r => r.data)

export const localRename = (path: string, new_name: string) =>
  api.post('/files/rename', { path, new_name }).then(r => r.data)

export const localDelete = (path: string) =>
  api.post('/files/delete', { path }).then(r => r.data)

// ── Convert ────────────────────────────────────────────────────────────────

export interface HDF5Field {
  key: string
  shape: number[]
  dtype: string
  is_image: boolean
}

export interface PreviewResult {
  path: string
  fields: HDF5Field[]
  n_frames: number
  suggested_mapping: Record<string, string>
}

export const previewFile = (path: string) =>
  api.post<PreviewResult>('/convert/preview', { path }).then(r => r.data)

export const startConversion = (payload: {
  src_paths: string[]
  dst_path: string
  field_mapping: Record<string, string>
  incremental: boolean
  source_format?: string
  target_format?: string
}) => api.post<{ job_id: string }>('/convert/start', payload).then(r => r.data)

export const getConverters = () =>
  api.get<Array<{ key: string; source: string; target: string; name: string }>>('/convert/converters').then(r => r.data)

export const cancelConversion = (jobId: string) =>
  api.post(`/convert/cancel/${jobId}`).then(r => r.data)

// ── Transfer ───────────────────────────────────────────────────────────────

export interface SSHCreds {
  host: string
  port?: number
  username: string
  password?: string
  key_path?: string
}

export const testConnection = (creds: SSHCreds) =>
  api.post<{ ok: boolean }>('/transfer/test', creds).then(r => r.data)

export const listRemote = (creds: SSHCreds, path: string) =>
  api.post<{ path: string; items: FileItem[] }>('/transfer/remote', { ...creds, path }).then(r => r.data)

export const remoteMkdir = (creds: SSHCreds, path: string) =>
  api.post('/transfer/remote/mkdir', { ...creds, path }).then(r => r.data)

export const remoteRename = (creds: SSHCreds, old_path: string, new_path: string) =>
  api.post('/transfer/remote/rename', { ...creds, old_path, new_path }).then(r => r.data)

export const remoteDelete = (creds: SSHCreds, path: string) =>
  api.post('/transfer/remote/delete', { ...creds, path }).then(r => r.data)

export const startTransfer = (payload: SSHCreds & { local_paths: string[]; remote_base: string }) =>
  api.post<{ job_id: string }>('/transfer/start', payload).then(r => r.data)

export const cancelTransfer = (jobId: string) =>
  api.post(`/transfer/cancel/${jobId}`).then(r => r.data)

// ── Jobs (unified) ─────────────────────────────────────────────────────────

export interface JobInfo {
  job_id: string
  job_type: string   // 'convert' | 'transfer'
  status: string     // 'pending' | 'running' | 'done' | 'failed' | 'cancelled'
  total: number
  current: number
  percent: number
  current_file: string
  message: string
  error: string
  created_at: string
  updated_at: string
}

export const listAllJobs = () =>
  api.get<JobInfo[]>('/jobs').then(r => r.data)

export const dismissJob = (jobId: string) =>
  api.post(`/jobs/${jobId}/dismiss`).then(r => r.data)

// ── Visualize ──────────────────────────────────────────────────────────────

export interface DatasetInfo {
  format: string
  path: string
  n_episodes: number
  n_frames: number
  fps?: number
  fields?: HDF5Field[]
  features?: Record<string, unknown>
  episodes?: Array<{ episode_index: number; length: number }>
  cameras?: string[]
}

export const getDatasetInfo = (path: string) =>
  api.get<DatasetInfo>('/visualize/info', { params: { path } }).then(r => r.data)

export const getFrameUrl = (path: string, episode: number, frame_idx: number, cam?: string) => {
  const params = new URLSearchParams({ path, episode: String(episode), frame_idx: String(frame_idx) })
  if (cam) params.set('cam', cam)
  return `/api/visualize/frame?${params}`
}

export const getSeries = (path: string, episode: number, field?: string) =>
  api.get<{ fields: Record<string, number[]> }>('/visualize/series', {
    params: { path, episode, field },
  }).then(r => r.data)

export const editValue = (payload: {
  path: string
  episode: number
  frame_idx: number
  field: string
  value: unknown
}) => api.put('/visualize/edit', payload).then(r => r.data)

export const getRemoteDatasetInfo = (creds: SSHCreds, path: string) =>
  api.post<DatasetInfo>('/visualize/remote/info', { ...creds, path }).then(r => r.data)

export const fetchRemoteFrame = async (
  creds: SSHCreds, path: string, episode: number, frameIdx: number, cam: string,
): Promise<string> => {
  const res = await api.post<Blob>(
    '/visualize/remote/frame',
    { ...creds, path, episode, frame_idx: frameIdx, cam },
    { responseType: 'blob' },
  )
  return URL.createObjectURL(res.data)
}

export const getRemoteSeries = (
  creds: SSHCreds, path: string, episode: number, field?: string,
) =>
  api.post<{ fields: Record<string, number[]> }>(
    '/visualize/remote/series',
    { ...creds, path, episode, field },
  ).then(r => r.data)

export const getVideoUrl = (path: string, episode: number, cam: string): string => {
  const params = new URLSearchParams({ path, episode: String(episode), cam })
  return `/api/visualize/video?${params}`
}

export const cacheRemoteVideo = (creds: SSHCreds, path: string, episode: number, cam: string) =>
  api.post<{ ok: boolean; token: string }>('/visualize/remote/video/cache', { ...creds, path, episode, cam })
    .then(r => r.data)

export const getCachedVideoUrl = (token: string) => `/api/visualize/video/cached/${token}`

// ── Monitor ────────────────────────────────────────────────────────────────

export interface QueueItem {
  file_name: string
  file_path: string
  status: 'pending' | 'waiting' | 'converting' | 'transferring' | 'done' | 'failed'
  percent: number
  message: string
  added_at: string
}

export interface MonitorStatus {
  state: 'idle' | 'monitoring'
  mode: 'convert' | 'transfer'
  is_converting: boolean
  source_dir: string | null
  target_dir: string | null
  remote_host: string | null
  remote_target_dir: string | null
  queue: QueueItem[]
}

export const getMonitorStatus = () =>
  api.get<MonitorStatus>('/monitor/status').then(r => r.data)

export const startMonitor = (payload: {
  mode?: 'convert' | 'transfer'
  source_dir: string
  // convert mode
  target_dir?: string
  field_mapping?: Record<string, string>
  source_format?: string
  target_format?: string
  // transfer mode
  host?: string
  port?: number
  username?: string
  password?: string
  remote_target_dir?: string
}) => api.post<{ ok: boolean; message: string }>('/monitor/start', payload).then(r => r.data)

export const stopMonitor = () =>
  api.post<{ ok: boolean; message: string }>('/monitor/stop').then(r => r.data)

// ── Annotate ───────────────────────────────────────────────────────────────

export interface AnnotationData {
  version: number
  episodes: Record<string, {
    labels?: string[]
    frame_rewards?: Record<string, number>
  }>
}

export const loadAnnotations = (path: string) =>
  api.get<AnnotationData>('/annotate/load', { params: { path } }).then(r => r.data)

export const saveAnnotations = (payload: {
  path: string
  episode: number
  labels: string[]
  frame_rewards: Record<string, number>
}) => api.post<{ ok: boolean }>('/annotate/save', payload).then(r => r.data)

export const getAnnotationLabels = () =>
  api.get<{ suggestions: string[] }>('/annotate/labels').then(r => r.data)

// ── Reward Annotation ──────────────────────────────────────────────────────

export interface RewardSegment {
  id: string
  type: 'range' | 'point'
  startFrame: number
  endFrame: number
  value: number
}

export interface RewardGroup {
  id: string
  name: string
  color: string
  visible: boolean
  segments: RewardSegment[]
}

export const loadReward = (path: string, episode: number) =>
  api.get<{ groups: RewardGroup[] }>('/annotate/reward', { params: { path, episode } }).then(r => r.data)

export const saveReward = (path: string, episode: number, groups: RewardGroup[]) =>
  api.post<{ ok: boolean }>('/annotate/reward', { path, episode, groups }).then(r => r.data)

export const applyRewardToDataset = (path: string, episode: number, rewards: number[]) =>
  api.post<{ ok: boolean }>('/annotate/reward/apply', { path, episode, rewards }).then(r => r.data)

export const applyRewardRemote = (creds: SSHCreds, path: string, episode: number, rewards: number[]) =>
  api.post<{ ok: boolean }>('/annotate/reward/apply_remote', { ...creds, path, episode, rewards }).then(r => r.data)

export const getAnnotatedEpisodes = (path: string) =>
  api.get<{ episodes: number[] }>('/annotate/reward/annotated', { params: { path } }).then(r => r.data)
