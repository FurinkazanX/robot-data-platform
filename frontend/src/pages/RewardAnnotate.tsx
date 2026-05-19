import {
  useCallback, useEffect, useMemo, useRef, useState, KeyboardEvent,
} from 'react'
import {
  Button, Col, Form, InputNumber, Popconfirm, Row, Select, Slider,
  Space, Spin, Tag, Tooltip, Typography, message,
} from 'antd'
import {
  DatabaseOutlined, DeleteOutlined, EyeInvisibleOutlined, EyeOutlined,
  MinusOutlined, PauseCircleOutlined, PlayCircleOutlined,
  PlusOutlined, SaveOutlined, StepBackwardOutlined, StepForwardOutlined,
  ZoomInOutlined, ZoomOutOutlined,
} from '@ant-design/icons'
import FileBrowser from '../components/FileBrowser'
import {
  getDatasetInfo, getFrameUrl, loadReward, saveReward, applyRewardToDataset,
  type DatasetInfo, type FileItem, type RewardGroup, type RewardSegment,
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

interface DragState {
  type: 'creating'
  groupId: string
  startFrame: number
  endFrame: number
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function nanoid() {
  return Math.random().toString(36).slice(2, 10)
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v))
}

/** Compute per-frame reward sum from all visible groups */
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

