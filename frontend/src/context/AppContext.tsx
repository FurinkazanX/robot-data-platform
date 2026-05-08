import { createContext, useContext, useState, ReactNode } from 'react'
import type { FileItem, SSHCreds } from '../api/client'

interface JobState {
  jobId: string
  progress: Record<string, unknown>
  running: boolean
}

interface TransferState {
  creds: SSHCreds
  connected: boolean
  remoteNodes: unknown[]
  remoteBase: string
  remotePath: string
  localFiles: FileItem[]
  job: JobState
}

interface MonitorSSHState {
  creds: SSHCreds
  connected: boolean
  remoteNodes: unknown[]
  remotePath: string
  remoteBase: string
}

interface ConvertState {
  job: JobState
}

interface AppState {
  transfer: TransferState
  setTransfer: (update: Partial<TransferState>) => void
  monitorSSH: MonitorSSHState
  setMonitorSSH: (update: Partial<MonitorSSHState>) => void
  convert: ConvertState
  setConvert: (update: Partial<ConvertState>) => void
}

const defaultJob: JobState = { jobId: '', progress: {}, running: false }

const defaultTransfer: TransferState = {
  creds: { host: '', username: '', password: '', port: 22 },
  connected: false,
  remoteNodes: [],
  remoteBase: '/',
  remotePath: '/',
  localFiles: [],
  job: defaultJob,
}

const defaultMonitorSSH: MonitorSSHState = {
  creds: { host: '', username: '', password: '', port: 22 },
  connected: false,
  remoteNodes: [],
  remotePath: '/',
  remoteBase: '/',
}

const defaultConvert: ConvertState = { job: defaultJob }

const AppContext = createContext<AppState>({
  transfer: defaultTransfer,
  setTransfer: () => {},
  monitorSSH: defaultMonitorSSH,
  setMonitorSSH: () => {},
  convert: defaultConvert,
  setConvert: () => {},
})

export function AppProvider({ children }: { children: ReactNode }) {
  const [transfer, setTransferState] = useState<TransferState>(defaultTransfer)
  const [monitorSSH, setMonitorSSHState] = useState<MonitorSSHState>(defaultMonitorSSH)
  const [convert, setConvertState] = useState<ConvertState>(defaultConvert)

  const setTransfer = (update: Partial<TransferState>) =>
    setTransferState(prev => ({ ...prev, ...update }))

  const setMonitorSSH = (update: Partial<MonitorSSHState>) =>
    setMonitorSSHState(prev => ({ ...prev, ...update }))

  const setConvert = (update: Partial<ConvertState>) =>
    setConvertState(prev => ({ ...prev, ...update }))

  return (
    <AppContext.Provider value={{ transfer, setTransfer, monitorSSH, setMonitorSSH, convert, setConvert }}>
      {children}
    </AppContext.Provider>
  )
}

export const useAppContext = () => useContext(AppContext)
