import { useEffect, useRef, useState } from 'react'
import {
  Alert, AutoComplete, Badge, Button, Col, Divider, Form, Progress, Row, Select,
  Space, Spin, Table, Tag, Tooltip, Typography, message,
} from 'antd'
import {
  ClearOutlined, EyeOutlined, LoadingOutlined, PauseCircleOutlined, PlayCircleOutlined,
} from '@ant-design/icons'
import FileBrowser from '../components/FileBrowser'
import {
  getConverters, getMonitorStatus, listFiles, previewFile, startMonitor, stopMonitor,
  type FileItem, type PreviewResult, type QueueItem,
} from '../api/client'

const { Title, Text } = Typography

const LEROBOT_FIELDS = [
  'observation.state', 'action', 'timestamp',
  'observation.images.cam_main', 'observation.images.cam_wrist',
  'observation.images.cam_left', 'observation.images.cam_right',
]

interface MappingRow {
  hdf5_key: string
  shape: string
  dtype: string
  is_image: boolean
  lerobot_field: string
}

const STATUS_TAG: Record<string, { color: string; label: string }> = {
  waiting:    { color: 'gold',       label: '等待就绪' },
  pending:    { color: 'default',    label: '排队中'   },
  converting: { color: 'processing', label: '转换中'   },
  done:       { color: 'success',    label: '已完成'   },
  failed:     { color: 'error',      label: '失败'     },
}

