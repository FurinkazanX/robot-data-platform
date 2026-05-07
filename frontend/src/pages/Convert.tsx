import { useEffect, useRef, useState } from 'react'
import {
  AutoComplete, Badge, Button, Col, Divider, Form, Modal,
  Progress, Row, Select, Space, Switch, Table, Tag, Tooltip, Typography, message,
} from 'antd'
import {
  DeleteOutlined, EyeOutlined, PlusOutlined, StopOutlined,
} from '@ant-design/icons'
import FileBrowser from '../components/FileBrowser'
import {
  cancelConversion, dismissJob, getConverters, listAllJobs,
  previewFile, startConversion,
  type FileItem, type JobInfo, type PreviewResult,
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

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Convert() {
  const [jobs, setJobs] = useState<JobInfo[]>([])
  const [newTaskOpen, setNewTaskOpen] = useState(false)
  const [dismissing, setDismissing] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchJobs = async () => {
    try {
      const all = await listAllJobs()
      setJobs(all.filter(j => j.job_type === 'convert'))
    } catch {}
  }

  useEffect(() => {
    fetchJobs()
    timerRef.current = setInterval(fetchJobs, 3000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [])

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

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>数据转换</Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setNewTaskOpen(true)}>
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

      <Modal
        title="新建转换任务"
        open={newTaskOpen}
        onCancel={() => setNewTaskOpen(false)}
        footer={null}
        width={960}
        styles={{ body: { maxHeight: '78vh', overflowY: 'auto' } }}
        destroyOnClose
      >
        <ConvertForm onStarted={() => { setNewTaskOpen(false); fetchJobs() }} />
      </Modal>
    </div>
  )
}
