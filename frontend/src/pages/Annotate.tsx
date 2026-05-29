import { useCallback, useEffect, useMemo, useState } from 'react'
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
import VideoPlayer from '../components/VideoPlayer'
import { usePlayback } from '../hooks/usePlayback'
import {
  getDatasetInfo, loadAnnotations, saveAnnotations,
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
  const [totalFrames, setTotalFrames] = useState(0)
  const [annotation, setAnnotation] = useState<EpisodeAnnotation>({ labels: [], frame_rewards: {} })
  const [allAnnotations, setAllAnnotations] = useState<RawEpisodes>({})
  const [presetLabels, setPresetLabels] = useState<string[]>([])
  const [newLabel, setNewLabel] = useState('')
  const [saving, setSaving] = useState(false)

  const { currentFrame, setCurrentFrame, playing, setPlaying, fps, setFps } = usePlayback(totalFrames)

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
    setCurrentFrame(0)
    setEpisode(0)
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
    setCurrentFrame(0)
    const epLen = info?.episodes?.find(e => e.episode_index === ep)?.length ?? info?.n_frames ?? 0
    setTotalFrames(epLen)
    setAnnotation(toAnnotation(allAnnotations[String(ep)]))
  }

  const currentReward = (annotation.frame_rewards[String(currentFrame)] as number | undefined) ?? null

  const setFrameReward = (val: number | null) => {
    setAnnotation(prev => {
      const fr = { ...prev.frame_rewards }
      if (val === null) {
        delete fr[String(currentFrame)]
      } else {
        fr[String(currentFrame)] = val
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

  const imgHeight = cameraList.length <= 1 ? 320 : 200

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
                <VideoPlayer
                  path={selectedFile.path}
                  episode={episode}
                  cameras={cameraList.map(c => c.id)}
                  format={vizFormat}
                  currentFrame={currentFrame}
                  datasetFps={info.fps ?? 30}
                  imgHeight={imgHeight}
                  style={{ marginBottom: 12 }}
                />
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
                <Button icon={<StepBackwardOutlined />} onClick={() => setCurrentFrame(p => Math.max(0, p - 1))} />
                <Button
                  icon={playing ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                  type="primary"
                  onClick={() => setPlaying(p => !p)}
                />
                <Button icon={<StepForwardOutlined />} onClick={() => setCurrentFrame(p => Math.min(totalFrames - 1, p + 1))} />
                <span>FPS:</span>
                <InputNumber min={1} max={60} value={fps} onChange={v => setFps(v ?? 10)} size="small" style={{ width: 60 }} />
                <Text type="secondary">帧 {currentFrame} / {totalFrames - 1}</Text>
              </Space>

              <Slider
                min={0}
                max={Math.max(0, totalFrames - 1)}
                value={currentFrame}
                onChange={v => { setPlaying(false); setCurrentFrame(v) }}
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

              <Divider>帧 Reward 标注（帧 {currentFrame}）</Divider>

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
