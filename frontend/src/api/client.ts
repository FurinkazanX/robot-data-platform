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
