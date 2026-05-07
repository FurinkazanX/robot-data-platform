import { useEffect, useRef, useState } from 'react'
import {
  Alert, AutoComplete, Button, Col, Divider, Form, Modal,
  Progress, Row, Select, Space, Switch, Table, Tag, Typography, message,
} from 'antd'
import { InfoCircleOutlined, StopOutlined } from '@ant-design/icons'
import FileBrowser from '../components/FileBrowser'
import {
  getConverters, previewFile, startConversion, cancelConversion, listAllJobs,
  type PreviewResult, type FileItem,
} from '../api/client'
import { useAppContext } from '../context/AppContext'

const { Title, Text, Paragraph } = Typography

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

export default function Convert() {
  const { convert, setConvert } = useAppContext()
  const [converters, setConverters] = useState<Array<{ key: string; name: string }>>([])
  const [selectedConverter, setSelectedConverter] = useState('hdf5->lerobot')
  const [srcFiles, setSrcFiles] = useState<FileItem[]>([])
  const [dstPath, setDstPath] = useState('')
  const [incremental, setIncremental] = useState(false)
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [mapping, setMapping] = useState<MappingRow[]>([])
  const [errorModal, setErrorModal] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)

  const { job } = convert
  const { jobId, progress, running } = job

  useEffect(() => {
    getConverters().then(list => setConverters(list.map(c => ({ key: c.key, name: c.name }))))
  }, [])

  // Reconnect WS if there's an active job on mount (e.g. page revisit or refresh)
  useEffect(() => {
    if (jobId && running && !wsRef.current) {
      connectWs(jobId)
      return
    }
    if (!jobId) {
      listAllJobs().then(jobs => {
        const active = jobs.find(j => j.job_type === 'convert' && j.status === 'running')
        if (active) {
          setConvert({ job: { jobId: active.job_id, progress: active as unknown as Record<string, unknown>, running: true } })
          connectWs(active.job_id)
        }
      }).catch(() => {})
    }
  }, [])

  const connectWs = (id: string) => {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${protocol}://${location.host}/api/convert/ws/${id}`)
    ws.onmessage = e => {
      const data = JSON.parse(e.data)
      if (data.ping) return
      setConvert({ job: { jobId: id, progress: data, running: data.status === 'running' } })
      if (data.status === 'done') message.success('转换完成！')
      if (data.status === 'failed') message.error('转换失败，请查看详情')
    }
    ws.onclose = () => {
      setConvert({ job: { ...convert.job, running: false } })
    }
    wsRef.current = ws
  }

  const handlePreview = async () => {
    if (!srcFiles.length) return message.warning('请先选择 HDF5 文件')
    const first = srcFiles.find(f => !f.is_dir)
    if (!first) return message.warning('请选择至少一个 HDF5 文件')
    try {
      const result = await previewFile(first.path)
      setPreview(result)
      setMapping(result.fields.map(f => ({
        hdf5_key: f.key,
        shape: f.shape.join('×'),
        dtype: f.dtype,
        is_image: f.is_image,
        lerobot_field: result.suggested_mapping[f.key] ?? '',
      })))
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      message.error('解析失败: ' + (detail ?? '请确认文件格式'))
    }
  }

  const handleConvert = async () => {
    if (!srcFiles.length) return message.warning('请选择源文件')
    if (!dstPath) return message.warning('请填写目标路径')
    const field_mapping: Record<string, string> = {}
    mapping.forEach(r => { if (r.lerobot_field) field_mapping[r.hdf5_key] = r.lerobot_field })

    try {
      const { job_id } = await startConversion({
        src_paths: srcFiles.filter(f => !f.is_dir).map(f => f.path),
        dst_path: dstPath,
        field_mapping,
        incremental,
      })
      setConvert({ job: { jobId: job_id, progress: {}, running: true } })
      connectWs(job_id)
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      message.error('启动失败: ' + (detail ?? '未知错误'))
    }
  }

  const handleStop = async () => {
    if (!jobId) return
    try {
      await cancelConversion(jobId)
      message.info('已发送停止指令，当前文件处理完成后停止')
    } catch {
      message.error('停止失败')
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
        <AutoComplete value={val} style={{ width: '100%' }} allowClear
          options={LEROBOT_FIELDS.map(f => ({ label: f, value: f }))}
          filterOption={(input, opt) => (opt?.value as string).toLowerCase().includes(input.toLowerCase())}
          onChange={v => setMapping(prev => prev.map((r, i) => i === idx ? { ...r, lerobot_field: v ?? '' } : r))}
        />
      ),
    },
  ]

  const pct = progress && typeof (progress as { percent?: number }).percent === 'number'
    ? (progress as { percent: number }).percent : 0
  const status = (progress as { status?: string }).status
  const errorText = (progress as { error?: string }).error ?? ''
  const isCancelled = status === 'cancelled'

  return (
    <div>
      <Title level={4}>数据转换</Title>

      <Form layout="vertical">
        <Form.Item label="转换类型">
          <Select value={selectedConverter} onChange={setSelectedConverter} style={{ width: 240 }}
            options={converters.map(c => ({ label: c.name, value: c.key }))} />
        </Form.Item>
      </Form>

      <Row gutter={24}>
        <Col span={12}>
          <FileBrowser title="源文件（选择 HDF5）" checkable filterExt={['.h5', '.hdf5']}
            onSelect={(_, items) => setSrcFiles(items)} />
          <Button style={{ marginTop: 8 }} onClick={handlePreview}>解析字段结构</Button>
        </Col>
        <Col span={12}>
          <FileBrowser title="目标数据集目录" dirOnly fileOps
            onSelect={(_, items) => setDstPath(items[0]?.path ?? '')} />
          {dstPath && (
            <Text type="secondary" style={{ display: 'block', marginTop: 4, fontSize: 12 }}>
              已选: {dstPath}
            </Text>
          )}
          <Form layout="vertical" style={{ marginTop: 12 }}>
            <Form.Item label="增量追加（保留已有 episode）">
              <Switch checked={incremental} onChange={setIncremental} />
            </Form.Item>
          </Form>
        </Col>
      </Row>

      {preview && (
        <>
          <Divider>字段映射配置（共 {preview.n_frames} 帧）</Divider>
          <Table dataSource={mapping} columns={mappingCols} rowKey="hdf5_key" size="small" pagination={false} />
        </>
      )}

      <Divider />
      <Space>
        <Button type="primary" loading={running} onClick={handleConvert} disabled={!srcFiles.length || !dstPath}>
          开始转换
        </Button>
        <Button danger icon={<StopOutlined />} onClick={handleStop}
          disabled={!running} hidden={!jobId}>
          停止转换
        </Button>
      </Space>

      {jobId && (
        <div style={{ marginTop: 16 }}>
          <Text type="secondary">任务 ID: {jobId}</Text>
          <Progress
            percent={pct}
            status={status === 'failed' ? 'exception' : status === 'done' ? 'success' : isCancelled ? 'exception' : 'active'}
            style={{ marginTop: 8 }}
          />
          {isCancelled && (
            <Alert type="warning" message="转换已取消" style={{ marginTop: 8 }} showIcon />
          )}
          {(progress as { message?: string }).message && (
            <div><Text type="secondary">{(progress as { message?: string }).message}</Text></div>
          )}
          {status === 'failed' && (
            <Alert
              type="error"
              message="转换失败"
              description={
                <Space direction="vertical" size="small">
                  <Text>{errorText.split('\n')[0]}</Text>
                  {errorText.includes('\n') && (
                    <Button size="small" icon={<InfoCircleOutlined />} onClick={() => setErrorModal(true)}>
                      查看详细错误
                    </Button>
                  )}
                </Space>
              }
              style={{ marginTop: 8 }}
            />
          )}
        </div>
      )}

      <Modal
        title="错误详情"
        open={errorModal}
        onCancel={() => setErrorModal(false)}
        footer={<Button onClick={() => setErrorModal(false)}>关闭</Button>}
        width={700}
      >
        <Paragraph>
          <pre style={{ background: '#f5f5f5', padding: 12, borderRadius: 6, overflow: 'auto', maxHeight: 400, fontSize: 12 }}>
            {errorText}
          </pre>
        </Paragraph>
      </Modal>
    </div>
  )
}
