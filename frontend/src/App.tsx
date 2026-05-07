import { BrowserRouter, Link, Route, Routes, useLocation } from 'react-router-dom'
import { Layout, Menu } from 'antd'
import { SwapOutlined, CloudUploadOutlined, PlayCircleOutlined, EyeOutlined } from '@ant-design/icons'
import Convert from './pages/Convert'
import Transfer from './pages/Transfer'
import Visualize from './pages/Visualize'
import Monitor from './pages/Monitor'
import { AppProvider } from './context/AppContext'

const { Header, Content, Sider } = Layout

const NAV = [
  { key: '/convert', icon: <SwapOutlined />, label: <Link to="/convert">数据转换</Link> },
  { key: '/transfer', icon: <CloudUploadOutlined />, label: <Link to="/transfer">文件传输</Link> },
  { key: '/visualize', icon: <PlayCircleOutlined />, label: <Link to="/visualize">数据可视化</Link> },
  { key: '/monitor', icon: <EyeOutlined />, label: <Link to="/monitor">数据监控</Link> },
]

function AppLayout() {
  const loc = useLocation()
  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header style={{ display: 'flex', alignItems: 'center', padding: '0 24px' }}>
        <span style={{ color: '#fff', fontSize: 18, fontWeight: 600, marginRight: 40 }}>
          机器人数据平台
        </span>
      </Header>
      <Layout>
        <Sider width={200} theme="light">
          <Menu
            mode="inline"
            selectedKeys={[loc.pathname]}
            style={{ height: '100%', borderRight: 0 }}
            items={NAV}
          />
        </Sider>
        <Layout style={{ padding: '24px' }}>
          <Content style={{ background: '#fff', padding: 24, borderRadius: 8, minHeight: 360 }}>
            <Routes>
              <Route path="/" element={<Convert />} />
              <Route path="/convert" element={<Convert />} />
              <Route path="/transfer" element={<Transfer />} />
              <Route path="/visualize" element={<Visualize />} />
              <Route path="/monitor" element={<Monitor />} />
            </Routes>
          </Content>
        </Layout>
      </Layout>
    </Layout>
  )
}

export default function App() {
  return (
    <AppProvider>
      <BrowserRouter>
        <AppLayout />
      </BrowserRouter>
    </AppProvider>
  )
}
