import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button, Col, Divider, Form, InputNumber, Row, Select,
  Slider, Space, Table, Tag, Typography, message,
} from 'antd'
import {
  PlayCircleOutlined, PauseCircleOutlined,
  StepForwardOutlined, StepBackwardOutlined,
} from '@ant-design/icons'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer,
} from 'recharts'
import FileBrowser from '../components/FileBrowser'
import { getDatasetInfo, getFrameUrl, getSeries, editValue, type DatasetInfo, type FileItem } from '../api/client'

const { Title, Text } = Typography

const COLORS = ['#1677ff', '#52c41a', '#fa8c16', '#f5222d', '#722ed1', '#13c2c2', '#eb2f96', '#faad14']

interface CameraEntry {
  id: string   // cam param for the API (field key for hdf5, dir name for lerobot)
  label: string
}

export default function Visualize() {
  const [selectedFile, setSelectedFile] = useState<FileItem | null>(null)
  const [info, setInfo] = useState<DatasetInfo | null>(null)
  const [episode, setEpisode] = useState(0)
  const [frameIdx, setFrameIdx] = useState(0)
  const [totalFrames, setTotalFrames] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [fps, setFps] = useState(10)
  const [series, setSeries] = useState<Record<string, number[]>>({})
  const [visibleFields, setVisibleFields] = useState<string[]>([])
  const [editingRow, setEditingRow] = useState<{ field: string; value: unknown } | null>(null)
  // Track image load errors per camera to show fallback
  const [imgErrors, setImgErrors] = useState<Record<string, boolean>>({})
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Derive camera list from dataset info
  const cameraList = useMemo((): CameraEntry[] => {
    if (!info) return []
    if (info.format === 'hdf5') {
      return (info.fields ?? [])
        .filter(f => f.is_image)
        .map(f => ({
          id: f.key,
          label: f.key.split('/').filter(Boolean).pop() ?? f.key,
        }))
    }
    // lerobot: cameras are directory names under videos/
    return (info.cameras ?? []).map(c => ({ id: c, label: c }))
  }, [info])

  const handleFileSelect = useCallback(async (_: string[], items: FileItem[]) => {
    const item = items[0]
    if (!item) return
    setSelectedFile(item)
    setFrameIdx(0)
    setEpisode(0)
    setImgErrors({})
    try {
      const d = await getDatasetInfo(item.path)
      setInfo(d)
      const epLen = d.episodes?.[0]?.length ?? d.n_frames
      setTotalFrames(epLen)
      if (d.fps) setFps(Math.min(d.fps, 30))
    } catch {
      message.error('无法读取数据集信息')
    }
  }, [])

  // Load series data when episode changes
  useEffect(() => {
    if (!selectedFile) return
    getSeries(selectedFile.path, episode).then(({ fields }) => {
      setSeries(fields)
      setVisibleFields(Object.keys(fields).slice(0, 5))
    }).catch(() => {})
  }, [selectedFile, episode])

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

  // Chart data
  const chartData = Object.keys(series).length
    ? Array.from({ length: totalFrames || 1 }, (_, i) => {
        const row: Record<string, unknown> = { frame: i }
        visibleFields.forEach(f => { row[f] = series[f]?.[i] ?? null })
        return row
      })
    : []

  // Table rows for current frame
  const tableRows = Object.entries(series).map(([field, values]) => ({
    key: field,
    field,
    value: values[frameIdx] ?? '—',
  }))

  const tableCols = [
    { title: '字段', dataIndex: 'field', width: 240 },
    {
      title: `值（帧 ${frameIdx}）`,
      dataIndex: 'value',
      render: (v: unknown, row: { field: string; value: unknown }) => {
        if (editingRow?.field === row.field) {
          return (
            <Space>
              <InputNumber
                value={Number(editingRow.value)}
                onChange={val => setEditingRow(p => p ? { ...p, value: val } : null)}
                size="small"
              />
              <Button size="small" type="primary" onClick={async () => {
                if (!selectedFile || !editingRow) return
                await editValue({ path: selectedFile.path, episode, frame_idx: frameIdx, field: editingRow.field, value: editingRow.value })
                setSeries(prev => {
                  const updated = [...(prev[editingRow.field] ?? [])]
                  updated[frameIdx] = editingRow.value as number
                  return { ...prev, [editingRow.field]: updated }
                })
                setEditingRow(null)
                message.success('已更新')
              }}>保存</Button>
              <Button size="small" onClick={() => setEditingRow(null)}>取消</Button>
            </Space>
          )
        }
        return (
          <Space>
            <Text>{typeof v === 'number' ? v.toFixed(4) : String(v)}</Text>
            <Button size="small" onClick={() => setEditingRow({ field: row.field, value: v })}>编辑</Button>
          </Space>
        )
      },
    },
  ]

  // Determine grid columns based on camera count
  const camCols = cameraList.length <= 1 ? 1 : cameraList.length <= 4 ? 2 : 3

  return (
    <div>
      <Title level={4}>数据可视化</Title>
      <Row gutter={24}>
        <Col span={6}>
          <FileBrowser
            title="选择数据集"
            onSelect={handleFileSelect}
            filterExt={['.h5', '.hdf5']}
          />
          {info && (
            <div style={{ marginTop: 12 }}>
              <Tag color="blue">{info.format.toUpperCase()}</Tag>
              <Tag>{info.n_episodes} episodes</Tag>
              <Tag>{info.n_frames} 帧</Tag>
              {info.fps && <Tag>FPS: {info.fps}</Tag>}
            </div>
          )}
          {info && info.n_episodes > 1 && (
            <Form.Item label="Episode" style={{ marginTop: 8 }}>
              <Select
                value={episode}
                onChange={ep => { setEpisode(ep); setFrameIdx(0) }}
                options={(info.episodes ?? Array.from({ length: info.n_episodes }, (_, i) => ({ episode_index: i, length: 0 }))).map(e => ({
                  label: `Episode ${e.episode_index} (${e.length}帧)`,
                  value: e.episode_index,
                }))}
                style={{ width: '100%' }}
              />
            </Form.Item>
          )}
        </Col>

        <Col span={18}>
          {!selectedFile ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#999' }}>请在左侧选择数据集文件</div>
          ) : (
            <>
              {/* Camera images grid */}
              {cameraList.length > 0 ? (
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: `repeat(${camCols}, 1fr)`,
                  gap: 12,
                  marginBottom: 16,
                }}>
                  {cameraList.map(cam => {
                    const url = selectedFile
                      ? getFrameUrl(selectedFile.path, episode, frameIdx, cam.id)
                      : ''
                    return (
                      <div key={cam.id} style={{ textAlign: 'center' }}>
                        {!imgErrors[cam.id] ? (
                          <img
                            src={url}
                            alt={cam.label}
                            style={{
                              width: '100%',
                              maxHeight: camCols === 1 ? 360 : 220,
                              objectFit: 'contain',
                              border: '1px solid #d9d9d9',
                              borderRadius: 6,
                              background: '#000',
                            }}
                            onError={() => setImgErrors(prev => ({ ...prev, [cam.id]: true }))}
                          />
                        ) : (
                          <div style={{
                            height: camCols === 1 ? 360 : 220,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            border: '1px solid #d9d9d9', borderRadius: 6, color: '#999',
                          }}>
                            无图像数据
                          </div>
                        )}
                        <div style={{ marginTop: 4, fontSize: 12, color: '#555', wordBreak: 'break-all' }}>
                          {cam.label}
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div style={{
                  height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  border: '1px dashed #d9d9d9', borderRadius: 6, color: '#999', marginBottom: 16,
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
              />

              <Divider>传感器数据</Divider>

              <Form.Item label="显示字段">
                <Select
                  mode="multiple"
                  value={visibleFields}
                  onChange={setVisibleFields}
                  options={Object.keys(series).map(k => ({ label: k, value: k }))}
                  style={{ width: '100%' }}
                  maxTagCount={6}
                />
              </Form.Item>

              {visibleFields.length > 0 && chartData.length > 0 && (
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="frame" />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    {visibleFields.map((f, i) => (
                      <Line key={f} type="monotone" dataKey={f} stroke={COLORS[i % COLORS.length]} dot={false} strokeWidth={1.5} />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              )}

              <Divider>当前帧数据（可编辑）</Divider>
              <Table
                dataSource={tableRows}
                columns={tableCols}
                size="small"
                pagination={{ pageSize: 10 }}
                rowKey="field"
              />
            </>
          )}
        </Col>
      </Row>
    </div>
  )
}
