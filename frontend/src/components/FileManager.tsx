import { useEffect, useState } from 'react'
import {
  Button, Dropdown, Form, Input, InputNumber,
  Modal, Spin, Tag, Tree, message,
} from 'antd'
import {
  DeleteOutlined, EditOutlined, FileOutlined, FolderAddOutlined,
  FolderOutlined, LinkOutlined, ReloadOutlined,
} from '@ant-design/icons'
import type { DataNode, EventDataNode } from 'antd/es/tree'
import type { MenuProps } from 'antd'
import {
  listFiles, localMkdir, localRename, localDelete,
  listRemote, remoteMkdir, remoteRename, remoteDelete, testConnection,
  type FileItem, type SSHCreds,
} from '../api/client'

export interface FileManagerProps {
  mode: 'local' | 'remote'
  initialCreds?: SSHCreds
  onSelect?: (paths: string[], items: FileItem[]) => void
  onConnect?: (creds: SSHCreds) => void
  checkable?: boolean
  filterExt?: string[]
  dirOnly?: boolean
  fileOps?: boolean
  height?: number
  title?: string
  disabled?: boolean
}

interface TreeNode extends DataNode {
  item: FileItem
  children?: TreeNode[]
}

function toNode(item: FileItem): TreeNode {
  return { key: item.path, title: item.name, isLeaf: !item.is_dir, item }
}

function parentPath(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx <= 0 ? '' : path.slice(0, idx)
}

