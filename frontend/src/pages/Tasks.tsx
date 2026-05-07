import { useEffect, useRef, useState } from 'react'
import {
  Badge, Button, Divider, Progress, Space, Table, Tag, Tooltip, Typography, message,
} from 'antd'
import {
  CheckCircleOutlined, CloseCircleOutlined, DeleteOutlined,
  LoadingOutlined, MinusCircleOutlined, PlusOutlined, SyncOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import {
  listAllJobs, dismissJob, getMonitorStatus,
  type JobInfo, type MonitorStatus,
} from '../api/client'
import NewTaskModal from '../components/NewTaskModal'

const { Title, Text } = Typography

const JOB_TYPE_LABEL: Record<string, string> = {
  convert: '数据转换',
  transfer: '文件传输',
}

const STATUS_CONFIG: Record<string, { color: string; label: string; icon: React.ReactNode }> = {
  pending:   { color: 'default',    label: '等待中',  icon: <MinusCircleOutlined /> },
  running:   { color: 'processing', label: '进行中',  icon: <LoadingOutlined spin /> },
  done:      { color: 'success',    label: '已完成',  icon: <CheckCircleOutlined /> },
  failed:    { color: 'error',      label: '失败',    icon: <CloseCircleOutlined /> },
  cancelled: { color: 'warning',    label: '已取消',  icon: <MinusCircleOutlined /> },
}

export default function Tasks() {
  const [jobs, setJobs] = useState<JobInfo[]>([])
  const [monitor, setMonitor] = useState<MonitorStatus | null>(null)
  const [dismissing, setDismissing] = useState<string | null>(null)
  const [newTaskOpen, setNewTaskOpen] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const navigate = useNavigate()

  const fetchAll = async () => {
    try {
      const [j, m] = await Promise.all([listAllJobs(), getMonitorStatus()])
      setJobs(j)
      setMonitor(m)
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    fetchAll()
    timerRef.current = setInterval(fetchAll, 3000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [])

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
      title: '类型',
      dataIndex: 'job_type',
      width: 100,
      render: (t: string) => <Tag>{JOB_TYPE_LABEL[t] ?? t}</Tag>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (s: string) => {
        const cfg = STATUS_CONFIG[s] ?? { color: 'default', label: s, icon: null }
        return <Badge status={cfg.color as Parameters<typeof Badge>[0]['status']} text={
          <Text style={{ fontSize: 13 }}>{cfg.label}</Text>
        } />
      },
    },
    {
      title: '当前文件',
      dataIndex: 'current_file',
      ellipsis: true,
      render: (f: string, row: JobInfo) => (
        <Tooltip title={row.message || f}>
          <Text style={{ fontSize: 12 }}>{f || row.message || '—'}</Text>
        </Tooltip>
      ),
    },
    {
      title: '进度',
      dataIndex: 'percent',
      width: 180,
      render: (pct: number, row: JobInfo) => (
        <Progress
          percent={Math.round(pct)}
          size="small"
          status={
            row.status === 'failed' ? 'exception' :
            row.status === 'done'   ? 'success'   :
            row.status === 'cancelled' ? 'exception' : 'active'
          }
        />
      ),
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      width: 160,
      render: (t: string) => (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t.replace('T', ' ').slice(0, 19)}
        </Text>
      ),
    },
    {
      title: '操作',
      width: 120,
      render: (_: unknown, row: JobInfo) => (
        <Button.Group size="small">
          <Button
            onClick={() => navigate(row.job_type === 'convert' ? '/convert' : '/transfer')}
          >
            查看
          </Button>
          <Tooltip title={row.status === 'running' ? '任务进行中，不可关闭' : '关闭并移除记录'}>
            <Button
              danger
              icon={<DeleteOutlined />}
              loading={dismissing === row.job_id}
              disabled={row.status === 'running'}
              onClick={() => handleDismiss(row.job_id)}
            />
          </Tooltip>
        </Button.Group>
      ),
    },
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>任务管理</Title>
        <Space>
          <Button icon={<SyncOutlined />} onClick={fetchAll}>刷新</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setNewTaskOpen(true)}>
            新建任务
          </Button>
        </Space>
      </div>

      {/* Monitor status card */}
      {monitor && (
        <>
          <div style={{
            padding: '12px 16px', background: '#fafafa',
            border: '1px solid #f0f0f0', borderRadius: 6, marginBottom: 16,
            display: 'flex', alignItems: 'center', gap: 16,
          }}>
            <Text strong>数据监控</Text>
            {monitor.state === 'monitoring' ? (
              <>
                <Badge status="processing" text={
                  monitor.is_converting
                    ? <Text type="warning">监控中（正在转换）</Text>
                    : <Text type="success">监控中（等待新文件）</Text>
                } />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  队列: {monitor.queue.length} 项
                </Text>
              </>
            ) : (
              <Badge status="default" text={<Text type="secondary">未运行</Text>} />
            )}
            <Button size="small" icon={<SyncOutlined />} onClick={() => navigate('/monitor')}>
              前往监控页
            </Button>
          </div>
          <Divider />
        </>
      )}

      <Table
        dataSource={jobs}
        columns={columns}
        rowKey="job_id"
        size="small"
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        locale={{ emptyText: '暂无任务记录' }}
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

      <NewTaskModal
        open={newTaskOpen}
        onClose={() => { setNewTaskOpen(false); fetchAll() }}
      />
    </div>
  )
}