/** Build SVG polyline points string for the reward curve */
function buildCurvePath(
  rewards: Float32Array,
  pxPerFrame: number,
  height: number,
  minR: number,
  maxR: number,
): string {
  if (rewards.length === 0) return ''
  const range = maxR - minR || 1
  const pts: string[] = []
  // Downsample: at most 1 point per 2px
  const step = Math.max(1, Math.round(2 / pxPerFrame))
  for (let f = 0; f < rewards.length; f += step) {
    const x = (f + 0.5) * pxPerFrame
    const y = height - ((rewards[f] - minR) / range) * (height - 4) - 2
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`)
  }
  // always include last frame
  const last = rewards.length - 1
  pts.push(`${((last + 0.5) * pxPerFrame).toFixed(1)},${(height - ((rewards[last] - minR) / range) * (height - 4) - 2).toFixed(1)}`)
  return pts.join(' ')
}

// ── Sub-components ────────────────────────────────────────────────────────────

interface TimelineProps {
  totalFrames: number
  currentFrame: number
  groups: RewardGroup[]
  rewardSum: Float32Array
  pxPerFrame: number
  editMode: EditMode
  selectedSegId: string | null
  dragState: DragState | null
  onSeek: (f: number) => void
  onCreateSegment: (groupId: string, startFrame: number, endFrame: number) => void
  onSelectSegment: (segId: string | null, groupId?: string) => void
  onMoveHandle: (segId: string, groupId: string, edge: 'start' | 'end', frame: number) => void
  containerRef: React.RefObject<HTMLDivElement>
}

function Timeline({
  totalFrames, currentFrame, groups, rewardSum,
  pxPerFrame, editMode, selectedSegId, dragState,
  onSeek, onCreateSegment, onSelectSegment, onMoveHandle,
  containerRef,
}: TimelineProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [resizeDrag, setResizeDrag] = useState<{
    segId: string; groupId: string; edge: 'start' | 'end'
  } | null>(null)
  const [dragInternal, setDragInternal] = useState<DragState | null>(null)
  const activeDrag = dragState ?? dragInternal

  const svgWidth = Math.max(totalFrames * pxPerFrame, 1)
  const numGroups = groups.length
  const svgHeight = RULER_H + CURVE_H + numGroups * TRACK_H + 8

  const minR = Math.min(0, ...Array.from(rewardSum))
  const maxR = Math.max(0, ...Array.from(rewardSum))
  const curvePts = useMemo(
    () => buildCurvePath(rewardSum, pxPerFrame, CURVE_H, minR, maxR),
    [rewardSum, pxPerFrame, minR, maxR],
  )

  const frameAtX = (clientX: number) => {
    if (!svgRef.current || !containerRef.current) return 0
    const rect = svgRef.current.getBoundingClientRect()
    return clamp(Math.round((clientX - rect.left) / pxPerFrame), 0, totalFrames - 1)
  }

  const groupAtY = (clientY: number): string | null => {
    if (!svgRef.current) return null
    const rect = svgRef.current.getBoundingClientRect()
    const y = clientY - rect.top
    const trackTop = RULER_H + CURVE_H
    const idx = Math.floor((y - trackTop) / TRACK_H)
    if (idx >= 0 && idx < groups.length) return groups[idx].id
    return null
  }

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    const frame = frameAtX(e.clientX)

    if (editMode === 'select') {
      onSeek(frame)
      return
    }

    const gid = groupAtY(e.clientY)
    if (!gid) { onSeek(frame); return }

    if (editMode === 'point') {
      onCreateSegment(gid, frame, frame)
      return
    }

    // range: start drag
    setDragInternal({ type: 'creating', groupId: gid, startFrame: frame, endFrame: frame })
    e.preventDefault()
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (resizeDrag) {
      const frame = frameAtX(e.clientX)
      onMoveHandle(resizeDrag.segId, resizeDrag.groupId, resizeDrag.edge, frame)
      return
    }
    if (!dragInternal) return
    const frame = frameAtX(e.clientX)
    setDragInternal(d => d ? { ...d, endFrame: frame } : d)
  }

  const handleMouseUp = () => {
    if (resizeDrag) {
      setResizeDrag(null)
      return
    }
    if (dragInternal) {
      const s = Math.min(dragInternal.startFrame, dragInternal.endFrame)
      const en = Math.max(dragInternal.startFrame, dragInternal.endFrame)
      if (en > s) onCreateSegment(dragInternal.groupId, s, en)
      setDragInternal(null)
    }
  }

  // render ruler ticks
  const rulerTicks = useMemo(() => {
    const ticks: JSX.Element[] = []
    // pick step so ~8-12 ticks fit
    const approxTicks = 10
    const rawStep = totalFrames / approxTicks
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
      {/* Background */}
      <rect width={svgWidth} height={svgHeight} fill="#fafafa" />

      {/* Ruler */}
      <rect width={svgWidth} height={RULER_H} fill="#f0f0f0" />
      {rulerTicks}

      {/* Curve area background */}
      <rect y={RULER_H} width={svgWidth} height={CURVE_H} fill="#fff" stroke="#e8e8e8" strokeWidth={1} />

      {/* Zero line */}
      {minR < 0 && maxR > 0 && (() => {
        const range = maxR - minR
        const zy = RULER_H + CURVE_H - ((-minR) / range) * (CURVE_H - 4) - 2
        return <line x1={0} y1={zy} x2={svgWidth} y2={zy} stroke="#ddd" strokeWidth={1} strokeDasharray="4,2" />
      })()}

      {/* Reward sum curve */}
      {curvePts && (
        <polyline
          points={curvePts}
          fill="none"
          stroke="#1890ff"
          strokeWidth={1.5}
          transform={`translate(0,${RULER_H})`}
        />
      )}

      {/* Curve area label */}
      <text x={4} y={RULER_H + 14} fontSize={10} fill="#999">Reward Sum</text>

      {/* Group tracks */}
      {groups.map((g, gi) => {
        const trackY = RULER_H + CURVE_H + gi * TRACK_H
        return (
          <g key={g.id}>
            <rect
              y={trackY}
              width={svgWidth}
              height={TRACK_H}
              fill={gi % 2 === 0 ? '#fff' : '#fafafa'}
              stroke="#e8e8e8"
              strokeWidth={1}
            />

            {/* Segments */}
            {g.segments.map(seg => {
              const sx = seg.startFrame * pxPerFrame
              const ex = (seg.endFrame + 1) * pxPerFrame
              const w = Math.max(ex - sx, 2)
              const isSelected = seg.id === selectedSegId
              const isPoint = seg.type === 'point'
              const segAlpha = g.visible ? 1 : 0.3

              return (
                <g key={seg.id} opacity={segAlpha}>
                  {isPoint ? (
                    <>
                      <line
                        x1={sx + pxPerFrame / 2}
                        y1={trackY + 4}
                        x2={sx + pxPerFrame / 2}
                        y2={trackY + TRACK_H - 4}
                        stroke={g.color}
                        strokeWidth={isSelected ? 3 : 2}
                      />
                      <polygon
                        points={`${sx + pxPerFrame / 2},${trackY + 6} ${sx + pxPerFrame / 2 - 5},${trackY + 14} ${sx + pxPerFrame / 2 + 5},${trackY + 14}`}
                        fill={g.color}
                        stroke={isSelected ? '#ff4d4f' : 'none'}
                        strokeWidth={1.5}
                        style={{ cursor: 'pointer' }}
                        onClick={e => { e.stopPropagation(); onSelectSegment(seg.id, g.id) }}
                      />
                    </>
                  ) : (
                    <>
                      <rect
                        x={sx}
                        y={trackY + 4}
                        width={w}
                        height={TRACK_H - 8}
                        rx={3}
                        fill={g.color}
                        fillOpacity={0.35}
                        stroke={isSelected ? '#ff4d4f' : g.color}
                        strokeWidth={isSelected ? 2 : 1}
                        style={{ cursor: 'pointer' }}
                        onClick={e => { e.stopPropagation(); onSelectSegment(seg.id, g.id) }}
                      />
                      {/* Value label */}
                      {w > 30 && (
                        <text
                          x={sx + w / 2}
                          y={trackY + TRACK_H / 2 + 4}
                          textAnchor="middle"
                          fontSize={11}
                          fill={g.color}
                          style={{ pointerEvents: 'none', userSelect: 'none' }}
                        >
                          {seg.value.toFixed(2)}
                        </text>
                      )}
                      {/* Resize handles */}
                      {isSelected && (
                        <>
                          <rect
                            x={sx - 4}
                            y={trackY + 4}
                            width={8}
                            height={TRACK_H - 8}
                            rx={2}
                            fill="#ff4d4f"
                            style={{ cursor: 'ew-resize' }}
                            onMouseDown={e => {
                              e.stopPropagation()
                              setResizeDrag({ segId: seg.id, groupId: g.id, edge: 'start' })
                            }}
                          />
                          <rect
                            x={sx + w - 4}
                            y={trackY + 4}
                            width={8}
                            height={TRACK_H - 8}
                            rx={2}
                            fill="#ff4d4f"
                            style={{ cursor: 'ew-resize' }}
                            onMouseDown={e => {
                              e.stopPropagation()
                              setResizeDrag({ segId: seg.id, groupId: g.id, edge: 'end' })
                            }}
                          />
                        </>
                      )}
                    </>
                  )}
                </g>
              )
            })}

            {/* In-progress drag preview */}
            {activeDrag && activeDrag.groupId === g.id && activeDrag.type === 'creating' && (() => {
              const ds = Math.min(activeDrag.startFrame, activeDrag.endFrame) * pxPerFrame
              const dw = Math.max((Math.abs(activeDrag.endFrame - activeDrag.startFrame) + 1) * pxPerFrame, 2)
              return (
                <rect
                  x={ds}
                  y={trackY + 4}
                  width={dw}
                  height={TRACK_H - 8}
                  rx={3}
                  fill={g.color}
                  fillOpacity={0.5}
                  stroke={g.color}
                  strokeWidth={1}
                  strokeDasharray="4,2"
                  style={{ pointerEvents: 'none' }}
                />
              )
            })()}
          </g>
        )
      })}

      {/* Playhead */}
      <line
        x1={currentFrame * pxPerFrame + pxPerFrame / 2}
        y1={0}
        x2={currentFrame * pxPerFrame + pxPerFrame / 2}
        y2={svgHeight}
        stroke="#ff4d4f"
        strokeWidth={1.5}
        style={{ pointerEvents: 'none' }}
      />
      <polygon
        points={`${currentFrame * pxPerFrame - 5},0 ${currentFrame * pxPerFrame + pxPerFrame / 2 + 5},0 ${currentFrame * pxPerFrame + pxPerFrame / 2},10`}
        fill="#ff4d4f"
        style={{ pointerEvents: 'none' }}
      />
    </svg>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

interface SelectedSeg {
  segId: string
  groupId: string
}

export default function RewardAnnotate() {
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

  // ── Load dataset ────────────────────────────────────────────────────────────

  const loadDataset = useCallback(async (item: FileItem) => {
    setSelectedFile(item)
    setInfo(null)
    setEpisode(0)
    setCurrentFrame(0)
    setGroups([])
    setSelected(null)
    setImgErrors({})
    try {
      const d = await getDatasetInfo(item.path)
      setInfo(d)
      const frames = d.episodes?.[0]?.length ?? d.n_frames
      setTotalFrames(frames)
      if (d.fps) setFps(Math.min(d.fps, 30))
      // fit all frames in ~800px
      const initPx = clamp(800 / frames, MIN_PX_PER_FRAME, MAX_PX_PER_FRAME)
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
    const frames = info?.episodes?.find(e => e.episode_index === ep)?.length ?? info?.n_frames ?? 0
    setTotalFrames(frames)
    const initPx = clamp(800 / Math.max(frames, 1), MIN_PX_PER_FRAME, MAX_PX_PER_FRAME)
    setPxPerFrame(initPx)
    try {
      const r = await loadReward(selectedFile.path, ep)
      setGroups(r.groups)
    } catch {
      message.error('加载 reward 失败')
    }
  }

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

  // ── Computed reward sum ─────────────────────────────────────────────────────

  const rewardSum = useMemo(
    () => computeRewardSum(groups, totalFrames),
    [groups, totalFrames],
  )

  // ── Camera list ─────────────────────────────────────────────────────────────

  const cameras = useMemo(() => {
    if (!info) return []
    if (info.format === 'hdf5') {
      return (info.fields ?? [])
        .filter(f => f.is_image)
        .map(f => ({ id: f.key, label: f.key.split('/').filter(Boolean).pop() ?? f.key }))
    }
    return (info.cameras ?? []).map(c => ({ id: c, label: c }))
  }, [info])

  // ── Group management ────────────────────────────────────────────────────────

  const addGroup = () => {
    const idx = groups.length % GROUP_COLORS.length
    const g: RewardGroup = {
      id: nanoid(),
      name: `Group ${groups.length + 1}`,
      color: GROUP_COLORS[idx],
      visible: true,
      segments: [],
    }
    setGroups(prev => [...prev, g])
  }

  const updateGroup = (id: string, patch: Partial<RewardGroup>) => {
    setGroups(prev => prev.map(g => g.id === id ? { ...g, ...patch } : g))
  }

  const deleteGroup = (id: string) => {
    setGroups(prev => prev.filter(g => g.id !== id))
    if (selected?.groupId === id) setSelected(null)
  }

  // ── Segment management ──────────────────────────────────────────────────────

  const createSegment = (groupId: string, startFrame: number, endFrame: number) => {
    const seg: RewardSegment = {
      id: nanoid(),
      type: startFrame === endFrame ? 'point' : 'range',
      startFrame,
      endFrame,
      value: 1.0,
    }
    setGroups(prev => prev.map(g =>
      g.id === groupId ? { ...g, segments: [...g.segments, seg] } : g
    ))
    setSelected({ segId: seg.id, groupId })
  }

  const updateSegment = (groupId: string, segId: string, patch: Partial<RewardSegment>) => {
    setGroups(prev => prev.map(g =>
      g.id === groupId
        ? { ...g, segments: g.segments.map(s => s.id === segId ? { ...s, ...patch } : s) }
        : g
    ))
  }

  const deleteSegment = (groupId: string, segId: string) => {
    setGroups(prev => prev.map(g =>
      g.id === groupId ? { ...g, segments: g.segments.filter(s => s.id !== segId) } : g
    ))
    setSelected(null)
  }

  const handleMoveHandle = (segId: string, groupId: string, edge: 'start' | 'end', frame: number) => {
    setGroups(prev => prev.map(g => {
      if (g.id !== groupId) return g
      return {
        ...g, segments: g.segments.map(s => {
          if (s.id !== segId) return s
          if (edge === 'start') {
            const sf = clamp(frame, 0, s.endFrame)
            return { ...s, startFrame: sf }
          } else {
            const ef = clamp(frame, s.startFrame, totalFrames - 1)
            return { ...s, endFrame: ef }
          }
        }),
      }
    }))
  }

  // ── Save ────────────────────────────────────────────────────────────────────

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
      await applyRewardToDataset(selectedFile.path, episode, rewards)
      message.success('reward 字段已写入数据集 parquet')
    } catch (e: any) {
      message.error(e?.response?.data?.detail ?? '写入失败')
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

  // ── Selected segment data ───────────────────────────────────────────────────

  const selectedSeg = selected
    ? groups.find(g => g.id === selected.groupId)?.segments.find(s => s.id === selected.segId)
    : null

  const camCols = cameras.length <= 1 ? 1 : cameras.length <= 4 ? 2 : 3

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div
      tabIndex={0}
      onKeyDown={handleKeyDown}
      style={{ outline: 'none' }}
    >
      <Title level={4} style={{ marginBottom: 16 }}>Reward 标注</Title>

      <Row gutter={16} style={{ marginBottom: 16 }}>
        {/* Dataset selector */}
        <Col span={6}>
          <FileBrowser
            title="选择 LeRobot 目录"
            dirOnly
            onSelect={(_, items) => { if (items[0]) loadDataset(items[0]) }}
          />
          {info && (
            <div style={{ marginTop: 8 }}>
              <Tag color="blue">{info.format.toUpperCase()}</Tag>
              <Tag>{info.n_episodes} episodes</Tag>
              <Tag>{info.n_frames} 帧</Tag>
            </div>
          )}
          {info && info.n_episodes > 1 && (
            <Form.Item label="Episode" style={{ marginTop: 8 }}>
              <Select
                value={episode}
                onChange={handleEpisodeChange}
                style={{ width: '100%' }}
                options={(info.episodes ?? Array.from({ length: info.n_episodes }, (_, i) => ({ episode_index: i, length: 0 }))).map(e => ({
                  label: `Episode ${e.episode_index}`,
                  value: e.episode_index,
                }))}
              />
            </Form.Item>
          )}
        </Col>

        {/* Video player */}
        <Col span={18}>
          {!selectedFile ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#999' }}>请在左侧选择 LeRobot 数据集</div>
          ) : !info ? (
            <div style={{ padding: 40, textAlign: 'center' }}><Spin /></div>
          ) : (
            <>
              {/* Camera grid */}
              {cameras.length > 0 ? (
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: `repeat(${camCols}, 1fr)`,
                  gap: 8,
                  marginBottom: 8,
                }}>
                  {cameras.map(cam => {
                    const url = getFrameUrl(selectedFile.path, episode, currentFrame, cam.id)
                    return (
                      <div key={cam.id} style={{ textAlign: 'center' }}>
                        {!imgErrors[cam.id] ? (
                          <img
                            src={url}
                            alt={cam.label}
                            style={{
                              width: '100%',
                              maxHeight: camCols === 1 ? 280 : 180,
                              objectFit: 'contain',
                              border: '1px solid #d9d9d9',
                              borderRadius: 4,
                              background: '#000',
                            }}
                            onError={() => setImgErrors(p => ({ ...p, [cam.id]: true }))}
                          />
                        ) : (
                          <div style={{
                            height: camCols === 1 ? 280 : 180,
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
                  height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  border: '1px dashed #d9d9d9', borderRadius: 4, color: '#999', marginBottom: 8,
                }}>无摄像头图像</div>
              )}

              {/* Playback controls */}
              <Space style={{ width: '100%', justifyContent: 'center', marginBottom: 4 }}>
                <Button size="small" icon={<StepBackwardOutlined />} onClick={() => setCurrentFrame(p => Math.max(0, p - 1))} />
                <Button
                  size="small"
                  icon={playing ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                  type="primary"
                  onClick={() => setPlaying(p => !p)}
                />
                <Button size="small" icon={<StepForwardOutlined />} onClick={() => setCurrentFrame(p => Math.min(totalFrames - 1, p + 1))} />
                <Text type="secondary" style={{ fontSize: 12 }}>帧 {currentFrame} / {totalFrames - 1}</Text>
                <span style={{ fontSize: 12 }}>FPS:</span>
                <InputNumber min={1} max={60} value={fps} onChange={v => setFps(v ?? 10)} size="small" style={{ width: 56 }} />
              </Space>

              {/* Frame progress bar (also acts as seek) */}
              <Slider
                min={0}
                max={Math.max(0, totalFrames - 1)}
                value={currentFrame}
                onChange={v => { setPlaying(false); setCurrentFrame(v) }}
                tooltip={{ formatter: v => `帧 ${v}` }}
                style={{ marginBottom: 4 }}
              />
            </>
          )}
        </Col>
      </Row>

      {/* ── Timeline area ── */}
      {info && totalFrames > 0 && (
        <div style={{ border: '1px solid #e8e8e8', borderRadius: 6, overflow: 'hidden' }}>
          {/* Toolbar */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '6px 12px', background: '#f5f5f5', borderBottom: '1px solid #e8e8e8',
          }}>
            <Text style={{ fontSize: 12, color: '#666' }}>模式：</Text>
            {(['select', 'range', 'point'] as EditMode[]).map(m => (
              <Button
                key={m}
                size="small"
                type={editMode === m ? 'primary' : 'default'}
                onClick={() => setEditMode(m)}
              >
                {m === 'select' ? '选择' : m === 'range' ? '区间' : '单帧'}
              </Button>
            ))}
            <div style={{ flex: 1 }} />
            <Tooltip title="缩小">
              <Button size="small" icon={<ZoomOutOutlined />} onClick={() => setPxPerFrame(p => clamp(p / 1.5, MIN_PX_PER_FRAME, MAX_PX_PER_FRAME))} />
            </Tooltip>
            <Text style={{ fontSize: 11, color: '#999', minWidth: 48, textAlign: 'center' }}>
              {pxPerFrame.toFixed(1)}px/帧
            </Text>
            <Tooltip title="放大">
              <Button size="small" icon={<ZoomInOutlined />} onClick={() => setPxPerFrame(p => clamp(p * 1.5, MIN_PX_PER_FRAME, MAX_PX_PER_FRAME))} />
            </Tooltip>
            <Tooltip title="适应宽度">
              <Button size="small" onClick={() => {
                const w = containerRef.current?.clientWidth ?? 800
                setPxPerFrame(clamp((w - SIDEBAR_W) / Math.max(totalFrames, 1), MIN_PX_PER_FRAME, MAX_PX_PER_FRAME))
              }}>适应</Button>
            </Tooltip>
          </div>

          <div style={{ display: 'flex' }} ref={containerRef}>
            {/* Left sidebar: group labels */}
            <div style={{
              width: SIDEBAR_W,
              flexShrink: 0,
              borderRight: '1px solid #e8e8e8',
              background: '#fafafa',
            }}>
              {/* Ruler placeholder */}
              <div style={{ height: RULER_H, borderBottom: '1px solid #e8e8e8', background: '#f0f0f0' }} />
              {/* Curve row label */}
              <div style={{
                height: CURVE_H,
                display: 'flex', alignItems: 'center',
                paddingLeft: 8, fontSize: 11, color: '#666',
                borderBottom: '1px solid #e8e8e8',
              }}>
                Reward Sum
              </div>
              {/* Group labels */}
              {groups.map((g, gi) => (
                <div
                  key={g.id}
                  style={{
                    height: TRACK_H,
                    display: 'flex', alignItems: 'center',
                    padding: '0 4px 0 8px',
                    borderBottom: '1px solid #e8e8e8',
                    background: gi % 2 === 0 ? '#fff' : '#fafafa',
                    gap: 4,
                    overflow: 'hidden',
                  }}
                >
                  {/* Color swatch */}
                  <input
                    type="color"
                    value={g.color}
                    onChange={e => updateGroup(g.id, { color: e.target.value })}
                    style={{ width: 18, height: 18, border: 'none', padding: 0, cursor: 'pointer', background: 'none' }}
                  />
                  {/* Name */}
                  <input
                    value={g.name}
                    onChange={e => updateGroup(g.id, { name: e.target.value })}
                    style={{
                      flex: 1, minWidth: 0, fontSize: 11, border: '1px solid transparent',
                      borderRadius: 3, padding: '1px 3px', background: 'transparent',
                      color: '#333',
                    }}
                    onFocus={e => (e.target.style.borderColor = '#1890ff')}
                    onBlur={e => (e.target.style.borderColor = 'transparent')}
                  />
                  {/* Eye */}
                  <Button
                    type="text"
                    size="small"
                    style={{ padding: 0, minWidth: 18, color: g.visible ? '#1890ff' : '#ccc' }}
                    icon={g.visible ? <EyeOutlined /> : <EyeInvisibleOutlined />}
                    onClick={() => updateGroup(g.id, { visible: !g.visible })}
                  />
                  {/* Delete */}
                  <Popconfirm
                    title="删除该 reward 组？"
                    onConfirm={() => deleteGroup(g.id)}
                    okText="删除"
                    cancelText="取消"
                  >
                    <Button
                      type="text"
                      size="small"
                      danger
                      style={{ padding: 0, minWidth: 18 }}
                      icon={<DeleteOutlined style={{ fontSize: 11 }} />}
                    />
                  </Popconfirm>
                </div>
              ))}
              {/* Add group */}
              <div style={{ height: 36, display: 'flex', alignItems: 'center', paddingLeft: 8 }}>
                <Button
                  size="small"
                  icon={<PlusOutlined />}
                  onClick={addGroup}
                  type="dashed"
                  style={{ fontSize: 11 }}
                >
                  添加组
                </Button>
              </div>
            </div>

            {/* Scrollable timeline */}
            <div style={{ flex: 1, overflowX: 'auto', overflowY: 'hidden', cursor: 'default' }}>
              <Timeline
                totalFrames={totalFrames}
                currentFrame={currentFrame}
                groups={groups}
                rewardSum={rewardSum}
                pxPerFrame={pxPerFrame}
                editMode={editMode}
                selectedSegId={selected?.segId ?? null}
                dragState={null}
                onSeek={f => { setPlaying(false); setCurrentFrame(f) }}
                onCreateSegment={createSegment}
                onSelectSegment={(segId, groupId) => {
                  if (segId && groupId) setSelected({ segId, groupId })
                  else setSelected(null)
                }}
                onMoveHandle={handleMoveHandle}
                containerRef={containerRef}
              />
            </div>
          </div>

          {/* Segment properties panel */}
          {selectedSeg && selected && (
            <div style={{
              padding: '8px 16px',
              borderTop: '1px solid #e8e8e8',
              background: '#fff',
              display: 'flex',
              alignItems: 'center',
              gap: 16,
            }}>
              <Text style={{ fontSize: 12, color: '#666' }}>
                已选: <b>{groups.find(g => g.id === selected.groupId)?.name}</b>
                {' '}{selectedSeg.type === 'point' ? `帧 ${selectedSeg.startFrame}` : `帧 ${selectedSeg.startFrame} – ${selectedSeg.endFrame}`}
              </Text>
              <Space align="center">
                <Text style={{ fontSize: 12 }}>Reward 值：</Text>
                <Slider
                  min={-1}
                  max={1}
                  step={0.05}
                  value={selectedSeg.value}
                  onChange={v => updateSegment(selected.groupId, selected.segId, { value: v })}
                  style={{ width: 160 }}
                />
                <InputNumber
                  min={-1}
                  max={1}
                  step={0.05}
                  value={selectedSeg.value}
                  onChange={v => updateSegment(selected.groupId, selected.segId, { value: v ?? 0 })}
                  style={{ width: 72 }}
                  size="small"
                />
              </Space>
              {selectedSeg.type === 'range' && (
                <Space>
                  <Text style={{ fontSize: 12 }}>起止帧：</Text>
                  <InputNumber
                    min={0}
                    max={selectedSeg.endFrame}
                    value={selectedSeg.startFrame}
                    onChange={v => updateSegment(selected.groupId, selected.segId, { startFrame: v ?? 0 })}
                    size="small"
                    style={{ width: 64 }}
                  />
                  <MinusOutlined style={{ fontSize: 10, color: '#999' }} />
                  <InputNumber
                    min={selectedSeg.startFrame}
                    max={totalFrames - 1}
                    value={selectedSeg.endFrame}
                    onChange={v => updateSegment(selected.groupId, selected.segId, { endFrame: v ?? 0 })}
                    size="small"
                    style={{ width: 64 }}
                  />
                </Space>
              )}
              <Button
                size="small"
                danger
                icon={<DeleteOutlined />}
                onClick={() => deleteSegment(selected.groupId, selected.segId)}
              >
                删除
              </Button>
              <Text style={{ fontSize: 11, color: '#999' }}>（Del 键快速删除）</Text>
            </div>
          )}
        </div>
      )}

      {/* Save button */}
      {info && (
        <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Tooltip title="保存标注草稿（reward 组配置），不修改数据集文件">
            <Button
              icon={<SaveOutlined />}
              loading={saving}
              onClick={handleSave}
              disabled={!selectedFile}
            >
              保存草稿
            </Button>
          </Tooltip>
          <Tooltip title="将当前 reward 汇总值（每帧）写入 LeRobot parquet 文件，作为正式 reward 字段与 action/observation 并列">
            <Popconfirm
              title="写入数据集"
              description={`将 episode ${episode} 的 ${totalFrames} 帧 reward 值写入 parquet，会覆盖已有 reward 列。确认继续？`}
              onConfirm={handleApply}
              okText="写入"
              cancelText="取消"
            >
              <Button
                type="primary"
                icon={<DatabaseOutlined />}
                loading={applying}
                disabled={!selectedFile || groups.length === 0}
              >
                写入数据集
              </Button>
            </Popconfirm>
          </Tooltip>
        </div>
      )}
    </div>
  )
}
