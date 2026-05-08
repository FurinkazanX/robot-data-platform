import { useEffect, useRef, useState } from 'react'
import {
  Badge, Button, Col, Dropdown, Form, Input, InputNumber, Modal,
  Progress, Row, Space, Table, Tag, Tooltip, Tree, Typography, message,
} from 'antd'
import {
  ArrowRightOutlined, DeleteOutlined, EditOutlined, FileOutlined,
  FolderAddOutlined, FolderOutlined, PlusOutlined, StopOutlined,
} from '@ant-design/icons'
import type { DataNode } from 'antd/es/tree'
import type { MenuProps } from 'antd'
import FileBrowser from '../components/FileBrowser'
import {
  cancelTransfer, dismissJob, listAllJobs, listRemote, remoteMkdir,
  remoteRename, remoteDelete, startTransfer, testConnection,
  type FileItem, type JobInfo, type SSHCreds,
} from '../api/client'
import { useAppContext } from '../context/AppContext'

const { Title, Text } = Typography

interface RemoteNode extends DataNode {
  isRemoteDir: boolean
  remotePath: string
}

type BadgeStatus = 'default' | 'processing' | 'success' | 'error' | 'warning'

const JOB_STATUS: Record<string, { color: BadgeStatus; label: string }> = {
  pending:   { color: 'default',    label: '等待中' },
  running:   { color: 'processing', label: '进行中' },
  done:      { color: 'success',    label: '已完成' },
  failed:    { color: 'error',      label: '失败' },
  cancelled: { color: 'warning',    label: '已取消' },
}

