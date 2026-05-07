import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert, AutoComplete, Badge, Button, Col, Divider, Form, Modal,
  Progress, Row, Select, Space, Switch, Table, Tabs, Tag, Tooltip, Typography, message,
} from 'antd'
import {
  DeleteOutlined, EyeOutlined, PauseCircleOutlined,
  PlayCircleOutlined, PlusOutlined, StopOutlined,
} from '@ant-design/icons'
import FileBrowser from '../components/FileBrowser'
import {
  cancelConversion, dismissJob, getConverters, getMonitorStatus, listAllJobs,
  listFiles, previewFile, startConversion, startMonitor, stopMonitor,
  type FileItem, type JobInfo, type MonitorStatus, type PreviewResult,
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

type BadgeStatus = 'default' | 'processing' | 'success' | 'error' | 'warning'

const JOB_STATUS: Record<string, { color: BadgeStatus; label: string }> = {
  pending:   { color: 'default',    label: '等待中' },
  running:   { color: 'processing', label: '进行中' },
  done:      { color: 'success',    label: '已完成' },
  failed:    { color: 'error',      label: '失败' },
  cancelled: { color: 'warning',    label: '已取消' },
}

const QUEUE_TAG: Record<string, { color: string; label: string }> = {
  waiting:    { color: 'gold',       label: '等待就绪' },
  pending:    { color: 'default',    label: '排队中' },
  converting: { color: 'processing', label: '转换中' },
  done:       { color: 'success',    label: '已完成' },
  failed:     { color: 'error',      label: '失败' },
}

// ── Batch convert form ────────────────────────────────────────────────────────

function ConvertForm({ onStarted }: { onStarted: () => void }) {
  const [converters, setConverters] = useState<Array<{ key: string; name: string }>>([])
  const [selectedConverter, setSelectedConverter] = useState('hdf5->lerobot')
  const [srcFiles, setSrcFiles] = useState<FileItem[]>([])
  const [dstDir, setDstDir] = useState<FileItem | null>(null)
  const [incremental, setIncremental] = useState(false)
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [mapping, setMapping] = useState<MappingRow[]>([])
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    getConverters().then(list => setConverters(list.map(c => ({ key: c.key, name: c.name }))))
  }, [])

  const handlePreview = async () => {
    const first = srcFiles.find(f => !f.is_dir)
    if (!first) return message.warning('请选择至少一个 HDF5 文件')
    try {
      const result = await previewFile(first.path)
      setPreview(result)
      setMapping(result.fields.map(f => ({
        hdf5_key: f.key, shape: f.shape.join('×'), dtype: f.dtype,
        is_image: f.is_image, lerobot_field: result.suggested_mapping[f.key] ?? '',
      })))
    } catch {
      message.error('字段解析失败')
    }
  }

  const handleStart = async () => {
    if (!srcFiles.length) return message.warning('请选择源文件')
    if (!dstDir) return message.warning('请选择目标目录')
    const field_mapping: Record<string, string> = {}
    mapping.forEach(r => { if (r.lerobot_field) field_mapping[r.hdf5_key] = r.lerobot_field })
    const [srcFmt, tgtFmt] = selectedConverter.split('->')
    setSubmitting(true)
    try {
      await startConversion({
        src_paths: srcFiles.filter(f => !f.is_dir).map(f => f.path),
        dst_path: dstDir.path,
        field_mapping,
        incremental,
        source_format: srcFmt,
        target_format: tgtFmt,
      })
      message.success('转换任务已启动')
      onStarted()
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      message.error('启动失败: ' + (detail ?? '未知错误'))
    } finally {
      setSubmitting(false)
    }
  }

  const mappingCols = [
    { title: 'HDF5 字段', dataIndex: 'hdf5_key', width: 200 },
    { title: '形状', dataIndex: 'shape', width: 100 },
    { title: '类型', dataIndex: 'dtype', width: 80 },
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

  return (
    <div>
      <Form layout="vertical">
        <Form.Item label="转换类型">
          <Select value={selectedConverter} onChange={setSelectedConverter} style={{ width: 240 }}
            options={converters.map(c => ({ label: c.name, value: c.key }))} />
        </Form.Item>
      </Form>

      <Row gutter={16}>
        <Col span={12}>
          <FileBrowser title="源文件（选择 HDF5）" checkable filterExt={['.h5', '.hdf5']}
            onSelect={(_, items) => setSrcFiles(items)} />
          <Button icon={<EyeOutlined />} size="small" style={{ marginTop: 6 }} onClick={handlePreview}
            disabled={!srcFiles.length}>
            解析字段结构
          </Button>
        </Col>
        <Col span={12}>
          <FileBrowser title="目标数据集目录" dirOnly fileOps
            onSelect={(_, items) => setDstDir(items[0] ?? null)} />
          {dstDir && (
            <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
              已选: {dstDir.path}
            </Text>
          )}
          <Form layout="vertical" style={{ marginTop: 12 }}>
            <Form.Item label="增量追加（保留已有 episode）" style={{ marginBottom: 0 }}>
              <Switch checked={incremental} onChange={setIncremental} />
            </Form.Item>
          </Form>
        </Col>
      </Row>

      {preview && mapping.length > 0 && (
        <>
          <Divider style={{ margin: '12px 0' }}>字段映射（{preview.n_frames} 帧）</Divider>
          <Table dataSource={mapping} columns={mappingCols} rowKey="hdf5_key" size="small" pagination={false} />
        </>
      )}

      <Divider style={{ margin: '16px 0' }} />
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button type="primary" loading={submitting}
          disabled={!srcFiles.length || !dstDir} onClick={handleStart}>
          开始转换
        </Button>
      </div>
    </div>
  )
}