export default function FileManager({
  mode,
  initialCreds,
  onSelect,
  onConnect,
  checkable = false,
  filterExt,
  dirOnly,
  fileOps = true,
  height = 360,
  title,
  disabled,
}: FileManagerProps) {
  const isRemote = mode === 'remote'

  const [treeData, setTreeData] = useState<TreeNode[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])
  const [checkedKeys, setCheckedKeys] = useState<string[]>([])

  // CRUD modal state
  const [ctxNode, setCtxNode] = useState<TreeNode | null>(null)
  const [mkdirModal, setMkdirModal] = useState(false)
  const [renameModal, setRenameModal] = useState(false)
  const [mkdirName, setMkdirName] = useState('')
  const [renameName, setRenameName] = useState('')
  const [opLoading, setOpLoading] = useState(false)

  // Remote-only state
  const [creds, setCreds] = useState<SSHCreds>(
    initialCreds ?? { host: '', port: 22, username: '', password: '' }
  )
  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [remotePath, setRemotePath] = useState('/')

  // ── Helpers ────────────────────────────────────────────────────────────────

  const applyFilter = (items: FileItem[]): FileItem[] =>
    items
      .filter(i => !filterExt || i.is_dir || (i.ext && filterExt.includes(i.ext)))
      .filter(i => !dirOnly || i.is_dir)

  const findItem = (nodes: TreeNode[], key: string): FileItem | undefined => {
    for (const n of nodes) {
      if (n.key === key) return n.item
      if (n.children) {
        const r = findItem(n.children, key)
        if (r) return r
      }
    }
  }

  const updateNode = (nodes: TreeNode[], key: string, children: TreeNode[]): TreeNode[] =>
    nodes.map(n => {
      if (n.key === key) return { ...n, children }
      if (n.children) return { ...n, children: updateNode(n.children, key, children) }
      return n
    })

  // ── Local ──────────────────────────────────────────────────────────────────

  const loadLocalRoot = async () => {
    setLoading(true)
    try {
      const { items } = await listFiles()
      setTreeData(applyFilter(items).map(toNode))
    } finally {
      setLoading(false)
    }
  }

  const refreshLocalDir = async (dirPath: string) => {
    if (!dirPath) { await loadLocalRoot(); return }
    const { items } = await listFiles(dirPath)
    setTreeData(prev => updateNode(prev, dirPath, applyFilter(items).map(toNode)))
  }

  // ── Remote ─────────────────────────────────────────────────────────────────

  const loadRemoteDir = async (c: SSHCreds, path: string): Promise<TreeNode[]> => {
    const { items } = await listRemote(c, path)
    return applyFilter(items).map(toNode)
  }

  const loadRemoteRoot = async (c: SSHCreds, path: string) => {
    setLoading(true)
    try {
      setTreeData(await loadRemoteDir(c, path))
    } catch {
      setTreeData([])
    } finally {
      setLoading(false)
    }
  }

  const handleConnect = async () => {
    if (!creds.host || !creds.username) { message.warning('请填写主机和用户名'); return }
    setConnecting(true)
    try {
      await testConnection(creds)
      await loadRemoteRoot(creds, '/')
      setRemotePath('/')
      setConnected(true)
      onConnect?.(creds)
      message.success('连接成功')
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      message.error('连接失败: ' + (detail ?? String(e)))
    } finally {
      setConnecting(false)
    }
  }

  const handleDisconnect = () => {
    setConnected(false)
    setTreeData([])
    setSelectedKeys([])
    setCheckedKeys([])
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!isRemote) loadLocalRoot()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Tree lazy load ─────────────────────────────────────────────────────────

  const onLoadData = async ({ key }: { key: string }) => {
    if (isRemote) {
      const children = await loadRemoteDir(creds, key as string)
      setTreeData(prev => updateNode(prev, key as string, children))
    } else {
      const { items } = await listFiles(key as string)
      setTreeData(prev => updateNode(prev, key as string, applyFilter(items).map(toNode)))
    }
  }

  // ── Selection ──────────────────────────────────────────────────────────────

  const selectByKey = (key: string) => {
    const item = findItem(treeData, key)
    if (!item) return
    setSelectedKeys([key])
    onSelect?.([key], [item])
  }

  const handleCheck = (keys: string[] | { checked: string[] }) => {
    const flat = Array.isArray(keys) ? keys : keys.checked
    setCheckedKeys(flat)
    if (onSelect) {
      const items = flat.map(k => findItem(treeData, k)).filter(Boolean) as FileItem[]
      onSelect(flat, items)
    }
  }

  const handleSelect = (_: string[], info: { selected: boolean; node: EventDataNode<DataNode> }) => {
    if (checkable) return
    if (!info.selected) { setSelectedKeys([]); return }
    selectByKey(info.node.key as string)
  }

  // ── CRUD ───────────────────────────────────────────────────────────────────

  const errMsg = (e: unknown) =>
    (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? String(e)

  const handleMkdir = async () => {
    const name = mkdirName.trim()
    if (!name) return
    const base = ctxNode?.item.is_dir
      ? ctxNode.item.path
      : ctxNode ? parentPath(ctxNode.item.path) : (isRemote ? remotePath.replace(/\/$/, '') : '')
    const newPath = base ? `${base.replace(/\/$/, '')}/${name}` : name
    setOpLoading(true)
    try {
      if (isRemote) {
        await remoteMkdir(creds, newPath)
        await loadRemoteRoot(creds, remotePath)
      } else {
        await localMkdir(newPath)
        await refreshLocalDir(base)
      }
      message.success('目录已创建')
      setMkdirModal(false)
      setMkdirName('')
    } catch (e) {
      message.error('创建失败: ' + errMsg(e))
    } finally {
      setOpLoading(false)
    }
  }

  const handleRename = async () => {
    if (!ctxNode || !renameName.trim()) return
    setOpLoading(true)
    try {
      if (isRemote) {
        const dir = ctxNode.item.path.substring(0, ctxNode.item.path.lastIndexOf('/')) || '/'
        await remoteRename(creds, ctxNode.item.path, `${dir}/${renameName.trim()}`)
        await loadRemoteRoot(creds, remotePath)
      } else {
        await localRename(ctxNode.item.path, renameName.trim())
        await refreshLocalDir(parentPath(ctxNode.item.path))
      }
      message.success('重命名成功')
      setRenameModal(false)
    } catch (e) {
      message.error('重命名失败: ' + errMsg(e))
    } finally {
      setOpLoading(false)
    }
  }

  const handleDelete = (node: TreeNode) => {
    const snapCreds = creds
    const snapPath = remotePath
    Modal.confirm({
      title: `确认删除 "${node.item.name}"？`,
      content: node.item.is_dir ? '将递归删除目录及其所有内容' : '文件将被永久删除',
      okType: 'danger',
      okText: '删除',
      cancelText: '取消',
      onOk: async () => {
        try {
          if (isRemote) {
            await remoteDelete(snapCreds, node.item.path)
            await loadRemoteRoot(snapCreds, snapPath)
          } else {
            await localDelete(node.item.path)
            await refreshLocalDir(parentPath(node.item.path))
          }
          message.success('已删除')
        } catch (e) {
          message.error('删除失败: ' + errMsg(e))
        }
      },
    })
  }

  const contextMenu = (node: TreeNode): MenuProps['items'] => [
    {
      key: 'mkdir',
      icon: <FolderAddOutlined />,
      label: node.item.is_dir ? '在此新建目录' : '在同级新建目录',
      onClick: () => { setCtxNode(node); setMkdirName(''); setMkdirModal(true) },
    },
    {
      key: 'rename',
      icon: <EditOutlined />,
      label: '重命名',
      onClick: () => { setCtxNode(node); setRenameName(node.item.name); setRenameModal(true) },
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

  // ── Render ─────────────────────────────────────────────────────────────────

  const showTree = !isRemote || connected

  return (
    <div>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8, gap: 6, flexWrap: 'wrap' }}>
        {title && <span style={{ fontWeight: 500 }}>{title}</span>}

        {!isRemote && (
          <>
            <Button size="small" icon={<ReloadOutlined />} onClick={loadLocalRoot} />
            {fileOps && (
              <Button
                size="small"
                icon={<FolderAddOutlined />}
                title="在根目录新建目录"
                onClick={() => { setCtxNode(null); setMkdirName(''); setMkdirModal(true) }}
              />
            )}
          </>
        )}

        {isRemote && connected && (
          <>
            <Input
              size="small"
              value={remotePath}
              onChange={e => setRemotePath(e.target.value)}
              onPressEnter={() => loadRemoteRoot(creds, remotePath)}
              style={{ width: 180 }}
              placeholder="/home/user/data"
            />
            <Button size="small" icon={<ReloadOutlined />} onClick={() => loadRemoteRoot(creds, remotePath)} />
            {fileOps && (
              <Button
                size="small"
                icon={<FolderAddOutlined />}
                title="在当前路径新建目录"
                onClick={() => { setCtxNode(null); setMkdirName(''); setMkdirModal(true) }}
              />
            )}
            <Tag color="green">已连接</Tag>
            <Button size="small" onClick={handleDisconnect}>断开</Button>
          </>
        )}
      </div>

      {/* SSH form (remote, not yet connected) */}
      {isRemote && !connected && (
        <Form layout="inline" style={{ marginBottom: 8, flexWrap: 'wrap', gap: 4 }}>
          <Form.Item label="主机">
            <Input
              size="small"
              value={creds.host}
              onChange={e => setCreds(prev => ({ ...prev, host: e.target.value }))}
              placeholder="192.168.1.100"
              style={{ width: 140 }}
            />
          </Form.Item>
          <Form.Item label="端口">
            <InputNumber
              size="small"
              value={creds.port ?? 22}
              onChange={v => setCreds(prev => ({ ...prev, port: v ?? 22 }))}
              style={{ width: 70 }}
            />
          </Form.Item>
          <Form.Item label="用户名">
            <Input
              size="small"
              value={creds.username}
              onChange={e => setCreds(prev => ({ ...prev, username: e.target.value }))}
              style={{ width: 110 }}
            />
          </Form.Item>
          <Form.Item label="密码">
            <Input.Password
              size="small"
              value={creds.password ?? ''}
              onChange={e => setCreds(prev => ({ ...prev, password: e.target.value }))}
              style={{ width: 120 }}
            />
          </Form.Item>
          <Form.Item>
            <Button
              type="primary"
              size="small"
              icon={<LinkOutlined />}
              loading={connecting}
              onClick={handleConnect}
            >
              连接
            </Button>
          </Form.Item>
        </Form>
      )}

      {/* Tree */}
      {loading ? (
        <div style={{ padding: 24, textAlign: 'center' }}><Spin /></div>
      ) : showTree ? (
        <div style={{
          maxHeight: height,
          overflow: 'auto',
          border: '1px solid #d9d9d9',
          borderRadius: 6,
          padding: 8,
        }}>
          <Tree
            checkable={checkable}
            disabled={disabled}
            loadData={onLoadData as never}
            treeData={treeData as DataNode[]}
            checkedKeys={checkedKeys}
            selectedKeys={selectedKeys}
            onCheck={handleCheck as never}
            onSelect={handleSelect as never}
            titleRender={node => {
              const n = node as unknown as TreeNode
              const isSelected = selectedKeys.includes(n.key as string)
              const inner = (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    whiteSpace: 'nowrap',
                    background: isSelected && dirOnly ? '#e6f4ff' : 'transparent',
                    borderRadius: 4,
                    padding: '0 4px',
                    cursor: 'pointer',
                  }}
                  onClick={dirOnly && n.item?.is_dir ? (e) => {
                    e.stopPropagation()
                    selectByKey(n.key as string)
                  } : undefined}
                >
                  {n.item?.is_dir
                    ? <FolderOutlined style={{ color: '#faad14', flexShrink: 0 }} />
                    : <FileOutlined style={{ flexShrink: 0 }} />}
                  <span>{typeof n.title === 'string' ? n.title : String(n.key)}</span>
                </span>
              )
              if (!fileOps) return inner
              return (
                <Dropdown menu={{ items: contextMenu(n) }} trigger={['contextMenu']}>
                  {inner}
                </Dropdown>
              )
            }}
          />
        </div>
      ) : (
        <div style={{
          padding: 24, color: '#999',
          border: '1px dashed #d9d9d9', borderRadius: 6, textAlign: 'center',
        }}>
          请连接远程服务器
        </div>
      )}

      {/* New-directory modal */}
      <Modal
        title="新建目录"
        open={mkdirModal}
        onOk={handleMkdir}
        onCancel={() => setMkdirModal(false)}
        okText="创建"
        confirmLoading={opLoading}
      >
        <Form layout="vertical">
          <Form.Item label={
            ctxNode?.item.is_dir
              ? `在 "${ctxNode.item.name}" 内新建`
              : ctxNode
                ? `在 "${parentPath(ctxNode.item.path) || '根目录'}" 内新建`
                : isRemote ? `在 "${remotePath}" 内新建` : '在根目录新建'
          }>
            <Input
              value={mkdirName}
              onChange={e => setMkdirName(e.target.value)}
              placeholder="目录名称"
              onPressEnter={handleMkdir}
              autoFocus
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* Rename modal */}
      <Modal
        title="重命名"
        open={renameModal}
        onOk={handleRename}
        onCancel={() => setRenameModal(false)}
        okText="确认"
        confirmLoading={opLoading}
      >
        <Form layout="vertical">
          <Form.Item label="新名称">
            <Input
              value={renameName}
              onChange={e => setRenameName(e.target.value)}
              onPressEnter={handleRename}
              autoFocus
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
