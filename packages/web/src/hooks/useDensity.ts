import { useEffect, useState } from 'react';
import type { Density } from '../components/FilterBar';

const STORE_DENSITY = 'strado:density';

// Row density (comfy/compact) is a device preference shared by the board and
// the Appearance settings section — one source of truth in localStorage.
export function useDensity(): [Density, (d: Density) => void] {
  const [density, setDensity] = useState<Density>(
    () => (localStorage.getItem(STORE_DENSITY) as Density | null) ?? 'comfy',
  );
  useEffect(() => {
    localStorage.setItem(STORE_DENSITY, density);
  }, [density]);
  return [density, setDensity];
}
