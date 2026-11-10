import { useEffect, useState } from 'react'
import { isNarrow, NARROW_QUERY } from '../ui/controls'

/** true en ventanas estrechas (< 900 px), donde la barra lateral es un cajón. */
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(isNarrow)
  useEffect(() => {
    const media = window.matchMedia(NARROW_QUERY)
    const update = () => setNarrow(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return narrow
}
