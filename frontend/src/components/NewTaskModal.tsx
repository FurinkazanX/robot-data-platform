import { useEffect, useState } from 'react'
import {
  AutoComplete, Button, Col, Divider, Form, Input, InputNumber,
  Modal, Row, Select, Switch, Table, Tabs, Tag, Typography, message,
} from 'antd'
import { EyeOutlined } from '@ant-design/icons'
import FileManager from '../components/FileManager'
import {
  getConverters, previewFile, startConversion, startTransfer, testConnection,
  type FileItem, type PreviewResult,
} from '../api/client'

const { Text } = Typography

const LEROBOT_FIELDS = [
  'observation.state', 'action', 'timestamp',
  'observation.images.cam_main', 'observation.images.cam_wrist',
  'observation.images.cam_left', 'observation.images.cam_right',
]

interface MappingRow {
  hdf5_key: string; shape: string; dtype: string; is_image: boolean; lerobot_field: string
}

// ── Convert tab ───────────────────────────────────────────────────────────────

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
          <FileManager mode="local" title="源文件（选择 HDF5）" checkable filterExt={['.h5', '.hdf5']}
            onSelect={(_, items) => setSrcFiles(items)} />
          <Button icon={<EyeOutlined />} size="small" style={{ marginTop: 6 }} onClick={handlePreview}
            disabled={!srcFiles.length}>
            解析字段结构
          </Button>
        </Col>
        <Col span={12}>
          <FileManager mode="local" title="目标数据集目录" dirOnly
            onSelect={(_, items) => setDstDir(items[0] ?? null)} />
          {dstDir && (
            <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>已选: {dstDir.path}</Text>
          )}
        </Col>
      </Row>

      {preview && mapping.length > 0 && (
        <>
          <Divider style={{ margin: '12px 0' }}>字段映射（{preview.n_frames} 帧）</Divider>
          <Table dataSource={mapping} columns={mappingCols} rowKey="hdf5_key" size="small" pagination={false} />
        </>
      )}

      <Divider style={{ margin: '12px 0' }} />
      <Row align="middle" gutter={16}>
        <Col>
          <Form.Item label="增量追加" style={{ marginBottom: 0 }}>
            <Switch checked={incremental} onChange={setIncremental} />
          </Form.Item>
        </Col>
        <Col flex="auto" />
        <Col>
          <Button type="primary" loading={submitting}
            disabled={!srcFiles.length || !dstDir} onClick={handleStart}>
            开始转换
          </Button>
        </Col>
      </Row>
    </div>
  )
}

// ── Transfer tab ──────────────────────────────────────────────────────────────

function TransferForm({ onStarted }: { onStarted: () => void }) {
  const [creds, setCreds] = useState({ host: '', port: 22, username: '', password: '' })
  const [connecting, setConnecting] = useState(false)
  const [connected, setConnected] = useState(false)
  const [localFiles, setLocalFiles] = useState<FileItem[]>([])
  const [remoteBase, setRemoteBase] = useState('/')
  const [submitting, setSubmitting] = useState(false)

  const patch = (p: Partial<typeof creds>) => setCreds(prev => ({ ...prev, ...p }))

  const handleConnect = async () => {
    if (!creds.host || !creds.username) return message.warning('请填写主机和用户名')
    setConnecting(true)
    try {
      await testConnection(creds)
      setConnected(true)
      message.success('连接成功')
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      message.error('连接失败: ' + (detail ?? String(e)))
    } finally {
      setConnecting(false)
    }
  }

  const handleStart = async () => {
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
      onStarted()
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      message.error('启动失败: ' + (detail ?? '未知错误'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      <Form layout="inline" style={{ marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <Form.Item label="主机 IP">
          <Input value={creds.host} onChange={e => patch({ host: e.target.value })}
            placeholder="192.168.1.100" style={{ width: 150 }} />
        </Form.Item>
        <Form.Item label="端口">
          <InputNumber value={creds.port} onChange={v => patch({ port: v ?? 22 })} style={{ width: 70 }} />
        </Form.Item>
        <Form.Item label="用户名">
          <Input value={creds.username} onChange={e => patch({ username: e.target.value })} style={{ width: 110 }} />
        </Form.Item>
        <Form.Item label="密码">
          <Input.Password value={creds.password} onChange={e => patch({ password: e.target.value })} style={{ width: 120 }} />
        </Form.Item>
        <Form.Item>
          <Button type="primary" loading={connecting} onClick={handleConnect}>连接</Button>
          {connected && <Tag color="green" style={{ marginLeft: 8 }}>已连接</Tag>}
        </Form.Item>
      </Form>

      <Row gutter={16}>
        <Col span={12}>
          <FileManager mode="local" title="本地文件" checkable onSelect={(_, items) => setLocalFiles(items)} />
        </Col>
        <Col span={12}>
          <Form layout="vertical">
            <Form.Item label="远程目标目录">
              <Input value={remoteBase} onChange={e => setRemoteBase(e.target.value)}
                placeholder="/home/user/robot_data" />
            </Form.Item>
          </Form>
        </Col>
      </Row>

      <Divider style={{ margin: '12px 0' }} />
      <Row justify="end">
        <Button type="primary" loading={submitting}
          disabled={!connected || !localFiles.length} onClick={handleStart}>
          开始传输
        </Button>
      </Row>
    </div>
  )
}

// ── Modal wrapper ─────────────────────────────────────────────────────────────

export default function NewTaskModal({ open, onClose }: {
  open: boolean
  onClose: () => void
}) {
  const [tab, setTab] = useState('convert')

  const handleStarted = () => {
    onClose()
  }

  const items = [
    {
      key: 'convert',
      label: '数据转换',
      children: <ConvertForm onStarted={handleStarted} />,
    },
    {
      key: 'transfer',
      label: '文件传输',
      children: <TransferForm onStarted={handleStarted} />,
    },
  ]

  return (
    <Modal
      title="新建任务"
      open={open}
      onCancel={onClose}
      footer={null}
      width={920}
      styles={{ body: { maxHeight: '75vh', overflowY: 'auto', padding: '0 4px' } }}
      destroyOnClose
    >
      <Tabs activeKey={tab} onChange={setTab} items={items} />
    </Modal>
  )
}
