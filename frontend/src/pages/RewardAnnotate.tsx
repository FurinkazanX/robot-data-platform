import {
  useCallback, useEffect, useMemo, useRef, useState, KeyboardEvent,
} from 'react'
import {
  Button, Col, Form, Input, InputNumber, Popconfirm, Radio, Row,
  Slider, Space, Spin, Tag, Tooltip, Typography, message,
} from 'antd'
import {
  ArrowLeftOutlined, DatabaseOutlined, DeleteOutlined,
  EyeInvisibleOutlined, EyeOutlined, FileOutlined, FolderOutlined,
  MinusOutlined, PauseCircleOutlined, PlayCircleOutlined,
  PlusOutlined, SaveOutlined, StepBackwardOutlined, StepForwardOutlined,
  ZoomInOutlined, ZoomOutOutlined,
} from '@ant-design/icons'
import FileBrowser from '../components/FileBrowser'
import {
  getDatasetInfo, getFrameUrl, loadReward, saveReward,
  applyRewardToDataset, applyRewardRemote,
  getRemoteDatasetInfo, fetchRemoteFrame, listRemote, testConnection,
  type DatasetInfo, type FileItem, type RewardGroup, type RewardSegment,
  type SSHCreds,
} from '../api/client'

const { Title, Text } = Typography

// ── Constants ────────────────────────────────────────────────────────────────

const RULER_H = 28
const CURVE_H = 64
const TRACK_H = 44
const SIDEBAR_W = 140
const MIN_PX_PER_FRAME = 0.5
const MAX_PX_PER_FRAME = 20

const GROUP_COLORS = [
  '#1890ff', '#52c41a', '#fa8c16', '#f5222d',
  '#722ed1', '#13c2c2', '#eb2f96', '#fadb14',
]

type EditMode = 'select' | 'range' | 'point'
type DataSource = 'local' | 'remote'

interface DragState {
  type: 'creating'
  groupId: string
  startFrame: number
  endFrame: number
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function nanoid() { return Math.random().toString(36).slice(2, 10) }
function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)) }
function parentPath(p: string) {
  const idx = p.lastIndexOf('/')
  return idx <= 0 ? '/' : p.slice(0, idx)
}

function computeRewardSum(groups: RewardGroup[], totalFrames: number): Float32Array {
  const arr = new Float32Array(totalFrames)
  for (const g of groups) {
    if (!g.visible) continue
    for (const seg of g.segments) {
      const s = clamp(seg.startFrame, 0, totalFrames - 1)
      const e = clamp(seg.endFrame, 0, totalFrames - 1)
      for (let f = s; f <= e; f++) arr[f] += seg.value
    }
  }
  return arr
}

