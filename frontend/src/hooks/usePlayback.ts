import { Dispatch, SetStateAction, useEffect, useRef, useState } from 'react'

interface UsePlaybackReturn {
  currentFrame: number
  setCurrentFrame: Dispatch<SetStateAction<number>>
  playing: boolean
  setPlaying: Dispatch<SetStateAction<boolean>>
  fps: number
  setFps: (v: number) => void
}

export function usePlayback(totalFrames: number, initialFps = 10): UsePlaybackReturn {
  const [currentFrame, setCurrentFrame] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [fps, setFps] = useState(initialFps)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current)
    if (!playing) return
    intervalRef.current = setInterval(() => {
      setCurrentFrame(prev => {
        if (prev >= totalFrames - 1) { setPlaying(false); return prev }
        return prev + 1
      })
    }, 1000 / fps)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [playing, fps, totalFrames])

  return { currentFrame, setCurrentFrame, playing, setPlaying, fps, setFps }
}
