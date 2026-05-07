import { useEffect, useRef, useState } from 'react'
import {
  Button, Col, Divider, Dropdown, Form, Input, InputNumber,
  Modal, Progress, Row, Tag, Typography, message,
} from 'antd'
import {
  ArrowRightOutlined, FolderAddOutlined, EditOutlined,
  DeleteOutlined, FolderOutlined, FileOutlined, StopOutlined,
} from '@ant-design/icons'
import type { MenuProps } from 'antd'
import { Tree } from 'antd'
import type { DataNode } from 'antd/es/tree'
import FileBrowser from '../components/FileBrowser'
import {
  testConnection, listRemote, startTransfer, cancelTransfer, listAllJobs,
  remoteMkdir, remoteRename, remoteDelete,
  type SSHCreds,
} from '../api/client'
import { useAppContext } from '../context/AppContext'

const { Title, Text } = Typography

interface RemoteNode extends DataNode {
  isRemoteDir: boolean
  remotePath: string
}

export default function Transfer() {
  const { transfer, setTransfer } = useAppContext()
  const { creds, connected, remoteNodes, remoteBase, remotePath, localFiles, job } = transfer
  const { jobId, progress, running } = job

  // Local UI state — no persistence needed
  const [connecting, setConnecting] = useState(false)
  const [remoteChecked, setRemoteChecked] = useState<string[]>([])
  const [contextNode, setContextNode] = useState<RemoteNode | null>(null)
  const [mkdirModal, setMkdirModal] = useState(false)
  const [renameModal, setRenameModal] = useState(false)
  const [mkdirName, setMkdirName] = useState('')
  const [renameName, setRenameName] = useState('')
  const wsRef = useRef<WebSocket | null>(null)

  // Reconnect WS on page revisit if job was still running
  useEffect(() => {
    if (jobId && running && !wsRef.current) {
      connectWs(jobId)
      return
    }
    if (!jobId) {
      listAllJobs().then(jobs => {
        const active = jobs.find(j => j.job_type === 'transfer' && j.status === 'running')
        if (active) {
          setTransfer({ job: { jobId: active.job_id, progress: active as unknown as Record<string, unknown>, running: true } })
          connectWs(active.job_id)
        }
      }).catch(() => {})
    }
  }, [])

  const patchCreds = (patch: Partial<SSHCreds>) =>
    setTransfer({ creds: { ...creds, ...patch } })

  const connectWs = (id: string) => {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${protocol}://${location.host}/api/transfer/ws/${id}`)
    ws.onmessage = e => {
      const data = JSON.parse(e.data)
      if (data.ping) return
      setTransfer({ job: { jobId: id, progress: data, running: data.status === 'running' } })
      if (data.status === 'done') message.success('传输完成！')
      if (data.status === 'failed') message.error('传输失败，请查看详情')
    }
    ws.onclose = () => setTransfer({ job: { jobId: id, progress: {}, running: false } })
    wsRef.current = ws
  }

  const handleConnect = async () => {
    if (!creds.host || !creds.username) return message.warning('请填写主机和用户名')
    setConnecting(true)
    try {
      await testConnection(creds)
      setTransfer({ connected: true })
      message.success('连接成功')
      await handleLoadRemoteRoot('/')
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      message.error('连接失败: ' + (detail ?? String(e)))
    } finally {
      setConnecting(false)
    }
  }

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

  const updateRemoteNodes = (nodes: RemoteNode[], key: string, children: RemoteNode[]): RemoteNode[] =>
    nodes.map(n => {
      if (n.key === key) return { ...n, children }
      if (n.children) return { ...n, children: updateRemoteNodes(n.children as RemoteNode[], key, children) }
      return n
    })

  const handleLoadRemoteRoot = async (path: string) => {
    const nodes = await refreshRemote(path)
    setTransfer({ remoteNodes: nodes, remotePath: path })
  }

  const handleMkdir = async () => {
    if (!mkdirName.trim()) return
    const parent = contextNode?.remotePath ?? remoteBase
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
      setRenameName('')
      await handleLoadRemoteRoot(remotePath)
    } catch (e: unknown) {
      message.error('重命名失败: ' + (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail)
    }
  }

  const handleDelete = async (node: RemoteNode) => {
    Modal.confirm({
      title: `确认删除 "${node.title}"？`,
      content: node.isRemoteDir ? '将递归删除目录及其所有内容' : '文件将被永久删除',
      okType: 'danger',
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
    try {
      const { job_id } = await startTransfer({
        ...creds,
        local_paths: localFiles.filter(f => !f.is_dir).map(f => f.path),
        remote_base: remoteBase,
      })
      setTransfer({ job: { jobId: job_id, progress: {}, running: true } })
      connectWs(job_id)
    } catch {
      message.error('启动传输失败')
    }
  }

  const handleStop = async () => {
    if (!jobId) return
    try {
      await cancelTransfer(jobId)
      message.info('已发送停止指令，当前文件传输完成后停止')
    } catch {
      message.error('停止失败')
    }
  }

  const pct = typeof (progress as { percent?: number }).percent === 'number'
    ? (progress as { percent: number }).percent : 0
  const status = (progress as { status?: string }).status
  const isCancelled = status === 'cancelled'

  return (
    <div>
      <Title level={4}>文件传输</Title>

      <Form layout="inline" style={{ marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <Form.Item label="主机 IP">
          <Input value={creds.host} onChange={e => patchCreds({ host: e.target.value })}
            placeholder="192.168.1.100" style={{ width: 160 }} />
        </Form.Item>
        <Form.Item label="端口">
          <InputNumber value={creds.port} onChange={v => patchCreds({ port: v ?? 22 })} style={{ width: 80 }} />
        </Form.Item>
        <Form.Item label="用户名">
          <Input value={creds.username} onChange={e => patchCreds({ username: e.target.value })} style={{ width: 120 }} />
        </Form.Item>
        <Form.Item label="密码">
          <Input.Password value={creds.password ?? ''} onChange={e => patchCreds({ password: e.target.value })} style={{ width: 140 }} />
        </Form.Item>
        <Form.Item>
          <Button type="primary" loading={connecting} onClick={handleConnect}>连接</Button>
          {connected && <Tag color="green" style={{ marginLeft: 8 }}>已连接</Tag>}
        </Form.Item>
      </Form>

      <Row gutter={24} align="top">
        <Col span={11}>
          <FileBrowser title="本地文件" checkable
            onSelect={(_, items) => setTransfer({ localFiles: items })} />
        </Col>

        <Col span={2} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 40, gap: 8 }}>
          <Button type="primary" icon={<ArrowRightOutlined />}
            disabled={!connected || !localFiles.length} loading={running} onClick={handleTransfer}>
            上传
          </Button>
          {jobId && (
            <Button danger icon={<StopOutlined />} onClick={handleStop} disabled={!running}>
              停止
            </Button>
          )}
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
            <Tree
              checkable
              treeData={remoteNodes as DataNode[]}
              checkedKeys={remoteChecked}
              onCheck={keys => setRemoteChecked(
                Array.isArray(keys) ? (keys as string[]) : (keys.checked as string[])
              )}
              loadData={async ({ key }) => {
                const children = await refreshRemote(key as string)
                setTransfer({ remoteNodes: updateRemoteNodes(remoteNodes as RemoteNode[], key as string, children) })
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
              style={{ maxHeight: 400, overflow: 'auto', border: '1px solid #d9d9d9', borderRadius: 6, padding: 8 }}
            />
          ) : (
            <div style={{ padding: 24, color: '#999', border: '1px dashed #d9d9d9', borderRadius: 6 }}>
              请先连接远程服务器
            </div>
          )}

          <Form.Item label="远程目标目录" style={{ marginTop: 8 }}>
            <Input value={remoteBase} onChange={e => setTransfer({ remoteBase: e.target.value })}
              placeholder="/home/user/robot_data" />
          </Form.Item>
        </Col>
      </Row>

      {jobId && (
        <>
          <Divider />
          <Text type="secondary">任务 ID: {jobId}</Text>
          <Progress
            percent={pct}
            status={status === 'failed' ? 'exception' : status === 'done' ? 'success' : isCancelled ? 'exception' : 'active'}
            style={{ marginTop: 8 }}
          />
          {isCancelled && (
            <div><Text type="warning">传输已取消</Text></div>
          )}
          {(progress as { message?: string }).message && (
            <div><Text type="secondary">{(progress as { message?: string }).message}</Text></div>
          )}
        </>
      )}

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
    </div>
  )
}
