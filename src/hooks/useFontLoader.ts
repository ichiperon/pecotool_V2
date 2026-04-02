import { useEffect } from 'react';
import { usePecoStore } from '../store/pecoStore';

export function useFontLoader() {
  const { setFontBytes, setFontLoaded } = usePecoStore();

  useEffect(() => {
    async function loadFont() {
      try {
        const res = await fetch('/fonts/IPAexGothic.ttf');
        if (res.ok) {
          const bytes = await res.arrayBuffer();
          setFontBytes(bytes);
          console.log('[useFontLoader] Font loaded successfully');
        } else {
          console.error('[useFontLoader] Failed to fetch font: status', res.status);
          setFontLoaded(false);
        }
      } catch (err) {
        console.error('[useFontLoader] Error loading font:', err);
        setFontLoaded(false);
      }
    }

    loadFont();
  }, [setFontBytes, setFontLoaded]);
}
