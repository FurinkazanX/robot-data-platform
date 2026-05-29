import { useEffect, useRef, useState } from 'react'
import {
  Badge, Button, Col, Form, Input, Modal,
  Progress, Row, Space, Table, Tag, Tooltip, Typography, message,
} from 'antd'
import {
  ArrowRightOutlined, DeleteOutlined, PlusOutlined, StopOutlined,
} from '@ant-design/icons'
import FileManager from '../components/FileManager'
import {
  cancelTransfer, dismissJob, listAllJobs, startTransfer,
  type FileItem, type JobInfo,
} from '../api/client'
import { useAppContext } from '../context/AppContext'

const { Title, Text } = Typography

type BadgeStatus = 'default' | 'processing' | 'success' | 'error' | 'warning'

const JOB_STATUS: Record<string, { color: BadgeStatus; label: string }> = {
  pending:   { color: 'default',    label: '等待中' },
  running:   { color: 'processing', label: '进行中' },
  done:      { color: 'success',    label: '已完成' },
  failed:    { color: 'error',      label: '失败' },
  cancelled: { color: 'warning',    label: '已取消' },
}

// ── Transfer form modal ────────────────────────────────────────────────────────

function TransferModal({
  open,
  onClose,
  onStarted,
}: {
  open: boolean
  onClose: () => void
  onStarted: () => void
}) {
  const { transfer, setTransfer } = useAppContext()
  const { creds, remoteBase } = transfer

  const [localFiles, setLocalFiles] = useState<FileItem[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [remoteConnected, setRemoteConnected] = useState(false)

  const handleTransfer = async () => {
    if (!localFiles.length) return message.warning('请选择本地文件')
    if (!remoteBase) return message.warning('请选择远程目标目录')
    setSubmitting(true)
    try {
      await startTransfer({
        ...creds,
        local_paths: localFiles.filter(f => !f.is_dir).map(f => f.path),
        remote_base: remoteBase,
      })
      message.success('传输任务已启动')
      setLocalFiles([])
      onStarted()
    } catch {
      message.error('启动传输失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      title="新建传输任务"
      open={open}
      onCancel={() => { setLocalFiles([]); onClose() }}
      footer={null}
      width={1100}
      styles={{ body: { maxHeight: '80vh', overflowY: 'auto' } }}
    >
      <Row gutter={24} align="top">
        <Col span={11}>
          <FileManager
            mode="local"
            checkable
            title="本地文件"
            height={380}
            onSelect={(_, items) => setLocalFiles(items)}
          />
        </Col>

        <Col span={2} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 40 }}>
          <Button
            type="primary"
            icon={<ArrowRightOutlined />}
            disabled={!remoteConnected || !localFiles.length}
            loading={submitting}
            onClick={handleTransfer}
          >
            上传
          </Button>
        </Col>

        <Col span={11}>
          <FileManager
            mode="remote"
            title="远程目录"
            dirOnly
            height={340}
            initialCreds={creds}
            onConnect={c => { setTransfer({ creds: c }); setRemoteConnected(true) }}
            onSelect={(_, items) => { if (items[0]) setTransfer({ remoteBase: items[0].path }) }}
          />
          <Form.Item label="远程目标目录" style={{ marginTop: 8 }}>
            <Input
              value={remoteBase}
              onChange={e => setTransfer({ remoteBase: e.target.value })}
              placeholder="/home/user/robot_data"
            />
          </Form.Item>
        </Col>
      </Row>
    </Modal>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function Transfer() {
  const [jobs, setJobs] = useState<JobInfo[]>([])
  const [newTaskOpen, setNewTaskOpen] = useState(false)
  const [dismissing, setDismissing] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const fetchingRef = useRef(false)

  const fetchJobs = async () => {
    if (fetchingRef.current) return
    fetchingRef.current = true
    try {
      const all = await listAllJobs()
      setJobs(all.filter(j => j.job_type === 'transfer'))
    } catch {} finally {
      fetchingRef.current = false
    }
  }

  useEffect(() => {
    fetchJobs()
    timerRef.current = setInterval(fetchJobs, 3000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [])

  const handleCancel = async (job: JobInfo) => {
    try {
      await cancelTransfer(job.job_id)
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
        <Title level={4} style={{ margin: 0 }}>文件传输</Title>
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
        locale={{ emptyText: '暂无传输任务，点击「新建任务」创建' }}
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

      <TransferModal
        open={newTaskOpen}
        onClose={() => setNewTaskOpen(false)}
        onStarted={() => { setNewTaskOpen(false); fetchJobs() }}
      />
    </div>
  )
}
