import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button, Col, Divider, Form, Input, InputNumber, Radio, Row, Select,
  Slider, Space, Spin, Table, Tag, Tooltip, Typography, message,
} from 'antd'
import {
  PlayCircleOutlined, PauseCircleOutlined,
  StepForwardOutlined, StepBackwardOutlined,
  FileOutlined, FolderOutlined, ArrowLeftOutlined,
} from '@ant-design/icons'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as ChartTooltip,
  Legend, ResponsiveContainer,
} from 'recharts'
import FileBrowser from '../components/FileBrowser'
import VideoPlayer from '../components/VideoPlayer'
import { usePlayback } from '../hooks/usePlayback'
import {
  getDatasetInfo, getSeries, editValue,
  getRemoteDatasetInfo, getRemoteSeries,
  listRemote, testConnection,
  type DatasetInfo, type FileItem, type SSHCreds,
} from '../api/client'

const { Title, Text } = Typography

const COLORS = ['#1677ff', '#52c41a', '#fa8c16', '#f5222d', '#722ed1', '#13c2c2', '#eb2f96', '#faad14']

interface CameraEntry {
  id: string
  label: string
}

function parentPath(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx <= 0 ? '/' : p.slice(0, idx)
}

export default function Visualize() {
  const [vizFormat, setVizFormat] = useState<'hdf5' | 'lerobot'>('hdf5')
  const [dataSource, setDataSource] = useState<'local' | 'remote'>('local')

  // Dataset state
  const [selectedFile, setSelectedFile] = useState<FileItem | null>(null)
  const [info, setInfo] = useState<DatasetInfo | null>(null)
  const [episode, setEpisode] = useState(0)
  const [totalFrames, setTotalFrames] = useState(0)
  const [series, setSeries] = useState<Record<string, number[]>>({})
  const [visibleFields, setVisibleFields] = useState<string[]>([])
  const [editingRow, setEditingRow] = useState<{ field: string; value: unknown } | null>(null)

  // Remote state
  const [rCreds, setRCreds] = useState<SSHCreds>({ host: '', port: 22, username: '', password: '' })
  const [rConnected, setRConnected] = useState(false)
  const [rConnecting, setRConnecting] = useState(false)
  const [rPath, setRPath] = useState('/')
  const [rItems, setRItems] = useState<FileItem[]>([])
  const [rLoading, setRLoading] = useState(false)
  const rCredsRef = useRef(rCreds)

  const { currentFrame, setCurrentFrame, playing, setPlaying, fps, setFps } = usePlayback(totalFrames)

  // Keep rCredsRef current without adding to effect deps
  useEffect(() => { rCredsRef.current = rCreds }, [rCreds])

  const patchRCreds = (p: Partial<SSHCreds>) => setRCreds(prev => ({ ...prev, ...p }))

  // Derive camera list
  const cameraList = useMemo((): CameraEntry[] => {
    if (!info) return []
    if (info.format === 'hdf5') {
      return (info.fields ?? [])
        .filter(f => f.is_image)
        .map(f => ({ id: f.key, label: f.key.split('/').filter(Boolean).pop() ?? f.key }))
    }
    return (info.cameras ?? []).map(c => ({ id: c, label: c }))
  }, [info])

  const episodeItems = useMemo((): Array<{ episode_index: number; length: number }> => {
    if (!info || info.format !== 'lerobot') return []
    if (info.episodes?.length) return info.episodes
    return Array.from({ length: info.n_episodes }, (_, i) => ({ episode_index: i, length: 0 }))
  }, [info])

  // ── Local file select ─────────────────────────────────────────────────────

  const handleLocalSelect = useCallback(async (_: string[], items: FileItem[]) => {
    const item = items[0]
    if (!item) return
    setSelectedFile(item)
    setCurrentFrame(0); setEpisode(0)
    try {
      const d = await getDatasetInfo(item.path)
      setInfo(d)
      setTotalFrames(d.episodes?.[0]?.length ?? d.n_frames)
      if (d.fps) setFps(Math.min(d.fps, 30))
    } catch {
      message.error('无法读取数据集信息')
    }
  }, [])

  // ── Remote connection + browse ────────────────────────────────────────────

  const handleConnect = async () => {
    if (!rCreds.host || !rCreds.username) return message.warning('请填写主机和用户名')
    setRConnecting(true)
    try {
      await testConnection(rCreds)
      setRConnected(true)
      await loadRemote('/')
      message.success('连接成功')
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      message.error('连接失败: ' + (detail ?? String(e)))
    } finally {
      setRConnecting(false)
    }
  }

  const loadRemote = async (path: string) => {
    setRLoading(true)
    try {
      const { items } = await listRemote(rCreds, path)
      setRPath(path)
      setRItems(
        vizFormat === 'hdf5'
          ? items.filter(i => i.is_dir || i.ext === '.h5' || i.ext === '.hdf5')
          : items.filter(i => i.is_dir),
      )
    } catch {
      message.error('浏览远程目录失败')
    } finally {
      setRLoading(false)
    }
  }

  const handleRemoteSelect = async (item: FileItem) => {
    setSelectedFile(item)
    setCurrentFrame(0); setEpisode(0)
    try {
      const d = await getRemoteDatasetInfo(rCredsRef.current, item.path)
      setInfo(d)
      setTotalFrames(d.episodes?.[0]?.length ?? d.n_frames)
      if (d.fps) setFps(Math.min(d.fps, 30))
    } catch {
      message.error('无法读取远程数据集信息')
    }
  }

  // ── Episode change ────────────────────────────────────────────────────────

  const handleEpisodeChange = (ep: number) => {
    setEpisode(ep)
    setCurrentFrame(0)
    const epLen = info?.episodes?.find(e => e.episode_index === ep)?.length ?? info?.n_frames ?? 0
    setTotalFrames(epLen)
  }

  // ── Load series ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (!selectedFile) return
    const load = dataSource === 'remote' && rConnected
      ? getRemoteSeries(rCredsRef.current, selectedFile.path, episode)
      : getSeries(selectedFile.path, episode)
    load.then(({ fields }) => {
      setSeries(fields)
      setVisibleFields(Object.keys(fields).slice(0, 5))
    }).catch(() => {})
  }, [selectedFile, episode, dataSource, rConnected])

  // ── Chart + table ─────────────────────────────────────────────────────────

  const chartData = Object.keys(series).length
    ? Array.from({ length: totalFrames || 1 }, (_, i) => {
        const row: Record<string, unknown> = { frame: i }
        visibleFields.forEach(f => { row[f] = series[f]?.[i] ?? null })
        return row
      })
    : []

  const tableRows = Object.entries(series).map(([field, values]) => ({
    key: field,
    field,
    value: values[currentFrame] ?? '—',
  }))

  const tableCols = [
    { title: '字段', dataIndex: 'field', width: 240 },
    {
      title: `值（帧 ${currentFrame}）`,
      dataIndex: 'value',
      render: (v: unknown, row: { field: string; value: unknown }) => {
        if (dataSource === 'remote') {
          return <Text>{typeof v === 'number' ? v.toFixed(4) : String(v)}</Text>
        }
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
                await editValue({ path: selectedFile.path, episode, frame_idx: currentFrame, field: editingRow.field, value: editingRow.value })
                setSeries(prev => {
                  const updated = [...(prev[editingRow.field] ?? [])]
                  updated[currentFrame] = editingRow.value as number
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

  const imgHeight = cameraList.length <= 1 ? 360 : 220

  return (
    <div>
      <Title level={4}>数据可视化</Title>

      {/* Top controls */}
      <Form layout="inline" style={{ marginBottom: 16, gap: 16 }}>
        <Form.Item label="数据来源">
          <Radio.Group
            value={dataSource}
            onChange={e => {
              setDataSource(e.target.value)
              setSelectedFile(null); setInfo(null); setSeries({})
              setRConnected(false)
            }}
          >
            <Radio.Button value="local">本地</Radio.Button>
            <Radio.Button value="remote">远程</Radio.Button>
          </Radio.Group>
        </Form.Item>
        <Form.Item label="数据格式">
          <Radio.Group
            value={vizFormat}
            onChange={e => {
              setVizFormat(e.target.value)
              setSelectedFile(null); setInfo(null); setSeries({})
            }}
          >
            <Radio.Button value="hdf5">HDF5</Radio.Button>
            <Radio.Button value="lerobot">LeRobot</Radio.Button>
          </Radio.Group>
        </Form.Item>
      </Form>

      <Row gutter={24}>
        {/* Left panel */}
        <Col span={6}>
          {dataSource === 'local' ? (
            /* Local file browser */
            vizFormat === 'hdf5' ? (
              <FileBrowser
                title="选择 HDF5 文件"
                onSelect={handleLocalSelect}
                filterExt={['.h5', '.hdf5']}
              />
            ) : (
              <FileBrowser
                title="选择 LeRobot 目录"
                dirOnly
                onSelect={handleLocalSelect}
              />
            )
          ) : (
            /* Remote SSH form + browser */
            <div>
              <Form layout="vertical" size="small" style={{ marginBottom: 8 }}>
                <Form.Item label="主机 IP">
                  <Input
                    value={rCreds.host}
                    onChange={e => patchRCreds({ host: e.target.value })}
                    placeholder="192.168.1.100"
                    disabled={rConnected}
                  />
                </Form.Item>
                <Form.Item label="端口">
                  <InputNumber
                    value={rCreds.port ?? 22}
                    onChange={v => patchRCreds({ port: v ?? 22 })}
                    style={{ width: '100%' }}
                    disabled={rConnected}
                  />
                </Form.Item>
                <Form.Item label="用户名">
                  <Input
                    value={rCreds.username}
                    onChange={e => patchRCreds({ username: e.target.value })}
                    disabled={rConnected}
                  />
                </Form.Item>
                <Form.Item label="密码">
                  <Input.Password
                    value={rCreds.password ?? ''}
                    onChange={e => patchRCreds({ password: e.target.value })}
                    disabled={rConnected}
                  />
                </Form.Item>
                <Form.Item>
                  {rConnected ? (
                    <Space>
                      <Tag color="green">已连接</Tag>
                      <Button
                        size="small"
                        onClick={() => { setRConnected(false); setRItems([]); setSelectedFile(null); setInfo(null) }}
                      >
                        断开
                      </Button>
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
                  {/* Path + back */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
                    {rPath !== '/' && (
                      <Button
                        size="small"
                        icon={<ArrowLeftOutlined />}
                        onClick={() => loadRemote(parentPath(rPath))}
                      />
                    )}
                    <Text ellipsis style={{ flex: 1, fontSize: 11, color: '#888' }}>{rPath}</Text>
                    {vizFormat === 'lerobot' && (
                      <Tooltip title="选择当前目录">
                        <Button
                          size="small"
                          type="primary"
                          onClick={() => handleRemoteSelect({
                            name: rPath.split('/').pop() || rPath,
                            path: rPath,
                            is_dir: true,
                            size: null,
                            mtime: 0,
                            ext: null,
                          })}
                        >
                          选择
                        </Button>
                      </Tooltip>
                    )}
                  </div>

                  {/* File list */}
                  {rLoading ? (
                    <div style={{ textAlign: 'center', padding: 12 }}><Spin size="small" /></div>
                  ) : (
                    <div style={{
                      maxHeight: 320, overflowY: 'auto', overflowX: 'auto',
                      border: '1px solid #d9d9d9', borderRadius: 6,
                    }}>
                      {rItems.length === 0 ? (
                        <div style={{ padding: '8px 10px', color: '#999', fontSize: 12 }}>无文件</div>
                      ) : rItems.map(item => (
                        <div
                          key={item.path}
                          style={{
                            padding: '6px 10px', cursor: 'pointer',
                            display: 'flex', alignItems: 'center', gap: 6,
                            background: selectedFile?.path === item.path ? '#e6f4ff' : 'transparent',
                            fontSize: 13, whiteSpace: 'nowrap',
                          }}
                          onClick={() => item.is_dir ? loadRemote(item.path) : handleRemoteSelect(item)}
                        >
                          {item.is_dir
                            ? <FolderOutlined style={{ color: '#faad14', flexShrink: 0 }} />
                            : <FileOutlined style={{ flexShrink: 0 }} />}
                          <span style={{ fontSize: 13 }}>{item.name}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {info && (
            <div style={{ marginTop: 12 }}>
              <Tag color="blue">{info.format.toUpperCase()}</Tag>
              <Tag>{info.n_episodes} episodes</Tag>
              <Tag>{info.n_frames} 帧</Tag>
              {info.fps && <Tag>FPS: {info.fps}</Tag>}
            </div>
          )}

          {info && info.n_episodes > 1 && info.format !== 'lerobot' && (
            <Form.Item label="Episode" style={{ marginTop: 8 }}>
              <Select
                value={episode}
                onChange={handleEpisodeChange}
                options={(info.episodes ?? Array.from({ length: info.n_episodes }, (_, i) => ({ episode_index: i, length: 0 }))).map(e => ({
                  label: `Episode ${e.episode_index} (${e.length}帧)`,
                  value: e.episode_index,
                }))}
                style={{ width: '100%' }}
              />
            </Form.Item>
          )}
        </Col>

        {/* Right panel */}
        <Col span={18}>
          {!selectedFile ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#999' }}>
              请在左侧选择数据集
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
              {/* Episode list sidebar — LeRobot only */}
              {info?.format === 'lerobot' && episodeItems.length > 0 && (
                <div style={{ width: 160, flexShrink: 0 }}>
                  <div style={{ fontWeight: 500, marginBottom: 6, fontSize: 13, color: '#333' }}>Episodes</div>
                  <div style={{
                    maxHeight: 620, overflowY: 'auto',
                    border: '1px solid #d9d9d9', borderRadius: 6,
                  }}>
                    {episodeItems.map(ep => (
                      <div
                        key={ep.episode_index}
                        style={{
                          padding: '7px 10px', cursor: 'pointer', fontSize: 13,
                          background: episode === ep.episode_index ? '#e6f4ff' : 'transparent',
                          borderBottom: '1px solid #f0f0f0',
                          borderLeft: episode === ep.episode_index ? '3px solid #1677ff' : '3px solid transparent',
                        }}
                        onClick={() => handleEpisodeChange(ep.episode_index)}
                      >
                        <div style={{ fontWeight: 500 }}>
                          Episode {String(ep.episode_index).padStart(3, '0')}
                        </div>
                        {ep.length > 0 && (
                          <div style={{ fontSize: 11, color: '#888' }}>{ep.length} 帧</div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Main visualization content */}
              <div style={{ flex: 1, minWidth: 0 }}>
                {/* Camera images */}
                {cameraList.length > 0 ? (
                  <VideoPlayer
                    path={selectedFile.path}
                    episode={episode}
                    cameras={cameraList.map(c => c.id)}
                    format={vizFormat}
                    currentFrame={currentFrame}
                    datasetFps={info?.fps ?? 30}
                    dataSource={dataSource}
                    creds={dataSource === 'remote' ? rCreds : undefined}
                    imgHeight={imgHeight}
                    style={{ marginBottom: 16 }}
                  />
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
                      <ChartTooltip />
                      <Legend />
                      {visibleFields.map((f, i) => (
                        <Line key={f} type="monotone" dataKey={f} stroke={COLORS[i % COLORS.length]} dot={false} strokeWidth={1.5} />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                )}

                <Divider>当前帧数据{dataSource === 'local' ? '（可编辑）' : ''}</Divider>
                <Table
                  dataSource={tableRows}
                  columns={tableCols}
                  size="small"
                  pagination={{ pageSize: 10 }}
                  rowKey="field"
                />
              </div>
            </div>
          )}
        </Col>
      </Row>
    </div>
  )
}
