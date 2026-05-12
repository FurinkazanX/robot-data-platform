import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert, Badge, Button, Col, Divider, Form, Input, InputNumber, Radio,
  Row, Select, Slider, Space, Spin, Tag, Typography, message,
} from 'antd'
import {
  PauseCircleOutlined, PlayCircleOutlined,
  PlusOutlined, SaveOutlined,
  StepBackwardOutlined, StepForwardOutlined,
} from '@ant-design/icons'
import FileBrowser from '../components/FileBrowser'
import {
  getDatasetInfo, getFrameUrl, loadAnnotations, saveAnnotations,
  getAnnotationLabels,
  type AnnotationData, type DatasetInfo, type FileItem,
} from '../api/client'

const { Title, Text } = Typography

interface EpisodeAnnotation {
  labels: string[]
  frame_rewards: Record<string, number>
}

type RawEpisodes = AnnotationData['episodes']

interface CameraEntry {
  id: string
  label: string
}

function toAnnotation(raw: RawEpisodes[string] | undefined): EpisodeAnnotation {
  return { labels: raw?.labels ?? [], frame_rewards: raw?.frame_rewards ?? {} }
}

export default function Annotate() {
  const [vizFormat, setVizFormat] = useState<'hdf5' | 'lerobot'>('hdf5')
  const [selectedFile, setSelectedFile] = useState<FileItem | null>(null)
  const [info, setInfo] = useState<DatasetInfo | null>(null)
  const [episode, setEpisode] = useState(0)
  const [frameIdx, setFrameIdx] = useState(0)
  const [totalFrames, setTotalFrames] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [fps, setFps] = useState(10)
  const [annotation, setAnnotation] = useState<EpisodeAnnotation>({ labels: [], frame_rewards: {} })
  const [allAnnotations, setAllAnnotations] = useState<RawEpisodes>({})
  const [presetLabels, setPresetLabels] = useState<string[]>([])
  const [newLabel, setNewLabel] = useState('')
  const [saving, setSaving] = useState(false)
  const [imgErrors, setImgErrors] = useState<Record<string, boolean>>({})
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    getAnnotationLabels().then(r => setPresetLabels(r.suggestions)).catch(() => {})
  }, [])

  const cameraList = useMemo((): CameraEntry[] => {
    if (!info) return []
    if (info.format === 'hdf5') {
      return (info.fields ?? [])
        .filter(f => f.is_image)
        .map(f => ({ id: f.key, label: f.key.split('/').filter(Boolean).pop() ?? f.key }))
    }
    return (info.cameras ?? []).map(c => ({ id: c, label: c }))
  }, [info])

  const loadDataset = useCallback(async (item: FileItem) => {
    setSelectedFile(item)
    setFrameIdx(0)
    setEpisode(0)
    setImgErrors({})
    setAnnotation({ labels: [], frame_rewards: {} })
    setAllAnnotations({})
    try {
      const d = await getDatasetInfo(item.path)
      setInfo(d)
      const epLen = d.episodes?.[0]?.length ?? d.n_frames
      setTotalFrames(epLen)
      if (d.fps) setFps(Math.min(d.fps, 30))
      const ann = await loadAnnotations(item.path)
      setAllAnnotations(ann.episodes ?? {})
      setAnnotation(toAnnotation(ann.episodes?.[String(0)]))
    } catch {
      message.error('加载数据集失败')
    }
  }, [])

  const handleEpisodeChange = (ep: number) => {
    setEpisode(ep)
    setFrameIdx(0)
    setImgErrors({})
    const epLen = info?.episodes?.find(e => e.episode_index === ep)?.length ?? info?.n_frames ?? 0
    setTotalFrames(epLen)
    setAnnotation(toAnnotation(allAnnotations[String(ep)]))
  }

  // Playback
  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current)
    if (!playing) return
    intervalRef.current = setInterval(() => {
      setFrameIdx(prev => {
        if (prev >= totalFrames - 1) { setPlaying(false); return prev }
        return prev + 1
      })
    }, 1000 / fps)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [playing, fps, totalFrames])

  const currentReward = (annotation.frame_rewards[String(frameIdx)] as number | undefined) ?? null

  const setFrameReward = (val: number | null) => {
    setAnnotation(prev => {
      const fr = { ...prev.frame_rewards }
      if (val === null) {
        delete fr[String(frameIdx)]
      } else {
        fr[String(frameIdx)] = val
      }
      return { ...prev, frame_rewards: fr }
    })
  }

  const addLabel = (label: string) => {
    const l = label.trim()
    if (!l || annotation.labels.includes(l)) return
    setAnnotation(prev => ({ ...prev, labels: [...prev.labels, l] }))
    setNewLabel('')
  }

  const removeLabel = (label: string) => {
    setAnnotation(prev => ({ ...prev, labels: prev.labels.filter(x => x !== label) }))
  }

  const handleSave = async () => {
    if (!selectedFile) return
    setSaving(true)
    try {
      await saveAnnotations({
        path: selectedFile.path,
        episode,
        labels: annotation.labels,
        frame_rewards: annotation.frame_rewards,
      })
      setAllAnnotations(prev => ({ ...prev, [String(episode)]: annotation }))
      message.success('标注已保存')
    } catch {
      message.error('保存失败')
    } finally {
      setSaving(false)
    }
  }

  const annotatedEpisodes = Object.keys(allAnnotations).filter(
    k => (allAnnotations[k]?.labels?.length ?? 0) > 0
      || Object.keys(allAnnotations[k]?.frame_rewards ?? {}).length > 0
  )

  const camCols = cameraList.length <= 1 ? 1 : cameraList.length <= 4 ? 2 : 3

  return (
    <div>
      <Title level={4}>数据标注</Title>

      {/* Format selector */}
      <Form layout="inline" style={{ marginBottom: 16 }}>
        <Form.Item label="数据格式">
          <Radio.Group
            value={vizFormat}
            onChange={e => {
              setVizFormat(e.target.value)
              setSelectedFile(null)
              setInfo(null)
            }}
          >
            <Radio.Button value="hdf5">HDF5</Radio.Button>
            <Radio.Button value="lerobot">LeRobot</Radio.Button>
          </Radio.Group>
        </Form.Item>
      </Form>

      <Row gutter={24}>
        {/* Left: file browser */}
        <Col span={6}>
          {vizFormat === 'hdf5' ? (
            <FileBrowser
              title="选择 HDF5 文件"
              filterExt={['.h5', '.hdf5']}
              onSelect={(_, items) => { if (items[0]) loadDataset(items[0]) }}
            />
          ) : (
            <FileBrowser
              title="选择 LeRobot 目录"
              dirOnly
              onSelect={(_, items) => { if (items[0]) loadDataset(items[0]) }}
            />
          )}

          {info && (
            <div style={{ marginTop: 12 }}>
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
                  label: (
                    <Space size={4}>
                      <span>Episode {e.episode_index}</span>
                      {(allAnnotations[String(e.episode_index)]?.labels?.length ?? 0) > 0 && (
                        <Badge status="success" />
                      )}
                    </Space>
                  ),
                  value: e.episode_index,
                }))}
              />
            </Form.Item>
          )}

          {/* Annotation summary */}
          {annotatedEpisodes.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                已标注 {annotatedEpisodes.length} / {info?.n_episodes ?? 1} 个 episode
              </Text>
            </div>
          )}
        </Col>

        {/* Right: player + annotation */}
        <Col span={18}>
          {!selectedFile ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#999' }}>
              请在左侧选择数据集
            </div>
          ) : !info ? (
            <div style={{ padding: 40, textAlign: 'center' }}>
              <Spin />
            </div>
          ) : (
            <>
              {/* Camera grid */}
              {cameraList.length > 0 ? (
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: `repeat(${camCols}, 1fr)`,
                  gap: 12,
                  marginBottom: 12,
                }}>
                  {cameraList.map(cam => {
                    const url = getFrameUrl(selectedFile.path, episode, frameIdx, cam.id)
                    return (
                      <div key={cam.id} style={{ textAlign: 'center' }}>
                        {!imgErrors[cam.id] ? (
                          <img
                            src={url}
                            alt={cam.label}
                            style={{
                              width: '100%',
                              maxHeight: camCols === 1 ? 320 : 200,
                              objectFit: 'contain',
                              border: '1px solid #d9d9d9',
                              borderRadius: 6,
                              background: '#000',
                            }}
                            onError={() => setImgErrors(prev => ({ ...prev, [cam.id]: true }))}
                          />
                        ) : (
                          <div style={{
                            height: camCols === 1 ? 320 : 200,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            border: '1px solid #d9d9d9', borderRadius: 6, color: '#999',
                          }}>
                            无图像数据
                          </div>
                        )}
                        <div style={{ marginTop: 4, fontSize: 12, color: '#555' }}>{cam.label}</div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div style={{
                  height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  border: '1px dashed #d9d9d9', borderRadius: 6, color: '#999', marginBottom: 12,
                }}>
                  无摄像头图像数据
                </div>
              )}

              {/* Playback controls */}
              <Space style={{ width: '100%', justifyContent: 'center', marginBottom: 8 }}>
                <Button icon={<StepBackwardOutlined />} onClick={() => setFrameIdx(p => Math.max(0, p - 1))} />
                <Button
                  icon={playing ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                  type="primary"
                  onClick={() => setPlaying(p => !p)}
                />
                <Button icon={<StepForwardOutlined />} onClick={() => setFrameIdx(p => Math.min(totalFrames - 1, p + 1))} />
                <span>FPS:</span>
                <InputNumber min={1} max={60} value={fps} onChange={v => setFps(v ?? 10)} size="small" style={{ width: 60 }} />
                <Text type="secondary">帧 {frameIdx} / {totalFrames - 1}</Text>
              </Space>

              <Slider
                min={0}
                max={Math.max(0, totalFrames - 1)}
                value={frameIdx}
                onChange={v => { setPlaying(false); setFrameIdx(v) }}
                tooltip={{ formatter: v => `帧 ${v}` }}
                style={{ marginBottom: 16 }}
              />

              <Divider>Episode 标签</Divider>

              {/* Episode labels */}
              <div style={{ marginBottom: 12 }}>
                <Space wrap>
                  {annotation.labels.map(label => (
                    <Tag
                      key={label}
                      closable
                      color="blue"
                      onClose={() => removeLabel(label)}
                    >
                      {label}
                    </Tag>
                  ))}
                </Space>
              </div>

              <Space wrap style={{ marginBottom: 16 }}>
                {presetLabels.map(label => (
                  <Tag
                    key={label}
                    style={{ cursor: 'pointer' }}
                    color={annotation.labels.includes(label) ? 'blue' : 'default'}
                    onClick={() => {
                      if (annotation.labels.includes(label)) {
                        removeLabel(label)
                      } else {
                        addLabel(label)
                      }
                    }}
                  >
                    {label}
                  </Tag>
                ))}
                <Input
                  size="small"
                  placeholder="自定义标签"
                  value={newLabel}
                  onChange={e => setNewLabel(e.target.value)}
                  onPressEnter={() => addLabel(newLabel)}
                  style={{ width: 120 }}
                  suffix={
                    <PlusOutlined
                      style={{ cursor: 'pointer' }}
                      onClick={() => addLabel(newLabel)}
                    />
                  }
                />
              </Space>

              <Divider>帧 Reward 标注（帧 {frameIdx}）</Divider>

              <Row gutter={16} align="middle" style={{ marginBottom: 16 }}>
                <Col flex="auto">
                  <Slider
                    min={-1}
                    max={1}
                    step={0.05}
                    value={currentReward ?? 0}
                    onChange={v => setFrameReward(v)}
                  />
                </Col>
                <Col>
                  <InputNumber
                    min={-1}
                    max={1}
                    step={0.05}
                    value={currentReward ?? 0}
                    onChange={v => setFrameReward(v ?? 0)}
                    style={{ width: 80 }}
                    size="small"
                  />
                </Col>
                <Col>
                  <Button
                    size="small"
                    onClick={() => setFrameReward(null)}
                    disabled={currentReward === null}
                  >
                    清除
                  </Button>
                </Col>
              </Row>

              {Object.keys(annotation.frame_rewards).length > 0 && (
                <Alert
                  type="info"
                  showIcon
                  style={{ marginBottom: 16 }}
                  message={`已标注 ${Object.keys(annotation.frame_rewards).length} 帧 reward`}
                />
              )}

              <Button
                type="primary"
                icon={<SaveOutlined />}
                loading={saving}
                onClick={handleSave}
                disabled={!selectedFile}
              >
                保存标注
              </Button>
            </>
          )}
        </Col>
      </Row>
    </div>
  )
}
