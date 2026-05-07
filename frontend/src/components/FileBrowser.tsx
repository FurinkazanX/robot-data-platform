import { useState, useEffect } from 'react'
import { Tree, Spin, Button, Dropdown, Modal, Form, Input, message } from 'antd'
import {
  FolderOutlined, FileOutlined, ReloadOutlined,
  FolderAddOutlined, EditOutlined, DeleteOutlined,
} from '@ant-design/icons'
import type { DataNode, EventDataNode } from 'antd/es/tree'
import type { MenuProps } from 'antd'
import { listFiles, localMkdir, localRename, localDelete, type FileItem } from '../api/client'

interface Props {
  onSelect?: (paths: string[], items: FileItem[]) => void
  checkable?: boolean
  filterExt?: string[]
  dirOnly?: boolean
  disabled?: boolean
  fileOps?: boolean   // enables right-click mkdir / rename / delete
  title?: string
}

interface LoadedNode extends DataNode {
  item: FileItem
  children?: LoadedNode[]
}

function toNode(item: FileItem): LoadedNode {
  return {
    key: item.path,
    title: item.name,
    isLeaf: !item.is_dir,
    item,
  }
}

// parent path of a relative path (returns '' for root-level items)
function parentPath(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx <= 0 ? '' : path.slice(0, idx)
}

export default function FileBrowser({
  onSelect, checkable = false, filterExt, dirOnly, disabled, fileOps, title,
}: Props) {
  const [treeData, setTreeData] = useState<LoadedNode[]>([])
  const [loading, setLoading] = useState(false)
  const [checkedKeys, setCheckedKeys] = useState<string[]>([])
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])

  // file-ops modal state
  const [ctxNode, setCtxNode] = useState<LoadedNode | null>(null)
  const [mkdirModal, setMkdirModal] = useState(false)
  const [renameModal, setRenameModal] = useState(false)
  const [mkdirName, setMkdirName] = useState('')
  const [renameName, setRenameName] = useState('')
  const [opLoading, setOpLoading] = useState(false)

  const applyFilter = (items: FileItem[]) =>
    items
      .filter(i => !filterExt || i.is_dir || (i.ext && filterExt.includes(i.ext)))
      .filter(i => !dirOnly || i.is_dir)

  const loadRoot = async () => {
    setLoading(true)
    try {
      const { items } = await listFiles()
      setTreeData(applyFilter(items).map(toNode))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadRoot() }, [])

  const findItem = (nodes: LoadedNode[], key: string): FileItem | undefined => {
    for (const n of nodes) {
      if (n.key === key) return n.item
      if (n.children) {
        const r = findItem(n.children, key)
        if (r) return r
      }
    }
  }

  const updateNode = (nodes: LoadedNode[], key: string, children: LoadedNode[]): LoadedNode[] =>
    nodes.map(n => {
      if (n.key === key) return { ...n, children }
      if (n.children) return { ...n, children: updateNode(n.children, key, children) }
      return n
    })

  // Reload the subtree at `dirPath` (or root if empty)
  const refreshDir = async (dirPath: string) => {
    if (!dirPath) {
      await loadRoot()
      return
    }
    const { items } = await listFiles(dirPath)
    setTreeData(prev => updateNode(prev, dirPath, applyFilter(items).map(toNode)))
  }

  const onLoadData = async ({ key }: { key: string }) => {
    const { items } = await listFiles(key)
    setTreeData(prev => updateNode(prev, key, applyFilter(items).map(toNode)))
  }

  // ── Selection ─────────────────────────────────────────────────────────────

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

  // ── File operations ───────────────────────────────────────────────────────

  const handleMkdir = async () => {
    const name = mkdirName.trim()
    if (!name) return
    // create inside ctxNode (if it's a dir) or at the parent of ctxNode
    const base = ctxNode?.item.is_dir
      ? ctxNode.item.path
      : ctxNode ? parentPath(ctxNode.item.path) : ''
    const newPath = base ? `${base}/${name}` : name
    setOpLoading(true)
    try {
      await localMkdir(newPath)
      message.success('目录已创建')
      setMkdirModal(false)
      setMkdirName('')
      await refreshDir(base)
    } catch (e: unknown) {
      message.error('创建失败: ' + (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail)
    } finally {
      setOpLoading(false)
    }
  }

  const handleRename = async () => {
    if (!ctxNode || !renameName.trim()) return
    setOpLoading(true)
    try {
      await localRename(ctxNode.item.path, renameName.trim())
      message.success('重命名成功')
      setRenameModal(false)
      await refreshDir(parentPath(ctxNode.item.path))
    } catch (e: unknown) {
      message.error('重命名失败: ' + (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail)
    } finally {
      setOpLoading(false)
    }
  }

  const handleDelete = (node: LoadedNode) => {
    Modal.confirm({
      title: `确认删除 "${node.item.name}"？`,
      content: node.item.is_dir ? '将递归删除目录及其所有内容' : '文件将被永久删除',
      okType: 'danger',
      okText: '删除',
      cancelText: '取消',
      onOk: async () => {
        try {
          await localDelete(node.item.path)
          message.success('已删除')
          await refreshDir(parentPath(node.item.path))
        } catch (e: unknown) {
          message.error('删除失败: ' + (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail)
        }
      },
    })
  }

  const contextMenu = (node: LoadedNode): MenuProps['items'] => [
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

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8, gap: 8 }}>
        {title && <span style={{ fontWeight: 500 }}>{title}</span>}
        <Button size="small" icon={<ReloadOutlined />} onClick={loadRoot} />
        {fileOps && (
          <Button
            size="small"
            icon={<FolderAddOutlined />}
            title="在根目录新建目录"
            onClick={() => { setCtxNode(null); setMkdirName(''); setMkdirModal(true) }}
          />
        )}
      </div>

      {loading ? <Spin /> : (
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
            const n = node as unknown as LoadedNode
            const isSelected = selectedKeys.includes(n.key as string)
            const inner = (
              <span
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  background: isSelected && dirOnly ? '#e6f4ff' : 'transparent',
                  borderRadius: 4, padding: '0 4px', cursor: 'pointer',
                }}
                onClick={dirOnly && n.item?.is_dir ? (e) => {
                  e.stopPropagation()
                  selectByKey(n.key as string)
                } : undefined}
              >
                {n.item?.is_dir
                  ? <FolderOutlined style={{ color: '#faad14', flexShrink: 0 }} />
                  : <FileOutlined style={{ flexShrink: 0 }} />}
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {typeof n.title === 'string' ? n.title : String(n.key)}
                </span>
              </span>
            )
            if (!fileOps) return inner
            return (
              <Dropdown menu={{ items: contextMenu(n) }} trigger={['contextMenu']}>
                {inner}
              </Dropdown>
            )
          }}
          style={{ maxHeight: 400, overflow: 'auto', border: '1px solid #d9d9d9', borderRadius: 6, padding: 8 }}
        />
      )}

      {/* New directory modal */}
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
                : '在根目录新建'
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
