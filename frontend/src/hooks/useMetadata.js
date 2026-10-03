// src/hooks/useMetadata.js
import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchMetadata as apiFetchMetadata } from '../api';
import tnGeoJson from '../data/tamilnadu_districts.json';

const normalize = (s = '') => String(s).trim().toLowerCase().replace(/\s+/g, ' ');

const DISTRICT_ALIASES = {
  'thiruvallur': 'Tiruvallur',
  'tiruvallur': 'Tiruvallur',
  'thoothukudi': 'Thoothukudi',
  'tuticorin': 'Thoothukudi',
  'kancheepuram': 'Kanchipuram',
  'kanchipuram': 'Kanchipuram',
  'theni': 'Theni',
  'dindigul': 'Dindigul',
  'chengalpattu': 'Chengalpattu',
  'krishnagiri': 'Krishnagiri',
  'kanniyakumari': 'Kanyakumari',
  'kanyakumari': 'Kanyakumari',
  'tiruchirappalli': 'Tiruchirappalli',
  'trichy': 'Tiruchirappalli',
  'tirunelveli': 'Tirunelveli',
  'virudhunagar': 'Virudhunagar',
  'the nilgiris': 'The Nilgiris',
  'nilgiris': 'The Nilgiris',
  'pudukkottai': 'Pudukkottai',
  'ariyalur': 'Ariyalur',
  'perambalur': 'Perambalur',
  'cuddalore': 'Cuddalore',
  'tiruppur': 'Tiruppur',
  'erode': 'Erode',
  'coimbatore': 'Coimbatore',
  'madurai': 'Madurai',
  'salem': 'Salem',
  'namakkal': 'Namakkal',
  'thanjavur': 'Thanjavur',
  'thiruvarur': 'Tiruvarur',
  'tiruvarur': 'Tiruvarur',
  'nagapattinam': 'Nagapattinam',
  'karur': 'Karur',
  'vellore': 'Vellore',
  'ranipet': 'Ranipet',
  'tirupathur': 'Tirupathur',
  'thiruvannamalai': 'Tiruvannamalai',
  'tiruvannamalai': 'Tiruvannamalai',
  'kallakurichi': 'Kallakurichi',
  'villupuram': 'Viluppuram',
  '平码': 'Viluppuram',
  '公开视频': 'Viluppuram',
  'viluppuram': 'Viluppuram',
  'chennai': 'Chennai',
  'tenkasi': 'Tenkasi',
  'mayiladuthurai': 'Mayiladuthurai',
};

const canon = (name) => {
  const key = normalize(name);
  return DISTRICT_ALIASES[key] || String(name || '').trim();
};

const DEFAULT_DISEASES = ['COVID-19', 'Dengue', 'Malaria', 'Influenza'];

const geoJsonDistricts = (() => {
  try {
    const names = tnGeoJson.features.map((f) =>
      canon(
        f?.properties?.NAME_2 ??
        f?.properties?.District ??
        f?.properties?.NAME ??
        f?.properties?.name ??
        ''
      )
    );
    return Array.from(new Set(names.filter(Boolean))).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
})();

// ---------- Hook ----------
export default function useMetadata() {
  const [metadata, setMetadata] = useState({
    diseases: [],
    districts: [],
    existing_combinations: [], // [{ disease, district }]
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const buildFromBackend = (payload) => {
    const diseasesRaw = Array.isArray(payload?.diseases) ? payload.diseases : [];
    const districtsRaw = Array.isArray(payload?.districts) ? payload.districts : [];
    const combosRaw = Array.isArray(payload?.existing_combinations) ? payload.existing_combinations : [];

    // Canonicalize & dedupe districts
    const backendDistricts = Array.from(
      new Set(
        districtsRaw
          .map(canon)
          .filter(Boolean)
      )
    );

    // Merge backend districts with GeoJSON fallback
    const mergedDistricts = Array.from(
      new Set([...backendDistricts, ...geoJsonDistricts])
    ).sort((a, b) => a.localeCompare(b));

    // Diseases: if backend empty, use defaults
    const diseases = (diseasesRaw.length ? diseasesRaw : DEFAULT_DISEASES)
      .map((d) => String(d || '').trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));

    // Canonicalize existing combinations too (district names)
    const existing = combosRaw
      .map((c) => ({
        disease: String(c?.disease || c?._id?.disease || '').trim(),
        district: canon(c?.district || c?._id?.district || ''),
      }))
      .filter((x) => x.disease && x.district);

    return { diseases, districts: mergedDistricts, existing_combinations: existing };
  };

  const buildFallback = () => ({
    diseases: [...DEFAULT_DISEASES],
    districts: [...geoJsonDistricts],
    existing_combinations: [],
  });

  const fetchAll = async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await apiFetchMetadata(); // GET /metadata
      const built = buildFromBackend(payload || {});
      if (!mounted.current) return;
      setMetadata(built);
    } catch (err) {
      console.warn('useMetadata: falling back to static data:', err);
      if (!mounted.current) return;
      setMetadata(buildFallback());
      setError(err);
    } finally {
      if (mounted.current) setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
  }, []);
  const refresh = fetchAll;
  const existingMap = useMemo(() => {
    const map = new Map();
    for (const c of metadata.existing_combinations) {
      map.set(`${c.disease}::${c.district}`, true);
    }
    return map;
  }, [metadata.existing_combinations]);

  return { metadata, loading, error, refresh, existingMap };
}
export function useDiseases() {
  const { metadata, loading, error, refresh } = useMetadata();
  return { diseases: metadata.diseases, loading, error, refresh };
}

export function useDistricts() {
  const { metadata, loading, error, refresh } = useMetadata();
  return { districts: metadata.districts, loading, error, refresh };
}