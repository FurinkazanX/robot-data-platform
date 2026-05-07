import { useEffect, useRef, useState } from 'react'
import {
  Alert, Badge, Button, Col, Divider, Form, Row, Select,
  Space, Table, Tag, Tooltip, Typography, message,
} from 'antd'
import {
  EyeOutlined, PauseCircleOutlined, PlayCircleOutlined,
} from '@ant-design/icons'
import FileBrowser from '../components/FileBrowser'
import {
  getConverters, listFiles, previewFile,
  startMonitor, stopMonitor, getMonitorStatus,
  type FileItem, type PreviewResult,
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

interface LogEntry {
  timestamp: string
  type: string
  message: string
}

export default function Monitor() {
  const [converters, setConverters] = useState<Array<{ key: string; name: string }>>([])
  const [selectedConverter, setSelectedConverter] = useState('hdf5->lerobot')
  const [sourceDir, setSourceDir] = useState<FileItem | null>(null)
  const [targetDir, setTargetDir] = useState<FileItem | null>(null)
  const [mapping, setMapping] = useState<MappingRow[]>([])
  const [preview, setPreview] = useState<PreviewResult | null>(null)

  const [state, setState] = useState<'idle' | 'monitoring'>('idle')
  const [isConverting, setIsConverting] = useState(false)
  const [logs, setLogs] = useState<LogEntry[]>([])

  const wsRef = useRef<WebSocket | null>(null)
  const logEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    getConverters().then(list => setConverters(list.map(c => ({ key: c.key, name: c.name }))))
    // Sync state from server (e.g. after page refresh)
    getMonitorStatus().then(s => {
      setState(s.state as 'idle' | 'monitoring')
      setIsConverting(s.is_converting)
      if (s.state === 'monitoring') connectWs()
    }).catch(() => {})
  }, [])

  // Auto-scroll log to bottom
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  const connectWs = () => {
    if (wsRef.current) return
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${protocol}://${location.host}/api/monitor/ws`)
    ws.onmessage = e => {
      const data = JSON.parse(e.data)
      if (data.type === 'ping') return
      setLogs(prev => [...prev, {
        timestamp: data.timestamp ?? new Date().toISOString(),
        type: data.type ?? 'info',
        message: data.message ?? '',
      }])
      if (data.state !== undefined) setState(data.state)
      if (data.is_converting !== undefined) setIsConverting(data.is_converting)
    }
    ws.onclose = () => { wsRef.current = null }
    wsRef.current = ws
  }

  const disconnectWs = () => {
    wsRef.current?.close()
    wsRef.current = null
  }

  const handlePreviewDir = async () => {
    if (!sourceDir) return message.warning('请先选择监控目录')
    try {
      const { items } = await listFiles(sourceDir.path)
      const hdf5File = items.find(f => !f.is_dir && (f.ext === '.hdf5' || f.ext === '.h5'))
      if (!hdf5File) {
        message.warning('目录中暂无 HDF5 文件，将在监控时自动检测字段映射')
        return
      }
      const result = await previewFile(hdf5File.path)
      setPreview(result)
      setMapping(result.fields.map(f => ({
        hdf5_key: f.key,
        shape: f.shape.join('×'),
        dtype: f.dtype,
        is_image: f.is_image,
        lerobot_field: result.suggested_mapping[f.key] ?? '',
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

    try {
      const [srcFmt, tgtFmt] = selectedConverter.split('->')
      await startMonitor({
        source_dir: sourceDir.path,
        target_dir: targetDir.path,
        field_mapping,
        source_format: srcFmt,
        target_format: tgtFmt,
      })
      setLogs([])
      setState('monitoring')
      connectWs()
      message.success('监控已启动')
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      message.error('启动失败: ' + (detail ?? '未知错误'))
    }
  }

  const handleStop = async () => {
    try {
      await stopMonitor()
      disconnectWs()
      setState('idle')
      setIsConverting(false)
      message.success('监控已停止')
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      message.error(detail ?? '停止失败')
    }
  }

  const mappingCols = [
    { title: 'HDF5 字段', dataIndex: 'hdf5_key', width: 220 },
    { title: '形状', dataIndex: 'shape', width: 110 },
    { title: '类型', dataIndex: 'dtype', width: 90 },
    { title: '图像', dataIndex: 'is_image', width: 55, render: (v: boolean) => v ? <Tag color="blue">是</Tag> : null },
    {
      title: 'LeRobot 字段',
      dataIndex: 'lerobot_field',
      render: (val: string, _: MappingRow, idx: number) => (
        <Select value={val} style={{ width: '100%' }} allowClear showSearch
          options={LEROBOT_FIELDS.map(f => ({ label: f, value: f }))}
          onChange={v => setMapping(prev => prev.map((r, i) => i === idx ? { ...r, lerobot_field: v ?? '' } : r))}
        />
      ),
    },
  ]

  const logTagColor: Record<string, string> = {
    info: 'blue', done: 'green', error: 'red',
    warning: 'orange', converting: 'processing', detected: 'purple', progress: 'default',
  }

  const stopDisabled = isConverting || state === 'idle'

  return (
    <div>
      <Title level={4}>数据监控转换</Title>

      {/* Status badge */}
      <div style={{ marginBottom: 16 }}>
        {state === 'monitoring' ? (
          <Badge status="processing" text={
            isConverting
              ? <Text type="warning">监控中（正在转换…）</Text>
              : <Text type="success">监控中（等待新文件）</Text>
          } />
        ) : (
          <Badge status="default" text={<Text type="secondary">未监控</Text>} />
        )}
      </div>

      {/* Config section */}
      <Form layout="vertical">
        <Form.Item label="转换类型">
          <Select value={selectedConverter} onChange={setSelectedConverter} style={{ width: 240 }}
            options={converters.map(c => ({ label: c.name, value: c.key }))}
            disabled={state === 'monitoring'} />
        </Form.Item>
      </Form>

      <Row gutter={24}>
        <Col span={12}>
          <FileBrowser
            title="监控目录（源数据）"
            dirOnly
            onSelect={(_, items) => setSourceDir(items[0] ?? null)}
            disabled={state === 'monitoring'}
          />
          {sourceDir && (
            <Text type="secondary" style={{ display: 'block', marginTop: 4, fontSize: 12 }}>
              已选: {sourceDir.path}
            </Text>
          )}
          <Button
            icon={<EyeOutlined />}
            style={{ marginTop: 8 }}
            onClick={handlePreviewDir}
            disabled={!sourceDir || state === 'monitoring'}
          >
            自动检测字段映射
          </Button>
        </Col>
        <Col span={12}>
          <FileBrowser
            title="目标目录（输出数据集）"
            dirOnly
            onSelect={(_, items) => setTargetDir(items[0] ?? null)}
            disabled={state === 'monitoring'}
          />
          {targetDir && (
            <Text type="secondary" style={{ display: 'block', marginTop: 4, fontSize: 12 }}>
              已选: {targetDir.path}
            </Text>
          )}
        </Col>
      </Row>

      {preview && mapping.length > 0 && (
        <>
          <Divider>字段映射配置（来自样本文件，共 {preview.n_frames} 帧）</Divider>
          <Table
            dataSource={mapping}
            columns={mappingCols}
            rowKey="hdf5_key"
            size="small"
            pagination={false}
          />
          <Alert
            type="info"
            showIcon
            message="此映射将用于所有新检测到的文件。若目录中暂无文件，将在首个文件到达时自动检测。"
            style={{ marginTop: 8 }}
          />
        </>
      )}

      {!preview && (
        <Alert
          type="info"
          showIcon
          message="未配置字段映射 — 系统将在每个新文件到达时自动推断字段映射。建议提前选择样本文件进行配置以确保准确性。"
          style={{ marginTop: 16 }}
        />
      )}

      {/* Control buttons */}
      <Divider />
      <Space>
        <Button
          type="primary"
          icon={<PlayCircleOutlined />}
          onClick={handleStart}
          disabled={state === 'monitoring' || !sourceDir || !targetDir}
        >
          开始监控
        </Button>

        <Tooltip
          title={isConverting ? '正在转换数据，转换完成后才能停止监控' : ''}
          open={isConverting ? undefined : false}
        >
          <Button
            danger
            icon={<PauseCircleOutlined />}
            onClick={handleStop}
            disabled={stopDisabled}
          >
            停止监控
          </Button>
        </Tooltip>
      </Space>

      {/* Event log */}
      {logs.length > 0 && (
        <>
          <Divider>实时日志</Divider>
          <div style={{
            background: '#141414',
            borderRadius: 6,
            padding: '12px 16px',
            maxHeight: 340,
            overflowY: 'auto',
            fontFamily: 'monospace',
            fontSize: 12,
          }}>
            {logs.map((log, i) => (
              <div key={i} style={{ marginBottom: 4, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <Text style={{ color: '#666', whiteSpace: 'nowrap', fontSize: 11 }}>
                  {log.timestamp.replace('T', ' ').slice(0, 19)}
                </Text>
                <Tag color={logTagColor[log.type] ?? 'default'} style={{ margin: 0, flexShrink: 0 }}>
                  {log.type}
                </Tag>
                <Text style={{ color: '#d4d4d4', wordBreak: 'break-all' }}>{log.message}</Text>
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        </>
      )}
    </div>
  )
}
