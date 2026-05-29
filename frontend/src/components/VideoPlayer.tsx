import { useEffect, useRef, useState } from 'react'
import { Spin, Typography } from 'antd'
import {
  getFrameUrl, getVideoUrl, cacheRemoteVideo, getCachedVideoUrl,
  type SSHCreds,
} from '../api/client'

const { Text } = Typography

export type DataFormat = 'lerobot' | 'hdf5' | 'unknown'
export type DataSource = 'local' | 'remote'

interface Props {
  path: string
  episode: number
  cameras: string[]
  format: DataFormat
  currentFrame: number
  datasetFps: number
  dataSource?: DataSource
  creds?: SSHCreds
  imgHeight?: number
  style?: React.CSSProperties
}

export default function VideoPlayer({
  path, episode, cameras, format, currentFrame, datasetFps,
  dataSource = 'local', creds, imgHeight = 240, style,
}: Props) {
  const useVideo = format === 'lerobot'
  const videoRefs = useRef<Map<string, HTMLVideoElement>>(new Map())
  const [videoUrls, setVideoUrls] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [imgErrors, setImgErrors] = useState<Record<string, boolean>>({})

  // Load video URLs once per path/episode change
  useEffect(() => {
    if (!useVideo || cameras.length === 0) return
    setVideoUrls({})
    if (dataSource === 'local') {
      const urls: Record<string, string> = {}
      cameras.forEach(cam => { urls[cam] = getVideoUrl(path, episode, cam) })
      setVideoUrls(urls)
    } else if (dataSource === 'remote' && creds) {
      setLoading(true)
      Promise.all(
        cameras.map(cam =>
          cacheRemoteVideo(creds, path, episode, cam)
            .then(({ token }) => [cam, getCachedVideoUrl(token)] as [string, string])
            .catch(() => [cam, ''] as [string, string])
        )
      ).then(entries => {
        setVideoUrls(Object.fromEntries(entries))
        setLoading(false)
      })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, episode, format, dataSource, cameras.join(',')])

  // Seek all videos when frame changes
  useEffect(() => {
    if (!useVideo) return
    const target = currentFrame / datasetFps
    videoRefs.current.forEach(vid => {
      if (vid && vid.readyState >= 1) {
        if (Math.abs(vid.currentTime - target) > 0.5 / datasetFps)
          vid.currentTime = target
      }
    })
  }, [currentFrame, datasetFps, useVideo])

  // Reset img errors when episode/path changes
  useEffect(() => { setImgErrors({}) }, [path, episode])

  if (cameras.length === 0) return null

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, ...style }}>
      {cameras.map(cam => (
        <div key={cam} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          {useVideo ? (
            loading || !videoUrls[cam] ? (
              <div style={{
                width: 320, height: imgHeight, display: 'flex',
                alignItems: 'center', justifyContent: 'center', background: '#000',
              }}>
                <Spin />
              </div>
            ) : (
              <video
                ref={el => { el ? videoRefs.current.set(cam, el) : videoRefs.current.delete(cam) }}
                src={videoUrls[cam]}
                preload="auto"
                muted
                style={{ maxHeight: imgHeight, maxWidth: '100%', background: '#000', display: 'block' }}
              />
            )
          ) : imgErrors[cam] ? (
            <div style={{
              width: 320, height: imgHeight, display: 'flex',
              alignItems: 'center', justifyContent: 'center',
              background: '#1a1a1a', color: '#666', fontSize: 12,
            }}>
              图像加载失败
            </div>
          ) : (
            <img
              src={getFrameUrl(path, episode, currentFrame, cam)}
              alt={cam}
              style={{ maxHeight: imgHeight, maxWidth: '100%', background: '#000', display: 'block' }}
              onError={() => setImgErrors(prev => ({ ...prev, [cam]: true }))}
            />
          )}
          <Text style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{cam}</Text>
        </div>
      ))}
    </div>
  )
}