// ── Monitor config form ───────────────────────────────────────────────────────

function MonitorForm({ onStarted }: { onStarted: () => void }) {
  const [converters, setConverters] = useState<Array<{ key: string; name: string }>>([])
  const [selectedConverter, setSelectedConverter] = useState('hdf5->lerobot')
  const [sourceDir, setSourceDir] = useState<FileItem | null>(null)
  const [targetDir, setTargetDir] = useState<FileItem | null>(null)
  const [mapping, setMapping] = useState<MappingRow[]>([])
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    getConverters().then(list => setConverters(list.map(c => ({ key: c.key, name: c.name }))))
  }, [])

  const handlePreviewDir = async () => {
    if (!sourceDir) return message.warning('请先选择监控目录')
    try {
      const { items } = await listFiles(sourceDir.path)
      const hdf5File = items.find(f => !f.is_dir && (f.ext === '.hdf5' || f.ext === '.h5'))
      if (!hdf5File) return message.warning('目录中暂无 HDF5 文件，将在监控时自动检测字段映射')
      const result = await previewFile(hdf5File.path)
      setPreview(result)
      setMapping(result.fields.map(f => ({
        hdf5_key: f.key, shape: f.shape.join('×'), dtype: f.dtype,
        is_image: f.is_image, lerobot_field: result.suggested_mapping[f.key] ?? '',
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
    setSubmitting(true)
    try {
      await startMonitor({
        source_dir: sourceDir.path,
        target_dir: targetDir.path,
        field_mapping,
        source_format: srcFmt,
        target_format: tgtFmt,
      })
      message.success('目录监控已启动')
      onStarted()
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      if (detail?.includes('已在运行中')) {
        message.warning('监控已在运行中')
        onStarted()
      } else {
        message.error('启动失败: ' + (detail ?? '未知错误'))
      }
    } finally {
      setSubmitting(false)
    }
  }

  const mappingCols = [
    { title: 'HDF5 字段', dataIndex: 'hdf5_key', width: 200 },
    { title: '形状', dataIndex: 'shape', width: 100 },
    { title: '类型', dataIndex: 'dtype', width: 80 },
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

  return (
    <div>
      <Form layout="vertical">
        <Form.Item label="转换类型">
          <Select value={selectedConverter} onChange={setSelectedConverter} style={{ width: 240 }}
            options={converters.map(c => ({ label: c.name, value: c.key }))} />
        </Form.Item>
      </Form>

      <Row gutter={16}>
        <Col span={12}>
          <FileBrowser title="监控目录（源数据）" dirOnly fileOps
            onSelect={(_, items) => setSourceDir(items[0] ?? null)} />
          {sourceDir && (
            <Text type="secondary" style={{ display: 'block', marginTop: 4, fontSize: 12 }}>
              已选: {sourceDir.path}
            </Text>
          )}
          <Button icon={<EyeOutlined />} size="small" style={{ marginTop: 8 }} onClick={handlePreviewDir}
            disabled={!sourceDir}>
            自动检测字段映射
          </Button>
        </Col>
        <Col span={12}>
          <FileBrowser title="目标目录（输出数据集）" dirOnly fileOps
            onSelect={(_, items) => setTargetDir(items[0] ?? null)} />
          {targetDir && (
            <Text type="secondary" style={{ display: 'block', marginTop: 4, fontSize: 12 }}>
              已选: {targetDir.path}
            </Text>
          )}
        </Col>
      </Row>

      {preview && mapping.length > 0 && (
        <>
          <Divider style={{ margin: '12px 0' }}>字段映射（{preview.n_frames} 帧）</Divider>
          <Table dataSource={mapping} columns={mappingCols} rowKey="hdf5_key" size="small" pagination={false} />
        </>
      )}
      {!preview && (
        <Alert type="info" showIcon style={{ marginTop: 16 }}
          message="未配置字段映射 — 系统将在每个新文件到达时自动推断字段映射" />
      )}

      <Divider style={{ margin: '16px 0' }} />
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button type="primary" loading={submitting}
          disabled={!sourceDir || !targetDir} onClick={handleStart}>
          开始监控
        </Button>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Convert() {
  const [jobs, setJobs] = useState<JobInfo[]>([])
  const [monitorStatus, setMonitorStatus] = useState<MonitorStatus | null>(null)
  const [newTaskOpen, setNewTaskOpen] = useState(false)
  const [newTaskTab, setNewTaskTab] = useState('convert')
  const [dismissing, setDismissing] = useState<string | null>(null)
  const [stopping, setStopping] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchAll = useCallback(async () => {
    try {
      const [all, mon] = await Promise.all([listAllJobs(), getMonitorStatus()])
      setJobs(all.filter(j => j.job_type === 'convert'))
      setMonitorStatus(mon)
    } catch {}
  }, [])

  useEffect(() => {
    fetchAll()
    timerRef.current = setInterval(fetchAll, 3000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [fetchAll])

  const handleCancel = async (job: JobInfo) => {
    try {
      await cancelConversion(job.job_id)
      message.info('已发送停止指令')
    } catch {
      message.error('停止失败')
    }
  }

  const handleDismiss = async (jobId: string) => {
    setDismissing(jobId)
    try {
      await dismissJob(jobId)
      setJobs(prev => prev.filter(j => j.job_id !== jobId))
    } catch {
      message.error('关闭失败')
    } finally {
      setDismissing(null)
    }
  }

  const handleStopMonitor = async () => {
    setStopping(true)
    try {
      await stopMonitor()
      message.success('监控已停止')
      await fetchAll()
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      message.error(detail ?? '停止失败')
    } finally {
      setStopping(false)
    }
  }

  const columns = [
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (s: string) => {
        const cfg = JOB_STATUS[s] ?? { color: 'default' as BadgeStatus, label: s }
        return <Badge status={cfg.color} text={cfg.label} />
      },
    },
    {
      title: '文件/说明',
      ellipsis: true,
      render: (_: unknown, row: JobInfo) => (
        <Tooltip title={row.message || row.current_file}>
          <Text style={{ fontSize: 12 }}>{row.current_file || row.message || '—'}</Text>
        </Tooltip>
      ),
    },
    {
      title: '进度',
      dataIndex: 'percent',
      width: 160,
      render: (pct: number, row: JobInfo) => (
        <Progress percent={Math.round(pct)} size="small"
          status={
            row.status === 'failed' || row.status === 'cancelled' ? 'exception' :
            row.status === 'done' ? 'success' : 'active'
          }
        />
      ),
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      width: 140,
      render: (t: string) => (
        <Text type="secondary" style={{ fontSize: 12 }}>{t.replace('T', ' ').slice(0, 16)}</Text>
      ),
    },
    {
      title: '操作',
      width: 110,
      render: (_: unknown, row: JobInfo) => (
        <Space size={4}>
          {row.status === 'running' && (
            <Button size="small" danger icon={<StopOutlined />} onClick={() => handleCancel(row)}>停止</Button>
          )}
          <Tooltip title={row.status === 'running' ? '任务进行中，不可关闭' : '关闭并移除记录'}>
            <Button size="small" icon={<DeleteOutlined />}
              loading={dismissing === row.job_id}
              disabled={row.status === 'running'}
              onClick={() => handleDismiss(row.job_id)}
            />
          </Tooltip>
        </Space>
      ),
    },
  ]

  const isConverting = monitorStatus?.is_converting ?? false
  const stopDisabled = stopping || isConverting || monitorStatus?.state !== 'monitoring'

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>数据转换</Title>
        <Button type="primary" icon={<PlusOutlined />}
          onClick={() => { setNewTaskOpen(true); setNewTaskTab('convert') }}>
          新建任务
        </Button>
      </div>

      <Table
        dataSource={jobs}
        columns={columns}
        rowKey="job_id"
        size="small"
        pagination={{ pageSize: 10, hideOnSinglePage: true }}
        locale={{ emptyText: '暂无转换任务，点击「新建任务」创建' }}
        expandable={{
          rowExpandable: row => !!row.error,
          expandedRowRender: row => (
            <pre style={{
              background: '#f5f5f5', padding: 12, borderRadius: 6,
              fontSize: 11, maxHeight: 200, overflow: 'auto', margin: 0,
            }}>
              {row.error}
            </pre>
          ),
        }}
      />

      {/* Monitor status section */}
      {monitorStatus && (
        <>
          <Divider style={{ margin: '20px 0 12px' }}>目录监控</Divider>
          <div style={{
            padding: '12px 16px', background: '#fafafa',
            border: '1px solid #f0f0f0', borderRadius: 6,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
              {monitorStatus.state === 'monitoring' ? (
                <>
                  <Badge status="processing" text={
                    isConverting
                      ? <Text type="warning">监控中（正在转换…）</Text>
                      : <Text type="success">监控中（等待新文件）</Text>
                  } />
                  {monitorStatus.source_dir && (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {monitorStatus.source_dir} → {monitorStatus.target_dir}
                    </Text>
                  )}
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    队列: {monitorStatus.queue.length} 项
                  </Text>
                  <Tooltip title={isConverting ? '正在转换数据，转换完成后才能停止' : ''}>
                    <Button danger size="small" icon={<PauseCircleOutlined />}
                      loading={stopping} disabled={stopDisabled} onClick={handleStopMonitor}>
                      停止监控
                    </Button>
                  </Tooltip>
                </>
              ) : (
                <>
                  <Badge status="default" text={<Text type="secondary">未运行</Text>} />
                  <Button size="small" icon={<PlayCircleOutlined />}
                    onClick={() => { setNewTaskOpen(true); setNewTaskTab('monitor') }}>
                    配置并启动
                  </Button>
                </>
              )}
            </div>

            {monitorStatus.state === 'monitoring' && monitorStatus.queue.length > 0 && (
              <div style={{
                marginTop: 10, maxHeight: 180, overflowY: 'auto',
                display: 'flex', flexDirection: 'column', gap: 3,
              }}>
                {monitorStatus.queue.map((item, i) => {
                  const tag = QUEUE_TAG[item.status] ?? { color: 'default', label: item.status }
                  return (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                      <Tag color={tag.color} style={{ margin: 0, flexShrink: 0 }}>{tag.label}</Tag>
                      <Text ellipsis style={{ flex: 1 }}>{item.file_name}</Text>
                      {item.status === 'converting' && (
                        <Text type="secondary" style={{ flexShrink: 0 }}>
                          {Math.round(item.percent)}%
                        </Text>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </>
      )}

      {/* New task modal */}
      <Modal
        title="新建任务"
        open={newTaskOpen}
        onCancel={() => setNewTaskOpen(false)}
        footer={null}
        width={960}
        styles={{ body: { maxHeight: '78vh', overflowY: 'auto' } }}
        destroyOnClose
      >
        <Tabs
          activeKey={newTaskTab}
          onChange={setNewTaskTab}
          items={[
            {
              key: 'convert',
              label: '批量转换',
              children: <ConvertForm onStarted={() => { setNewTaskOpen(false); fetchAll() }} />,
            },
            {
              key: 'monitor',
              label: '目录监控',
              children: <MonitorForm onStarted={() => { setNewTaskOpen(false); fetchAll() }} />,
            },
          ]}
        />
      </Modal>
    </div>
  )
}