// ── Transfer form modal ───────────────────────────────────────────────────────

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
  const { creds, connected, remoteNodes, remoteBase, remotePath } = transfer

  const [connecting, setConnecting] = useState(false)
  const [localFiles, setLocalFiles] = useState<FileItem[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [mkdirModal, setMkdirModal] = useState(false)
  const [renameModal, setRenameModal] = useState(false)
  const [mkdirName, setMkdirName] = useState('')
  const [renameName, setRenameName] = useState('')
  const [contextNode, setContextNode] = useState<RemoteNode | null>(null)

  const patchCreds = (p: Partial<SSHCreds>) =>
    setTransfer({ creds: { ...creds, ...p } })

  const refreshRemote = async (path: string): Promise<RemoteNode[]> => {
    try {
      const { items } = await listRemote(creds, path)
      return items.map(i => ({
        key: i.path,
        title: i.name,
        isLeaf: !i.is_dir,
        isRemoteDir: i.is_dir,
        remotePath: i.path,
      }))
    } catch {
      return []
    }
  }

  const updateNodes = (nodes: RemoteNode[], key: string, children: RemoteNode[]): RemoteNode[] =>
    nodes.map(n => {
      if (n.key === key) return { ...n, children }
      if (n.children) return { ...n, children: updateNodes(n.children as RemoteNode[], key, children) }
      return n
    })

  const handleConnect = async () => {
    if (!creds.host || !creds.username) return message.warning('请填写主机和用户名')
    setConnecting(true)
    try {
      await testConnection(creds)
      const nodes = await refreshRemote('/')
      setTransfer({ connected: true, remoteNodes: nodes, remotePath: '/' })
      message.success('连接成功')
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      message.error('连接失败: ' + (detail ?? String(e)))
    } finally {
      setConnecting(false)
    }
  }

  const handleLoadRemoteRoot = async (path: string) => {
    const nodes = await refreshRemote(path)
    setTransfer({ remoteNodes: nodes, remotePath: path })
  }

  const handleMkdir = async () => {
    if (!mkdirName.trim()) return
    const parent = contextNode?.remotePath ?? remotePath
    const newPath = `${parent.replace(/\/$/, '')}/${mkdirName.trim()}`
    try {
      await remoteMkdir(creds, newPath)
      message.success('目录已创建')
      setMkdirModal(false)
      setMkdirName('')
      await handleLoadRemoteRoot(remotePath)
    } catch (e: unknown) {
      message.error('创建失败: ' + (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail)
    }
  }

  const handleRename = async () => {
    if (!renameName.trim() || !contextNode) return
    const dir = contextNode.remotePath.substring(0, contextNode.remotePath.lastIndexOf('/')) || '/'
    const newPath = `${dir}/${renameName.trim()}`
    try {
      await remoteRename(creds, contextNode.remotePath, newPath)
      message.success('重命名成功')
      setRenameModal(false)
      await handleLoadRemoteRoot(remotePath)
    } catch (e: unknown) {
      message.error('重命名失败: ' + (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail)
    }
  }

  const handleDelete = (node: RemoteNode) => {
    Modal.confirm({
      title: `确认删除 "${node.title}"？`,
      content: node.isRemoteDir ? '将递归删除目录及其所有内容' : '文件将被永久删除',
      okType: 'danger',
      okText: '删除',
      cancelText: '取消',
      onOk: async () => {
        try {
          await remoteDelete(creds, node.remotePath)
          message.success('已删除')
          await handleLoadRemoteRoot(remotePath)
        } catch (e: unknown) {
          message.error('删除失败: ' + (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail)
        }
      },
    })
  }

  const contextMenuItems = (node: RemoteNode): MenuProps['items'] => [
    {
      key: 'mkdir',
      icon: <FolderAddOutlined />,
      label: '在此新建目录',
      onClick: () => { setContextNode(node); setMkdirName(''); setMkdirModal(true) },
    },
    {
      key: 'rename',
      icon: <EditOutlined />,
      label: '重命名',
      onClick: () => { setContextNode(node); setRenameName(node.title as string); setRenameModal(true) },
    },
    { type: 'divider' },
    {
      key: 'delete',
      icon: <DeleteOutlined />,
      label: '删除',
      danger: true,
      onClick: () => handleDelete(node),
    },
  ]

  const handleTransfer = async () => {
    if (!localFiles.length) return message.warning('请选择本地文件')
    if (!remoteBase) return message.warning('请填写远程目标目录')
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
      {/* SSH connection form */}
      <Form layout="inline" style={{ marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <Form.Item label="主机 IP">
          <Input value={creds.host} onChange={e => patchCreds({ host: e.target.value })}
            placeholder="192.168.1.100" style={{ width: 160 }} disabled={connected} />
        </Form.Item>
        <Form.Item label="端口">
          <InputNumber value={creds.port} onChange={v => patchCreds({ port: v ?? 22 })}
            style={{ width: 80 }} disabled={connected} />
        </Form.Item>
        <Form.Item label="用户名">
          <Input value={creds.username} onChange={e => patchCreds({ username: e.target.value })}
            style={{ width: 120 }} disabled={connected} />
        </Form.Item>
        <Form.Item label="密码">
          <Input.Password value={creds.password ?? ''} onChange={e => patchCreds({ password: e.target.value })}
            style={{ width: 140 }} disabled={connected} />
        </Form.Item>
        <Form.Item>
          {connected ? (
            <Space>
              <Tag color="green">已连接</Tag>
              <Button size="small"
                onClick={() => setTransfer({ connected: false, remoteNodes: [] })}>
                断开
              </Button>
            </Space>
          ) : (
            <Button type="primary" loading={connecting} onClick={handleConnect}>连接</Button>
          )}
        </Form.Item>
      </Form>

      <Row gutter={24} align="top">
        <Col span={11}>
          <FileBrowser title="本地文件" checkable
            onSelect={(_, items) => setLocalFiles(items)} />
        </Col>

        <Col span={2} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 40 }}>
          <Button type="primary" icon={<ArrowRightOutlined />}
            disabled={!connected || !localFiles.length}
            loading={submitting}
            onClick={handleTransfer}>
            上传
          </Button>
        </Col>

        <Col span={11}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8, gap: 8 }}>
            <span style={{ fontWeight: 500 }}>远程目录</span>
            {connected && (
              <>
                <Input size="small" value={remotePath}
                  onChange={e => setTransfer({ remotePath: e.target.value })}
                  onPressEnter={() => handleLoadRemoteRoot(remotePath)}
                  style={{ width: 180 }} placeholder="/home/user/data" />
                <Button size="small" onClick={() => handleLoadRemoteRoot(remotePath)}>刷新</Button>
                <Button size="small" icon={<FolderAddOutlined />}
                  onClick={() => { setContextNode(null); setMkdirName(''); setMkdirModal(true) }}
                  title="在当前路径新建目录" />
              </>
            )}
          </div>

          {connected ? (
            <>
              <Tree
                treeData={remoteNodes as DataNode[]}
                loadData={async ({ key }) => {
                  const children = await refreshRemote(key as string)
                  setTransfer({ remoteNodes: updateNodes(remoteNodes as RemoteNode[], key as string, children) })
                }}
                onSelect={(_, info) => {
                  const n = info.node as unknown as RemoteNode
                  if (n.isRemoteDir) setTransfer({ remoteBase: n.remotePath })
                }}
                titleRender={node => {
                  const n = node as unknown as RemoteNode
                  return (
                    <Dropdown menu={{ items: contextMenuItems(n) }} trigger={['contextMenu']}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        {n.isRemoteDir
                          ? <FolderOutlined style={{ color: '#faad14', flexShrink: 0 }} />
                          : <FileOutlined style={{ flexShrink: 0 }} />}
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {n.title as string}
                        </span>
                      </span>
                    </Dropdown>
                  )
                }}
                style={{ maxHeight: 340, overflow: 'auto', border: '1px solid #d9d9d9', borderRadius: 6, padding: 8 }}
              />
              <Form.Item label="远程目标目录" style={{ marginTop: 8 }}>
                <Input value={remoteBase} onChange={e => setTransfer({ remoteBase: e.target.value })}
                  placeholder="/home/user/robot_data" />
              </Form.Item>
            </>
          ) : (
            <div style={{ padding: 24, color: '#999', border: '1px dashed #d9d9d9', borderRadius: 6 }}>
              请先连接远程服务器
            </div>
          )}
        </Col>
      </Row>

      {/* Nested modals for remote file ops */}
      <Modal title="新建目录" open={mkdirModal} onOk={handleMkdir} onCancel={() => setMkdirModal(false)} okText="创建">
        <Form layout="vertical">
          <Form.Item label={contextNode ? `在 "${contextNode.title}" 下新建` : `在 "${remotePath}" 下新建`}>
            <Input value={mkdirName} onChange={e => setMkdirName(e.target.value)}
              placeholder="目录名称" onPressEnter={handleMkdir} autoFocus />
          </Form.Item>
        </Form>
      </Modal>
      <Modal title="重命名" open={renameModal} onOk={handleRename} onCancel={() => setRenameModal(false)} okText="确认">
        <Form layout="vertical">
          <Form.Item label="新名称">
            <Input value={renameName} onChange={e => setRenameName(e.target.value)}
              onPressEnter={handleRename} autoFocus />
          </Form.Item>
        </Form>
      </Modal>
    </Modal>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

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