export default function Monitor() {
  const [converters, setConverters] = useState<Array<{ key: string; name: string }>>([])
  const [selectedConverter, setSelectedConverter] = useState('hdf5->lerobot')
  const [sourceDir, setSourceDir] = useState<FileItem | null>(null)
  const [targetDir, setTargetDir] = useState<FileItem | null>(null)
  const [mapping, setMapping] = useState<MappingRow[]>([])
  const [preview, setPreview] = useState<PreviewResult | null>(null)

  const [monitorState, setMonitorState] = useState<'idle' | 'monitoring'>('idle')
  const [isConverting, setIsConverting] = useState(false)
  const [statusLoaded, setStatusLoaded] = useState(false)
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [runningDirs, setRunningDirs] = useState<{ source?: string; target?: string }>({})

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchStatus = async () => {
    try {
      const s = await getMonitorStatus()
      setMonitorState(s.state as 'idle' | 'monitoring')
      setIsConverting(s.is_converting)
      setQueue(s.queue ?? [])
      setRunningDirs({ source: s.source_dir, target: s.target_dir })
    } catch {}
  }

  useEffect(() => {
    getConverters().then(list => setConverters(list.map(c => ({ key: c.key, name: c.name }))))
    fetchStatus().finally(() => setStatusLoaded(true))
    timerRef.current = setInterval(fetchStatus, 3000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [])

  const handlePreviewDir = async () => {
    if (!sourceDir) return message.warning('请先选择监控目录')
    try {
      const { items } = await listFiles(sourceDir.path)
      const hdf5File = items.find(f => !f.is_dir && (f.ext === '.hdf5' || f.ext === '.h5'))
      if (!hdf5File) {
        message.warning('目录中暂无 HDF5 文件，将在监控时自动检测字段映射')
        return
      }
      const result = await previewFile(hdf5File.path)
      setPreview(result)
      setMapping(result.fields.map(f => ({
        hdf5_key: f.key,
        shape: f.shape.join('×'),
        dtype: f.dtype,
        is_image: f.is_image,
        lerobot_field: result.suggested_mapping[f.key] ?? '',
      })))
      message.success(`已从 ${hdf5File.name} 自动检测字段映射`)
    } catch {
      message.error('字段检测失败，将在监控时自动检测')
    }
  }

  const handleStart = async () => {
    if (!sourceDir) return message.warning('请选择监控目录')
    if (!targetDir) return message.warning('请选择目标目录')
    const field_mapping: Record<string, string> = {}
    mapping.forEach(r => { if (r.lerobot_field) field_mapping[r.hdf5_key] = r.lerobot_field })
    const [srcFmt, tgtFmt] = selectedConverter.split('->')
    try {
      await startMonitor({
        source_dir: sourceDir.path,
        target_dir: targetDir.path,
        field_mapping,
        source_format: srcFmt,
        target_format: tgtFmt,
      })
      setQueue([])
      setMonitorState('monitoring')
      setRunningDirs({ source: sourceDir.path, target: targetDir.path })
      message.success('监控已启动')
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      if (detail?.includes('已在运行中')) {
        message.warning('监控已在运行，正在同步状态...')
        await fetchStatus()
      } else {
        message.error('启动失败: ' + (detail ?? '未知错误'))
      }
    }
  }

  const handleStop = async () => {
    try {
      await stopMonitor()
      setMonitorState('idle')
      setIsConverting(false)
      message.success('监控已停止')
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      message.error(detail ?? '停止失败')
    }
  }

  const clearDone = () =>
    setQueue(q => q.filter(it => it.status === 'pending' || it.status === 'converting'))

  const mappingCols = [
    { title: 'HDF5 字段', dataIndex: 'hdf5_key', width: 220 },
    { title: '形状', dataIndex: 'shape', width: 110 },
    { title: '类型', dataIndex: 'dtype', width: 90 },
    { title: '图像', dataIndex: 'is_image', width: 55, render: (v: boolean) => v ? <Tag color="blue">是</Tag> : null },
    {
      title: 'LeRobot 字段',
      dataIndex: 'lerobot_field',
      render: (val: string, _: MappingRow, idx: number) => (
        <AutoComplete value={val} style={{ width: '100%' }} allowClear
          options={LEROBOT_FIELDS.map(f => ({ label: f, value: f }))}
          filterOption={(input, opt) => (opt?.value as string).toLowerCase().includes(input.toLowerCase())}
          onChange={v => setMapping(prev => prev.map((r, i) => i === idx ? { ...r, lerobot_field: v ?? '' } : r))}
        />
      ),
    },
  ]

  const stopDisabled = isConverting || monitorState === 'idle'
  const doneCount = queue.filter(it => it.status === 'done' || it.status === 'failed').length

  return (
    <div>
      <Title level={4}>数据监控</Title>

      <div style={{ marginBottom: 16 }}>
        {monitorState === 'monitoring' ? (
          <Space>
            <Badge status="processing" text={
              isConverting
                ? <Text type="warning">监控中（正在转换…）</Text>
                : <Text type="success">监控中（等待新文件）</Text>
            } />
            {runningDirs.source && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {runningDirs.source} → {runningDirs.target}
              </Text>
            )}
          </Space>
        ) : (
          <Badge status="default" text={<Text type="secondary">未监控</Text>} />
        )}
      </div>

      <Form layout="vertical">
        <Form.Item label="转换类型">
          <Select value={selectedConverter} onChange={setSelectedConverter} style={{ width: 240 }}
            options={converters.map(c => ({ label: c.name, value: c.key }))}
            disabled={monitorState === 'monitoring'} />
        </Form.Item>
      </Form>

      <Row gutter={24}>
        <Col span={12}>
          <FileBrowser title="监控目录（源数据）" dirOnly fileOps
            onSelect={(_, items) => setSourceDir(items[0] ?? null)}
            disabled={monitorState === 'monitoring'} />
          {sourceDir && (
            <Text type="secondary" style={{ display: 'block', marginTop: 4, fontSize: 12 }}>
              已选: {sourceDir.path}
            </Text>
          )}
          <Button icon={<EyeOutlined />} style={{ marginTop: 8 }} onClick={handlePreviewDir}
            disabled={!sourceDir || monitorState === 'monitoring'}>
            自动检测字段映射
          </Button>
        </Col>
        <Col span={12}>
          <FileBrowser title="目标目录（输出数据集）" dirOnly fileOps
            onSelect={(_, items) => setTargetDir(items[0] ?? null)}
            disabled={monitorState === 'monitoring'} />
          {targetDir && (
            <Text type="secondary" style={{ display: 'block', marginTop: 4, fontSize: 12 }}>
              已选: {targetDir.path}
            </Text>
          )}
        </Col>
      </Row>

      {preview && mapping.length > 0 && (
        <>
          <Divider>字段映射配置（共 {preview.n_frames} 帧）</Divider>
          <Table dataSource={mapping} columns={mappingCols} rowKey="hdf5_key" size="small" pagination={false} />
          <Alert type="info" showIcon style={{ marginTop: 8 }}
            message="此映射将用于所有新检测到的文件。若目录暂无文件，将在首个文件到达时自动检测。" />
        </>
      )}

      {!preview && (
        <Alert type="info" showIcon style={{ marginTop: 16 }}
          message="未配置字段映射 — 系统将在每个新文件到达时自动推断字段映射。建议提前选择样本文件进行配置以确保准确性。" />
      )}

      <Divider />
      <Space>
        <Button type="primary" icon={<PlayCircleOutlined />} onClick={handleStart}
          disabled={!statusLoaded || monitorState === 'monitoring' || !sourceDir || !targetDir}>
          开始监控
        </Button>
        <Tooltip title={isConverting ? '正在转换数据，转换完成后才能停止监控' : ''}
          open={isConverting ? undefined : false}>
          <Button danger icon={<PauseCircleOutlined />} onClick={handleStop}
            disabled={!statusLoaded || stopDisabled}>
            停止监控
          </Button>
        </Tooltip>
      </Space>

      {queue.length > 0 && (
        <>
          <Divider>
            <Space>
              转换队列（{queue.filter(it => it.status === 'converting').length} 转换中 ·{' '}
              {queue.filter(it => it.status === 'pending').length} 排队 ·{' '}
              {queue.filter(it => it.status === 'done').length} 完成 ·{' '}
              {queue.filter(it => it.status === 'failed').length} 失败）
              {doneCount > 0 && (
                <Button size="small" icon={<ClearOutlined />} onClick={clearDone}>
                  清除已完成
                </Button>
              )}
            </Space>
          </Divider>
          <div style={{ maxHeight: 360, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {queue.map((item, i) => {
              const tag = STATUS_TAG[item.status] ?? { color: 'default', label: item.status }
              const progressStatus =
                item.status === 'failed' ? 'exception' :
                item.status === 'done'   ? 'success'   : 'active'
              return (
                <div key={i} style={{
                  padding: '10px 14px',
                  background: '#fafafa',
                  border: '1px solid #f0f0f0',
                  borderRadius: 6,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <Text strong style={{ fontSize: 13, maxWidth: '80%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.file_name}
                    </Text>
                    <Tag color={tag.color} style={{ margin: 0 }}>{tag.label}</Tag>
                  </div>
                  {item.status === 'waiting' ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                      <Spin size="small" indicator={<LoadingOutlined spin style={{ fontSize: 14, color: '#faad14' }} />} />
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {item.message || '等待文件写入完成…'}
                      </Text>
                    </div>
                  ) : (
                    <>
                      <Progress percent={Math.round(item.percent)} size="small" status={progressStatus} />
                      {item.message && (
                        <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 2 }}>
                          {item.message}
                        </Text>
                      )}
                    </>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