function buildCurvePath(
  rewards: Float32Array, pxPerFrame: number, height: number,
  minR: number, maxR: number,
): string {
  if (rewards.length === 0) return ''
  const range = maxR - minR || 1
  const pts: string[] = []
  const step = Math.max(1, Math.round(2 / pxPerFrame))
  for (let f = 0; f < rewards.length; f += step) {
    const x = (f + 0.5) * pxPerFrame
    const y = height - ((rewards[f] - minR) / range) * (height - 4) - 2
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`)
  }
  const last = rewards.length - 1
  pts.push(`${((last + 0.5) * pxPerFrame).toFixed(1)},${(height - ((rewards[last] - minR) / range) * (height - 4) - 2).toFixed(1)}`)
  return pts.join(' ')
}

// ── Timeline SVG component ────────────────────────────────────────────────────

interface TimelineProps {
  totalFrames: number
  currentFrame: number
  groups: RewardGroup[]
  rewardSum: Float32Array
  pxPerFrame: number
  editMode: EditMode
  selectedSegId: string | null
  onSeek: (f: number) => void
  onCreateSegment: (groupId: string, startFrame: number, endFrame: number) => void
  onSelectSegment: (segId: string | null, groupId?: string) => void
  onMoveHandle: (segId: string, groupId: string, edge: 'start' | 'end', frame: number) => void
}

function Timeline({
  totalFrames, currentFrame, groups, rewardSum,
  pxPerFrame, editMode, selectedSegId,
  onSeek, onCreateSegment, onSelectSegment, onMoveHandle,
}: TimelineProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [resizeDrag, setResizeDrag] = useState<{ segId: string; groupId: string; edge: 'start' | 'end' } | null>(null)
  const [dragInternal, setDragInternal] = useState<DragState | null>(null)

  const svgWidth = Math.max(totalFrames * pxPerFrame, 1)
  const svgHeight = RULER_H + CURVE_H + groups.length * TRACK_H + 8

  const minR = Math.min(0, ...Array.from(rewardSum))
  const maxR = Math.max(0, ...Array.from(rewardSum))
  const curvePts = useMemo(
    () => buildCurvePath(rewardSum, pxPerFrame, CURVE_H, minR, maxR),
    [rewardSum, pxPerFrame, minR, maxR],
  )

  const frameAtX = (clientX: number) => {
    if (!svgRef.current) return 0
    const rect = svgRef.current.getBoundingClientRect()
    return clamp(Math.round((clientX - rect.left) / pxPerFrame), 0, totalFrames - 1)
  }

  const groupAtY = (clientY: number): string | null => {
    if (!svgRef.current) return null
    const rect = svgRef.current.getBoundingClientRect()
    const y = clientY - rect.top
    const idx = Math.floor((y - RULER_H - CURVE_H) / TRACK_H)
    if (idx >= 0 && idx < groups.length) return groups[idx].id
    return null
  }

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    const frame = frameAtX(e.clientX)
    if (editMode === 'select') { onSeek(frame); return }
    const gid = groupAtY(e.clientY)
    if (!gid) { onSeek(frame); return }
    if (editMode === 'point') { onCreateSegment(gid, frame, frame); return }
    setDragInternal({ type: 'creating', groupId: gid, startFrame: frame, endFrame: frame })
    e.preventDefault()
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (resizeDrag) {
      onMoveHandle(resizeDrag.segId, resizeDrag.groupId, resizeDrag.edge, frameAtX(e.clientX))
      return
    }
    if (!dragInternal) return
    setDragInternal(d => d ? { ...d, endFrame: frameAtX(e.clientX) } : d)
  }

  const handleMouseUp = () => {
    if (resizeDrag) { setResizeDrag(null); return }
    if (dragInternal) {
      const s = Math.min(dragInternal.startFrame, dragInternal.endFrame)
      const en = Math.max(dragInternal.startFrame, dragInternal.endFrame)
      if (en > s) onCreateSegment(dragInternal.groupId, s, en)
      setDragInternal(null)
    }
  }

  const rulerTicks = useMemo(() => {
    const ticks: JSX.Element[] = []
    const rawStep = totalFrames / 10
    const step = Math.max(1, Math.pow(10, Math.floor(Math.log10(rawStep))) * (rawStep < 5 * Math.pow(10, Math.floor(Math.log10(rawStep))) ? 2 : 5))
    for (let f = 0; f <= totalFrames; f += step) {
      const x = f * pxPerFrame
      ticks.push(
        <g key={f}>
          <line x1={x} y1={RULER_H - 8} x2={x} y2={RULER_H} stroke="#999" strokeWidth={1} />
          <text x={x + 2} y={RULER_H - 10} fontSize={10} fill="#666">{f}</text>
        </g>
      )
    }
    return ticks
  }, [totalFrames, pxPerFrame])

  return (
    <svg
      ref={svgRef}
      width={svgWidth}
      height={svgHeight}
      style={{ display: 'block', cursor: editMode === 'select' ? 'crosshair' : 'cell' }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      <rect width={svgWidth} height={svgHeight} fill="#fafafa" />
      <rect width={svgWidth} height={RULER_H} fill="#f0f0f0" />
      {rulerTicks}
      <rect y={RULER_H} width={svgWidth} height={CURVE_H} fill="#fff" stroke="#e8e8e8" strokeWidth={1} />
      {minR < 0 && maxR > 0 && (() => {
        const zy = RULER_H + CURVE_H - ((-minR) / (maxR - minR)) * (CURVE_H - 4) - 2
        return <line x1={0} y1={zy} x2={svgWidth} y2={zy} stroke="#ddd" strokeWidth={1} strokeDasharray="4,2" />
      })()}
      {curvePts && (
        <polyline points={curvePts} fill="none" stroke="#1890ff" strokeWidth={1.5}
          transform={`translate(0,${RULER_H})`} />
      )}
      <text x={4} y={RULER_H + 14} fontSize={10} fill="#999">Reward Sum</text>

      {groups.map((g, gi) => {
        const trackY = RULER_H + CURVE_H + gi * TRACK_H
        return (
          <g key={g.id}>
            <rect y={trackY} width={svgWidth} height={TRACK_H}
              fill={gi % 2 === 0 ? '#fff' : '#fafafa'} stroke="#e8e8e8" strokeWidth={1} />
            {g.segments.map(seg => {
              const sx = seg.startFrame * pxPerFrame
              const ex = (seg.endFrame + 1) * pxPerFrame
              const w = Math.max(ex - sx, 2)
              const isSel = seg.id === selectedSegId
              const alpha = g.visible ? 1 : 0.3
              return (
                <g key={seg.id} opacity={alpha}>
                  {seg.type === 'point' ? (
                    <>
                      <line x1={sx + pxPerFrame / 2} y1={trackY + 4}
                        x2={sx + pxPerFrame / 2} y2={trackY + TRACK_H - 4}
                        stroke={g.color} strokeWidth={isSel ? 3 : 2} />
                      <polygon
                        points={`${sx + pxPerFrame / 2},${trackY + 6} ${sx + pxPerFrame / 2 - 5},${trackY + 14} ${sx + pxPerFrame / 2 + 5},${trackY + 14}`}
                        fill={g.color} stroke={isSel ? '#ff4d4f' : 'none'} strokeWidth={1.5}
                        style={{ cursor: 'pointer' }}
                        onClick={e => { e.stopPropagation(); onSelectSegment(seg.id, g.id) }}
                      />
                    </>
                  ) : (
                    <>
                      <rect x={sx} y={trackY + 4} width={w} height={TRACK_H - 8} rx={3}
                        fill={g.color} fillOpacity={0.35}
                        stroke={isSel ? '#ff4d4f' : g.color} strokeWidth={isSel ? 2 : 1}
                        style={{ cursor: 'pointer' }}
                        onClick={e => { e.stopPropagation(); onSelectSegment(seg.id, g.id) }}
                      />
                      {w > 30 && (
                        <text x={sx + w / 2} y={trackY + TRACK_H / 2 + 4}
                          textAnchor="middle" fontSize={11} fill={g.color}
                          style={{ pointerEvents: 'none', userSelect: 'none' }}>
                          {seg.value.toFixed(2)}
                        </text>
                      )}
                      {isSel && (
                        <>
                          <rect x={sx - 4} y={trackY + 4} width={8} height={TRACK_H - 8} rx={2}
                            fill="#ff4d4f" style={{ cursor: 'ew-resize' }}
                            onMouseDown={e => { e.stopPropagation(); setResizeDrag({ segId: seg.id, groupId: g.id, edge: 'start' }) }} />
                          <rect x={sx + w - 4} y={trackY + 4} width={8} height={TRACK_H - 8} rx={2}
                            fill="#ff4d4f" style={{ cursor: 'ew-resize' }}
                            onMouseDown={e => { e.stopPropagation(); setResizeDrag({ segId: seg.id, groupId: g.id, edge: 'end' }) }} />
                        </>
                      )}
                    </>
                  )}
                </g>
              )
            })}
            {/* Drag preview */}
            {dragInternal?.groupId === g.id && (() => {
              const ds = Math.min(dragInternal.startFrame, dragInternal.endFrame) * pxPerFrame
              const dw = Math.max((Math.abs(dragInternal.endFrame - dragInternal.startFrame) + 1) * pxPerFrame, 2)
              return (
                <rect x={ds} y={trackY + 4} width={dw} height={TRACK_H - 8} rx={3}
                  fill={g.color} fillOpacity={0.5} stroke={g.color} strokeWidth={1}
                  strokeDasharray="4,2" style={{ pointerEvents: 'none' }} />
              )
            })()}
          </g>
        )
      })}

      {/* Playhead */}
      <line x1={currentFrame * pxPerFrame + pxPerFrame / 2} y1={0}
        x2={currentFrame * pxPerFrame + pxPerFrame / 2} y2={svgHeight}
        stroke="#ff4d4f" strokeWidth={1.5} style={{ pointerEvents: 'none' }} />
      <polygon
        points={`${currentFrame * pxPerFrame - 5},0 ${currentFrame * pxPerFrame + pxPerFrame / 2 + 5},0 ${currentFrame * pxPerFrame + pxPerFrame / 2},10`}
        fill="#ff4d4f" style={{ pointerEvents: 'none' }} />
    </svg>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

interface SelectedSeg { segId: string; groupId: string }

export default function RewardAnnotate() {
  // Source toggle
  const [dataSource, setDataSource] = useState<DataSource>('local')

  // Dataset state
  const [selectedFile, setSelectedFile] = useState<FileItem | null>(null)
  const [info, setInfo] = useState<DatasetInfo | null>(null)
  const [episode, setEpisode] = useState(0)
  const [totalFrames, setTotalFrames] = useState(0)
  const [imgErrors, setImgErrors] = useState<Record<string, boolean>>({})

  // Playback
  const [currentFrame, setCurrentFrame] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [fps, setFps] = useState(10)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Reward groups
  const [groups, setGroups] = useState<RewardGroup[]>([])
  const [selected, setSelected] = useState<SelectedSeg | null>(null)
  const [saving, setSaving] = useState(false)
  const [applying, setApplying] = useState(false)

  // Timeline view
  const [pxPerFrame, setPxPerFrame] = useState(2)
  const [editMode, setEditMode] = useState<EditMode>('select')
  const containerRef = useRef<HTMLDivElement>(null)

  // ── Remote SSH state ────────────────────────────────────────────────────────
  const [rCreds, setRCreds] = useState<SSHCreds>({ host: '', port: 22, username: '', password: '' })
  const [rConnected, setRConnected] = useState(false)
  const [rConnecting, setRConnecting] = useState(false)
  const [rPath, setRPath] = useState('/')
  const [rItems, setRItems] = useState<FileItem[]>([])
  const [rLoading, setRLoading] = useState(false)
  const [remoteFrameUrls, setRemoteFrameUrls] = useState<Record<string, string>>({})
  const frameReqRef = useRef(0)
  const rCredsRef = useRef(rCreds)
  useEffect(() => { rCredsRef.current = rCreds }, [rCreds])

  // Revoke blob URLs on unmount or source switch
  useEffect(() => () => {
    setRemoteFrameUrls(prev => { Object.values(prev).forEach(u => u && URL.revokeObjectURL(u)); return {} })
  }, [])
  useEffect(() => {
    if (dataSource !== 'remote') {
      setRemoteFrameUrls(prev => { Object.values(prev).forEach(u => u && URL.revokeObjectURL(u)); return {} })
    }
  }, [dataSource])

  const patchRCreds = (p: Partial<SSHCreds>) => setRCreds(prev => ({ ...prev, ...p }))

  // ── Remote connection ───────────────────────────────────────────────────────

  const handleConnect = async () => {
    if (!rCreds.host || !rCreds.username) return message.warning('请填写主机和用户名')
    setRConnecting(true)
    try {
      await testConnection(rCreds)
      setRConnected(true)
      await loadRemoteDir('/')
      message.success('连接成功')
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      message.error('连接失败: ' + (detail ?? String(err)))
    } finally {
      setRConnecting(false)
    }
  }

  const loadRemoteDir = async (path: string) => {
    setRLoading(true)
    try {
      const { items } = await listRemote(rCreds, path)
      setRPath(path)
      setRItems(items.filter(i => i.is_dir))
    } catch {
      message.error('浏览远程目录失败')
    } finally {
      setRLoading(false)
    }
  }

  // ── Load dataset ────────────────────────────────────────────────────────────

  const loadDataset = useCallback(async (item: FileItem, source: DataSource) => {
    setSelectedFile(item)
    setInfo(null)
    setEpisode(0)
    setCurrentFrame(0)
    setGroups([])
    setSelected(null)
    setImgErrors({})
    try {
      const d = source === 'remote'
        ? await getRemoteDatasetInfo(rCredsRef.current, item.path)
        : await getDatasetInfo(item.path)
      setInfo(d)
      const frames = d.episodes?.[0]?.length ?? d.n_frames
      setTotalFrames(frames)
      if (d.fps) setFps(Math.min(d.fps, 30))
      const initPx = clamp(800 / Math.max(frames, 1), MIN_PX_PER_FRAME, MAX_PX_PER_FRAME)
      setPxPerFrame(initPx)
      const r = await loadReward(item.path, 0)
      setGroups(r.groups)
    } catch {
      message.error('加载数据集失败')
    }
  }, [])

  const handleEpisodeChange = async (ep: number) => {
    if (!selectedFile) return
    setEpisode(ep)
    setCurrentFrame(0)
    setImgErrors({})
    setGroups([])
    setSelected(null)
    setRemoteFrameUrls(prev => { Object.values(prev).forEach(u => u && URL.revokeObjectURL(u)); return {} })
    const frames = info?.episodes?.find(e => e.episode_index === ep)?.length ?? info?.n_frames ?? 0
    setTotalFrames(frames)
    const initPx = clamp(800 / Math.max(frames, 1), MIN_PX_PER_FRAME, MAX_PX_PER_FRAME)
    setPxPerFrame(initPx)
    try {
      const r = await loadReward(selectedFile.path, ep)
      setGroups(r.groups)
    } catch { /* non-fatal */ }
  }

  // ── Remote frame fetching ───────────────────────────────────────────────────

  const cameras = useMemo(() => {
    if (!info) return []
    if (info.format === 'hdf5') {
      return (info.fields ?? []).filter(f => f.is_image)
        .map(f => ({ id: f.key, label: f.key.split('/').filter(Boolean).pop() ?? f.key }))
    }
    return (info.cameras ?? []).map(c => ({ id: c, label: c }))
  }, [info])

  useEffect(() => {
    if (dataSource !== 'remote' || !selectedFile || !rConnected || cameras.length === 0) return
    const reqId = ++frameReqRef.current
    Promise.all(
      cameras.map(cam =>
        fetchRemoteFrame(rCredsRef.current, selectedFile.path, episode, currentFrame, cam.id)
          .then(url => [cam.id, url] as const)
          .catch(() => [cam.id, ''] as const),
      ),
    ).then(entries => {
      if (frameReqRef.current !== reqId) {
        entries.forEach(([, u]) => u && URL.revokeObjectURL(u)); return
      }
      setRemoteFrameUrls(prev => {
        Object.values(prev).forEach(u => u && URL.revokeObjectURL(u))
        return Object.fromEntries(entries.filter(([, u]) => u))
      })
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataSource, currentFrame, episode, selectedFile?.path, rConnected, cameras])

  // ── Playback ────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current)
    if (!playing) return
    intervalRef.current = setInterval(() => {
      setCurrentFrame(prev => {
        if (prev >= totalFrames - 1) { setPlaying(false); return prev }
        return prev + 1
      })
    }, 1000 / fps)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [playing, fps, totalFrames])

  // ── Reward sum ──────────────────────────────────────────────────────────────

  const rewardSum = useMemo(
    () => computeRewardSum(groups, totalFrames),
    [groups, totalFrames],
  )

  // ── Group management ────────────────────────────────────────────────────────

  const addGroup = () => {
    const g: RewardGroup = {
      id: nanoid(), name: `Group ${groups.length + 1}`,
      color: GROUP_COLORS[groups.length % GROUP_COLORS.length],
      visible: true, segments: [],
    }
    setGroups(prev => [...prev, g])
  }

  const updateGroup = (id: string, patch: Partial<RewardGroup>) =>
    setGroups(prev => prev.map(g => g.id === id ? { ...g, ...patch } : g))

  const deleteGroup = (id: string) => {
    setGroups(prev => prev.filter(g => g.id !== id))
    if (selected?.groupId === id) setSelected(null)
  }

  // ── Segment management ──────────────────────────────────────────────────────

  const createSegment = (groupId: string, startFrame: number, endFrame: number) => {
    const seg: RewardSegment = {
      id: nanoid(), type: startFrame === endFrame ? 'point' : 'range',
      startFrame, endFrame, value: 1.0,
    }
    setGroups(prev => prev.map(g =>
      g.id === groupId ? { ...g, segments: [...g.segments, seg] } : g
    ))
    setSelected({ segId: seg.id, groupId })
  }

  const updateSegment = (groupId: string, segId: string, patch: Partial<RewardSegment>) =>
    setGroups(prev => prev.map(g =>
      g.id === groupId
        ? { ...g, segments: g.segments.map(s => s.id === segId ? { ...s, ...patch } : s) }
        : g
    ))

  const deleteSegment = (groupId: string, segId: string) => {
    setGroups(prev => prev.map(g =>
      g.id === groupId ? { ...g, segments: g.segments.filter(s => s.id !== segId) } : g
    ))
    setSelected(null)
  }

  const handleMoveHandle = (segId: string, groupId: string, edge: 'start' | 'end', frame: number) =>
    setGroups(prev => prev.map(g => {
      if (g.id !== groupId) return g
      return {
        ...g, segments: g.segments.map(s => {
          if (s.id !== segId) return s
          return edge === 'start'
            ? { ...s, startFrame: clamp(frame, 0, s.endFrame) }
            : { ...s, endFrame: clamp(frame, s.startFrame, totalFrames - 1) }
        }),
      }
    }))

  // ── Save / Apply ────────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!selectedFile) return
    setSaving(true)
    try {
      await saveReward(selectedFile.path, episode, groups)
      message.success('Reward 标注已保存')
    } catch {
      message.error('保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleApply = async () => {
    if (!selectedFile) return
    setApplying(true)
    try {
      const rewards = Array.from(rewardSum)
      if (dataSource === 'remote') {
        await applyRewardRemote(rCredsRef.current, selectedFile.path, episode, rewards)
      } else {
        await applyRewardToDataset(selectedFile.path, episode, rewards)
      }
      message.success('reward 字段已写入数据集 parquet')
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      message.error(detail ?? '写入失败')
    } finally {
      setApplying(false)
    }
  }

  // ── Keyboard ────────────────────────────────────────────────────────────────

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selected) deleteSegment(selected.groupId, selected.segId)
    }
    if (e.key === ' ') { e.preventDefault(); setPlaying(p => !p) }
    if (e.key === 'ArrowRight') setCurrentFrame(p => Math.min(p + 1, totalFrames - 1))
    if (e.key === 'ArrowLeft') setCurrentFrame(p => Math.max(p - 1, 0))
  }

  // ── Derived ─────────────────────────────────────────────────────────────────

  const selectedSeg = selected
    ? groups.find(g => g.id === selected.groupId)?.segments.find(s => s.id === selected.segId)
    : null

  const episodeItems = useMemo(() => {
    if (!info) return []
    if (info.episodes?.length) return info.episodes
    return Array.from({ length: info.n_episodes }, (_, i) => ({ episode_index: i, length: 0 }))
  }, [info])

  const camCols = cameras.length <= 1 ? 1 : cameras.length <= 4 ? 2 : 3

  const camUrl = (camId: string) => {
    if (dataSource === 'remote') return remoteFrameUrls[camId] ?? ''
    if (!selectedFile) return ''
    return getFrameUrl(selectedFile.path, episode, currentFrame, camId)
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div tabIndex={0} onKeyDown={handleKeyDown} style={{ outline: 'none' }}>
      <Title level={4} style={{ marginBottom: 16 }}>Reward 标注</Title>

      {/* Data source toggle */}
      <Form layout="inline" style={{ marginBottom: 12 }}>
        <Form.Item label="数据来源">
          <Radio.Group
            value={dataSource}
            onChange={e => {
              setDataSource(e.target.value)
              setSelectedFile(null); setInfo(null); setGroups([])
              setRConnected(false)
            }}
          >
            <Radio.Button value="local">本地</Radio.Button>
            <Radio.Button value="remote">远程服务器</Radio.Button>
          </Radio.Group>
        </Form.Item>
      </Form>

      <Row gutter={16} style={{ marginBottom: 16 }}>
        {/* ── Left: dataset selector ── */}
        <Col span={6}>
          {dataSource === 'local' ? (
            <FileBrowser
              title="选择 LeRobot 目录"
              dirOnly
              onSelect={(_, items) => { if (items[0]) loadDataset(items[0], 'local') }}
            />
          ) : (
            /* Remote SSH form + browser */
            <div>
              <Form layout="vertical" size="small" style={{ marginBottom: 8 }}>
                <Form.Item label="主机 IP">
                  <Input value={rCreds.host}
                    onChange={e => patchRCreds({ host: e.target.value })}
                    placeholder="192.168.1.100" disabled={rConnected} />
                </Form.Item>
                <Form.Item label="端口">
                  <InputNumber value={rCreds.port ?? 22}
                    onChange={v => patchRCreds({ port: v ?? 22 })}
                    style={{ width: '100%' }} disabled={rConnected} />
                </Form.Item>
                <Form.Item label="用户名">
                  <Input value={rCreds.username}
                    onChange={e => patchRCreds({ username: e.target.value })}
                    disabled={rConnected} />
                </Form.Item>
                <Form.Item label="密码">
                  <Input.Password value={rCreds.password ?? ''}
                    onChange={e => patchRCreds({ password: e.target.value })}
                    disabled={rConnected} />
                </Form.Item>
                <Form.Item>
                  {rConnected ? (
                    <Space>
                      <Tag color="green">已连接</Tag>
                      <Button size="small" onClick={() => {
                        setRConnected(false); setRItems([])
                        setSelectedFile(null); setInfo(null)
                      }}>断开</Button>
                    </Space>
                  ) : (
                    <Button type="primary" loading={rConnecting} onClick={handleConnect} block>
                      连接
                    </Button>
                  )}
                </Form.Item>
              </Form>

              {rConnected && (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
                    {rPath !== '/' && (
                      <Button size="small" icon={<ArrowLeftOutlined />}
                        onClick={() => loadRemoteDir(parentPath(rPath))} />
                    )}
                    <Text ellipsis style={{ flex: 1, fontSize: 11, color: '#888' }}>{rPath}</Text>
                    <Tooltip title="选择当前目录作为 LeRobot 数据集">
                      <Button size="small" type="primary" onClick={() => {
                        const item: FileItem = {
                          name: rPath.split('/').pop() || rPath,
                          path: rPath, is_dir: true, size: null, mtime: 0, ext: null,
                        }
                        loadDataset(item, 'remote')
                      }}>选择</Button>
                    </Tooltip>
                  </div>
                  {rLoading ? (
                    <div style={{ textAlign: 'center', padding: 12 }}><Spin size="small" /></div>
                  ) : (
                    <div style={{
                      maxHeight: 300, overflowY: 'auto',
                      border: '1px solid #d9d9d9', borderRadius: 6,
                    }}>
                      {rItems.length === 0
                        ? <div style={{ padding: '8px 10px', color: '#999', fontSize: 12 }}>无目录</div>
                        : rItems.map(item => (
                          <div key={item.path}
                            style={{
                              padding: '6px 10px', cursor: 'pointer', fontSize: 13,
                              display: 'flex', alignItems: 'center', gap: 6,
                              background: selectedFile?.path === item.path ? '#e6f4ff' : 'transparent',
                              whiteSpace: 'nowrap',
                            }}
                            onClick={() => item.is_dir ? loadRemoteDir(item.path) : undefined}
                          >
                            {item.is_dir
                              ? <FolderOutlined style={{ color: '#faad14', flexShrink: 0 }} />
                              : <FileOutlined style={{ flexShrink: 0 }} />}
                            <span>{item.name}</span>
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {info && (
            <div style={{ marginTop: 8 }}>
              <Tag color="blue">{info.format.toUpperCase()}</Tag>
              <Tag>{info.n_episodes} episodes</Tag>
              <Tag>{info.n_frames} 帧</Tag>
            </div>
          )}
        </Col>

        {/* ── Right: video player + episode list ── */}
        <Col span={18}>
          {!selectedFile ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#999' }}>
              请在左侧选择 LeRobot 数据集
            </div>
          ) : !info ? (
            <div style={{ padding: 40, textAlign: 'center' }}><Spin /></div>
          ) : (
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              {/* Episode list */}
              {episodeItems.length > 1 && (
                <div style={{ width: 140, flexShrink: 0 }}>
                  <div style={{ fontWeight: 500, marginBottom: 6, fontSize: 13 }}>Episodes</div>
                  <div style={{ maxHeight: 500, overflowY: 'auto', border: '1px solid #d9d9d9', borderRadius: 6 }}>
                    {episodeItems.map(ep => (
                      <div key={ep.episode_index}
                        style={{
                          padding: '7px 10px', cursor: 'pointer', fontSize: 12,
                          background: episode === ep.episode_index ? '#e6f4ff' : 'transparent',
                          borderBottom: '1px solid #f0f0f0',
                          borderLeft: episode === ep.episode_index ? '3px solid #1677ff' : '3px solid transparent',
                        }}
                        onClick={() => handleEpisodeChange(ep.episode_index)}
                      >
                        <div style={{ fontWeight: 500 }}>Ep {String(ep.episode_index).padStart(3, '0')}</div>
                        {ep.length > 0 && <div style={{ fontSize: 11, color: '#888' }}>{ep.length} 帧</div>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Main content */}
              <div style={{ flex: 1, minWidth: 0 }}>
                {/* Camera grid */}
                {cameras.length > 0 ? (
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: `repeat(${camCols}, 1fr)`,
                    gap: 8, marginBottom: 8,
                  }}>
                    {cameras.map(cam => {
                      const url = camUrl(cam.id)
                      const loading = dataSource === 'remote' && !url && !imgErrors[cam.id]
                      return (
                        <div key={cam.id} style={{ textAlign: 'center' }}>
                          {loading ? (
                            <div style={{
                              height: camCols === 1 ? 260 : 160,
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              border: '1px solid #d9d9d9', borderRadius: 4,
                            }}><Spin size="small" /></div>
                          ) : !imgErrors[cam.id] && url ? (
                            <img src={url} alt={cam.label} style={{
                              width: '100%', maxHeight: camCols === 1 ? 260 : 160,
                              objectFit: 'contain', border: '1px solid #d9d9d9',
                              borderRadius: 4, background: '#000',
                            }} onError={() => setImgErrors(p => ({ ...p, [cam.id]: true }))} />
                          ) : (
                            <div style={{
                              height: camCols === 1 ? 260 : 160,
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              border: '1px dashed #d9d9d9', borderRadius: 4, color: '#999',
                            }}>无图像</div>
                          )}
                          <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>{cam.label}</div>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <div style={{
                    height: 100, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    border: '1px dashed #d9d9d9', borderRadius: 4, color: '#999', marginBottom: 8,
                  }}>无摄像头图像</div>
                )}

                {/* Playback controls */}
                <Space style={{ width: '100%', justifyContent: 'center', marginBottom: 4 }}>
                  <Button size="small" icon={<StepBackwardOutlined />}
                    onClick={() => setCurrentFrame(p => Math.max(0, p - 1))} />
                  <Button size="small" icon={playing ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                    type="primary" onClick={() => setPlaying(p => !p)} />
                  <Button size="small" icon={<StepForwardOutlined />}
                    onClick={() => setCurrentFrame(p => Math.min(totalFrames - 1, p + 1))} />
                  <Text type="secondary" style={{ fontSize: 12 }}>帧 {currentFrame} / {totalFrames - 1}</Text>
                  <span style={{ fontSize: 12 }}>FPS:</span>
                  <InputNumber min={1} max={60} value={fps} onChange={v => setFps(v ?? 10)}
                    size="small" style={{ width: 56 }} />
                </Space>

                <Slider min={0} max={Math.max(0, totalFrames - 1)} value={currentFrame}
                  onChange={v => { setPlaying(false); setCurrentFrame(v) }}
                  tooltip={{ formatter: v => `帧 ${v}` }}
                  style={{ marginBottom: 4 }} />
              </div>
            </div>
          )}
        </Col>
      </Row>

      {/* ── Timeline ── */}
      {info && totalFrames > 0 && (
        <div style={{ border: '1px solid #e8e8e8', borderRadius: 6, overflow: 'hidden' }}>
          {/* Toolbar */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '6px 12px', background: '#f5f5f5', borderBottom: '1px solid #e8e8e8',
          }}>
            <Text style={{ fontSize: 12, color: '#666' }}>模式：</Text>
            {(['select', 'range', 'point'] as EditMode[]).map(m => (
              <Button key={m} size="small" type={editMode === m ? 'primary' : 'default'}
                onClick={() => setEditMode(m)}>
                {m === 'select' ? '选择' : m === 'range' ? '区间' : '单帧'}
              </Button>
            ))}
            <div style={{ flex: 1 }} />
            <Tooltip title="缩小">
              <Button size="small" icon={<ZoomOutOutlined />}
                onClick={() => setPxPerFrame(p => clamp(p / 1.5, MIN_PX_PER_FRAME, MAX_PX_PER_FRAME))} />
            </Tooltip>
            <Text style={{ fontSize: 11, color: '#999', minWidth: 48, textAlign: 'center' }}>
              {pxPerFrame.toFixed(1)}px/帧
            </Text>
            <Tooltip title="放大">
              <Button size="small" icon={<ZoomInOutlined />}
                onClick={() => setPxPerFrame(p => clamp(p * 1.5, MIN_PX_PER_FRAME, MAX_PX_PER_FRAME))} />
            </Tooltip>
            <Button size="small" onClick={() => {
              const w = containerRef.current?.clientWidth ?? 800
              setPxPerFrame(clamp((w - SIDEBAR_W) / Math.max(totalFrames, 1), MIN_PX_PER_FRAME, MAX_PX_PER_FRAME))
            }}>适应</Button>
          </div>

          <div style={{ display: 'flex' }} ref={containerRef}>
            {/* Group sidebar */}
            <div style={{ width: SIDEBAR_W, flexShrink: 0, borderRight: '1px solid #e8e8e8', background: '#fafafa' }}>
              <div style={{ height: RULER_H, borderBottom: '1px solid #e8e8e8', background: '#f0f0f0' }} />
              <div style={{
                height: CURVE_H, display: 'flex', alignItems: 'center',
                paddingLeft: 8, fontSize: 11, color: '#666', borderBottom: '1px solid #e8e8e8',
              }}>Reward Sum</div>
              {groups.map((g, gi) => (
                <div key={g.id} style={{
                  height: TRACK_H, display: 'flex', alignItems: 'center',
                  padding: '0 4px 0 8px', borderBottom: '1px solid #e8e8e8',
                  background: gi % 2 === 0 ? '#fff' : '#fafafa', gap: 4, overflow: 'hidden',
                }}>
                  <input type="color" value={g.color}
                    onChange={e => updateGroup(g.id, { color: e.target.value })}
                    style={{ width: 18, height: 18, border: 'none', padding: 0, cursor: 'pointer', background: 'none' }} />
                  <input value={g.name} onChange={e => updateGroup(g.id, { name: e.target.value })}
                    style={{
                      flex: 1, minWidth: 0, fontSize: 11, border: '1px solid transparent',
                      borderRadius: 3, padding: '1px 3px', background: 'transparent', color: '#333',
                    }}
                    onFocus={e => (e.target.style.borderColor = '#1890ff')}
                    onBlur={e => (e.target.style.borderColor = 'transparent')} />
                  <Button type="text" size="small" style={{ padding: 0, minWidth: 18, color: g.visible ? '#1890ff' : '#ccc' }}
                    icon={g.visible ? <EyeOutlined /> : <EyeInvisibleOutlined />}
                    onClick={() => updateGroup(g.id, { visible: !g.visible })} />
                  <Popconfirm title="删除该 reward 组？" onConfirm={() => deleteGroup(g.id)} okText="删除" cancelText="取消">
                    <Button type="text" size="small" danger style={{ padding: 0, minWidth: 18 }}
                      icon={<DeleteOutlined style={{ fontSize: 11 }} />} />
                  </Popconfirm>
                </div>
              ))}
              <div style={{ height: 36, display: 'flex', alignItems: 'center', paddingLeft: 8 }}>
                <Button size="small" icon={<PlusOutlined />} onClick={addGroup} type="dashed" style={{ fontSize: 11 }}>
                  添加组
                </Button>
              </div>
            </div>

            {/* Scrollable timeline */}
            <div style={{ flex: 1, overflowX: 'auto', overflowY: 'hidden' }}>
              <Timeline
                totalFrames={totalFrames} currentFrame={currentFrame}
                groups={groups} rewardSum={rewardSum} pxPerFrame={pxPerFrame}
                editMode={editMode} selectedSegId={selected?.segId ?? null}
                onSeek={f => { setPlaying(false); setCurrentFrame(f) }}
                onCreateSegment={createSegment}
                onSelectSegment={(segId, groupId) => setSelected(segId && groupId ? { segId, groupId } : null)}
                onMoveHandle={handleMoveHandle}
              />
            </div>
          </div>

          {/* Segment properties */}
          {selectedSeg && selected && (
            <div style={{
              padding: '8px 16px', borderTop: '1px solid #e8e8e8', background: '#fff',
              display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
            }}>
              <Text style={{ fontSize: 12, color: '#666' }}>
                已选: <b>{groups.find(g => g.id === selected.groupId)?.name}</b>
                {' '}{selectedSeg.type === 'point' ? `帧 ${selectedSeg.startFrame}` : `帧 ${selectedSeg.startFrame} – ${selectedSeg.endFrame}`}
              </Text>
              <Space align="center">
                <Text style={{ fontSize: 12 }}>Reward：</Text>
                <Slider min={-1} max={1} step={0.05} value={selectedSeg.value}
                  onChange={v => updateSegment(selected.groupId, selected.segId, { value: v })}
                  style={{ width: 140 }} />
                <InputNumber min={-1} max={1} step={0.05} value={selectedSeg.value}
                  onChange={v => updateSegment(selected.groupId, selected.segId, { value: v ?? 0 })}
                  style={{ width: 72 }} size="small" />
              </Space>
              {selectedSeg.type === 'range' && (
                <Space>
                  <Text style={{ fontSize: 12 }}>起止帧：</Text>
                  <InputNumber min={0} max={selectedSeg.endFrame} value={selectedSeg.startFrame}
                    onChange={v => updateSegment(selected.groupId, selected.segId, { startFrame: v ?? 0 })}
                    size="small" style={{ width: 64 }} />
                  <MinusOutlined style={{ fontSize: 10, color: '#999' }} />
                  <InputNumber min={selectedSeg.startFrame} max={totalFrames - 1} value={selectedSeg.endFrame}
                    onChange={v => updateSegment(selected.groupId, selected.segId, { endFrame: v ?? 0 })}
                    size="small" style={{ width: 64 }} />
                </Space>
              )}
              <Button size="small" danger icon={<DeleteOutlined />}
                onClick={() => deleteSegment(selected.groupId, selected.segId)}>删除</Button>
              <Text style={{ fontSize: 11, color: '#999' }}>Del 键快速删除</Text>
            </div>
          )}
        </div>
      )}

      {/* Footer buttons */}
      {info && (
        <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Tooltip title="保存标注草稿（reward 组配置），不修改数据集文件">
            <Button icon={<SaveOutlined />} loading={saving} onClick={handleSave} disabled={!selectedFile}>
              保存草稿
            </Button>
          </Tooltip>
          <Tooltip title={`将 reward 求和结果写入${dataSource === 'remote' ? '远程' : '本地'} parquet，作为 reward 字段与 action/observation 并列`}>
            <Popconfirm
              title="写入数据集"
              description={`将 episode ${episode} 的 ${totalFrames} 帧 reward 写入 parquet，会覆盖已有 reward 列。确认继续？`}
              onConfirm={handleApply} okText="写入" cancelText="取消"
            >
              <Button type="primary" icon={<DatabaseOutlined />} loading={applying}
                disabled={!selectedFile || groups.length === 0}>
                写入数据集{dataSource === 'remote' ? '（远程）' : ''}
              </Button>
            </Popconfirm>
          </Tooltip>
        </div>
      )}
    </div>
  )
}
