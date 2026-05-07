import { useState, useEffect } from 'react'
import { Tree, Spin, Button } from 'antd'
import { FolderOutlined, FileOutlined, ReloadOutlined } from '@ant-design/icons'
import type { DataNode, EventDataNode } from 'antd/es/tree'
import { listFiles, type FileItem } from '../api/client'

interface Props {
  onSelect?: (paths: string[], items: FileItem[]) => void
  checkable?: boolean
  filterExt?: string[]
  dirOnly?: boolean
  disabled?: boolean
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

export default function FileBrowser({ onSelect, checkable = false, filterExt, dirOnly, disabled, title }: Props) {
  const [treeData, setTreeData] = useState<LoadedNode[]>([])
  const [loading, setLoading] = useState(false)
  const [checkedKeys, setCheckedKeys] = useState<string[]>([])
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])

  const loadRoot = async () => {
    setLoading(true)
    try {
      const { items } = await listFiles()
      const nodes = items
        .filter(i => !filterExt || i.is_dir || (i.ext && filterExt.includes(i.ext)))
        .filter(i => !dirOnly || i.is_dir)
        .map(toNode)
      setTreeData(nodes)
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

  const onLoadData = async ({ key }: { key: string }) => {
    const { items } = await listFiles(key)
    const children = items
      .filter(i => !filterExt || i.is_dir || (i.ext && filterExt.includes(i.ext)))
      .filter(i => !dirOnly || i.is_dir)
      .map(toNode)
    setTreeData(prev => updateNode(prev, key, children))
  }

  // checkbox mode
  const handleCheck = (keys: string[] | { checked: string[] }) => {
    const flat = Array.isArray(keys) ? keys : keys.checked
    setCheckedKeys(flat)
    if (onSelect) {
      const items = flat.map(k => findItem(treeData, k)).filter(Boolean) as FileItem[]
      onSelect(flat, items)
    }
  }

  // single-click mode (non-checkable)
  const handleSelect = (_: string[], info: { selectedNodes: EventDataNode<DataNode>[] }) => {
    if (checkable) return
    const nodes = info.selectedNodes as unknown as LoadedNode[]
    if (!nodes.length) return
    const node = nodes[0]
    setSelectedKeys([node.key as string])
    if (onSelect) {
      onSelect([node.key as string], [node.item])
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8, gap: 8 }}>
        {title && <span style={{ fontWeight: 500 }}>{title}</span>}
        <Button size="small" icon={<ReloadOutlined />} onClick={loadRoot} />
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
            return (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                {n.item?.is_dir
                  ? <FolderOutlined style={{ color: '#faad14', flexShrink: 0 }} />
                  : <FileOutlined style={{ flexShrink: 0 }} />}
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {typeof n.title === 'string' ? n.title : String(n.key)}
                </span>
              </span>
            )
          }}
          style={{ maxHeight: 400, overflow: 'auto', border: '1px solid #d9d9d9', borderRadius: 6, padding: 8 }}
        />
      )}
    </div>
  )
}
