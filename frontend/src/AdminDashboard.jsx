// frontend/src/AdminDashboard.jsx
import React, { useEffect, useMemo, useState } from 'react';
import {
  Container,
  Title,
  Text,
  Card,
  Button,
  Grid,
  Divider,
  Loader,
  Notification,
  Group,
  TextInput,
  Badge,
  Select,
  Alert,
  Table,
  Pagination,
  Tabs,
} from '@mantine/core';
import { IconCheck, IconAlertCircle, IconRefresh, IconSearch } from '@tabler/icons-react';
import axios from 'axios';

// API helpers from inside src/
import { fetchForecast, fetchMetadata } from './api';
import ForecastChart from './components/ForecastChart';
import MapChoropleth from './components/MapChoropleth';

// --- Base URLs (override via .env) ---
const NODE_API = (process.env.REACT_APP_NODE_API_URL || 'http://127.0.0.1:5000').trim();  // approvals and hospitals
const FASTAPI  = (process.env.REACT_APP_API_URL      || 'http://127.0.0.1:8000').trim();  // alerts and forecasts

// axios instances
const nodeClient = axios.create({ baseURL: NODE_API, timeout: 15000, headers: { 'Content-Type': 'application/json' } });
const fastClient = axios.create({ baseURL: FASTAPI,  timeout: 15000, headers: { 'Content-Type': 'application/json' } });

// Search predicate
function bySearch(q) {
  const s = (q || '').trim().toLowerCase();
  if (!s) return () => true;
  return (h) =>
    (h?.name || '').toLowerCase().includes(s) ||
    (h?.username || '').toLowerCase().includes(s) ||
    (h?.hospitalId || '').toLowerCase().includes(s);
}

// Choose the most reliable key to address a hospital on the backend
const hospitalKey = (h) => (h?.hospitalId || h?.username || h?._id || '').toString();

// Compute stats from already-filtered patient rows
function computeHospitalStatsFromPatients(patients) {
  const diseases = {};
  const districts = new Set();
  let latest = null;

  for (const p of patients || []) {
    const d = String(p.disease || '').trim();
    const dist = String(p.district || '').trim();
    if (d) diseases[d] = (diseases[d] || 0) + 1;
    if (dist) districts.add(dist);

    const t = p.diagnosisDate ? new Date(p.diagnosisDate) : null;
    if (t && (!latest || t > latest)) latest = t;
  }

  const diseaseList = Object.entries(diseases)
    .sort((a, b) => b[1] - a[1])
    .map(([name, total]) => ({ name, total }));

  return {
    diseaseList,
    districts: Array.from(districts).sort(),
    totalPatients: (patients || []).length,
    lastReportAt: latest ? latest.toISOString() : null,
  };
}

export default function AdminDashboard() {
  // very light client-side banner; real auth is enforced server-side
  let user = null;
  try { user = JSON.parse(localStorage.getItem('user') || 'null'); } catch {}
  const isAdmin = !!user && user.role === 'admin';

  // approvals
  const [pendingUsers, setPendingUsers] = useState([]);
  const [loadingPending, setLoadingPending] = useState(false);

  // approved list and search
  const [approvedHospitals, setApprovedHospitals] = useState([]);
  const [loadingApproved, setLoadingApproved] = useState(false);
  const [search, setSearch] = useState('');

  // selection and stats and patients
  const [selectedHospital, setSelectedHospital] = useState(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState('');
  const [hospitalStats, setHospitalStats] = useState(null);
  const [patients, setPatients] = useState([]);
  const [patientsLoading, setPatientsLoading] = useState(false);
  const [patientsError, setPatientsError] = useState('');

  // selectors for per-hospital forecast
  const [selDisease, setSelDisease] = useState('');
  const [selDistrict, setSelDistrict] = useState('');

  // forecast (per-hospital selection)
  const [fc, setFc] = useState(null);
  const [fcLoading, setFcLoading] = useState(false);
  const [fcError, setFcError] = useState(null);

  // alerts panel state
  const [meta, setMeta] = useState({ diseases: [], districts: [] });
  const [alDisease, setAlDisease] = useState('');
  const [alDistrict, setAlDistrict] = useState('');
  const [alSinceDays, setAlSinceDays] = useState('30');
  const [alLimit, setAlLimit] = useState(10);
  const [alPage, setAlPage] = useState(1);
  const [alerts, setAlerts] = useState([]);
  const [alertsTotal, setAlertsTotal] = useState(0);
  const [alertsLoading, setAlertsLoading] = useState(false);
  const [alertsError, setAlertsError] = useState('');

  // Global Forecast Explorer (public-like)
  const [gDisease, setGDisease] = useState('');
  const [gDistrict, setGDistrict] = useState('');
  const [gForecast, setGForecast] = useState(null);
  const [gLoading, setGLoading] = useState(false);
  const [gError, setGError] = useState(null);

  // toast
  const [notification, setNotification] = useState({ type: '', message: '' });

  const handleLogout = () => {
    localStorage.removeItem('user');
    window.location.href = '/';
  };

  // --- Node API calls ---
  async function fetchPendingHospitals() {
    setLoadingPending(true);
    try {
      const { data } = await nodeClient.get('/api/pending-hospitals');
      setPendingUsers(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Error fetching pending users:', err);
      setNotification({ type: 'error', message: 'Failed to load pending hospitals' });
    } finally {
      setLoadingPending(false);
    }
  }

  async function approveHospital(username) {
    try {
      await nodeClient.post(`/api/approve/${encodeURIComponent(username)}`);
      setNotification({ type: 'success', message: `✅ ${username} approved successfully!` });
      await Promise.all([fetchPendingHospitals(), fetchApprovedList()]);
    } catch (err) {
      console.error('Approval failed:', err);
      setNotification({ type: 'error', message: 'Approval failed' });
    }
  }

  async function fetchApprovedList() {
    setLoadingApproved(true);
    try {
      let data;

      // Preferred: /api/hospitals?status=approved
      try {
        ({ data } = await nodeClient.get('/api/hospitals', { params: { status: 'approved' } }));
      } catch {
        // Fallback 1: /api/hospitals (filter client-side)
        try {
          ({ data } = await nodeClient.get('/api/hospitals'));
          if (Array.isArray(data)) data = data.filter(h => (h.status || '').toLowerCase() === 'approved');
        } catch {
          // Fallback 2: /api/users?role=hospital (filter approved)
          ({ data } = await nodeClient.get('/api/users', { params: { role: 'hospital' } }));
          if (Array.isArray(data)) data = data.filter(u => (u.status || '').toLowerCase() === 'approved');
        }
      }

      setApprovedHospitals(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Error fetching hospitals:', err);
      setNotification({ type: 'error', message: 'Failed to load approved hospitals' });
    } finally {
      setLoadingApproved(false);
    }
  }

  // Load latest patient rows for a hospital (used both for display and as compute-fallback)
  async function loadPatients(h) {
    setPatientsError('');
    setPatients([]);
    if (!h) return;
    setPatientsLoading(true);
    try {
      const key = encodeURIComponent(hospitalKey(h));
      // Uses robust backend route that matches by _id | hospitalId | username
      const { data } = await nodeClient.get(`/api/hospital-patients/${key}`);
      setPatients(Array.isArray(data?.patients) ? data.patients : []);
    } catch (err) {
      console.error('Patients load failed:', err);
      setPatientsError(err?.response?.data?.error || 'Failed to load patient records');
    } finally {
      setPatientsLoading(false);
    }
  }

  async function fetchHospitalStats(h) {
    if (!h) return;
    setStatsError('');
    setStatsLoading(true);
    setHospitalStats(null);
    setSelDisease('');
    setSelDistrict('');
    try {
      const key = encodeURIComponent(hospitalKey(h));

      // Preferred aggregated stats route (if your node server exposes it)
      let stats;
      try {
        const { data } = await nodeClient.get(`/api/hospitals/${key}/stats`);
        stats = data;
      } catch {
        // Fallback: compute from already loaded patient rows
        if (!patients.length) {
          await loadPatients(h);
        }
        stats = computeHospitalStatsFromPatients(patients);
      }

      setHospitalStats(stats);

      // Auto-pick first options to trigger a forecast
      const firstDisease = stats?.diseaseList?.[0]?.name || '';
      const firstDistrict = stats?.districts?.[0] || '';
      setSelDisease(firstDisease);
      setSelDistrict(firstDistrict);

      if (firstDisease && firstDistrict) {
        await loadForecast(firstDisease, firstDistrict, false);
      }
    } catch (err) {
      console.error('Stats fetch/compute failed:', err);
      setStatsError(err?.response?.data?.error || 'Failed to load hospital stats');
    } finally {
      setStatsLoading(false);
    }
  }

  // --- FastAPI: Forecasts ---
  async function loadForecast(disease, district, force) {
    setFcError(null);
    setFcLoading(true);
    setFc(null);
    try {
      const data = await fetchForecast(disease, district, !!force);
      setFc(data);
    } catch (err) {
      console.error('Forecast error:', err);
      setFcError(err?.response?.data?.detail || err.message || 'Failed to fetch forecast');
    } finally {
      setFcLoading(false);
    }
  }

  async function loadGlobalForecast(disease, district, force) {
    setGError(null);
    setGLoading(true);
    setGForecast(null);
    try {
      const data = await fetchForecast(disease, district, !!force);
      setGForecast(data);
    } catch (err) {
      console.error('Global forecast error:', err);
      setGError(err?.response?.data?.detail || err.message || 'Failed to fetch forecast');
    } finally {
      setGLoading(false);
    }
  }

  // --- FastAPI: Alerts ---
  async function loadAlerts(page = 1) {
    setAlertsError('');
    setAlertsLoading(true);
    try {
      const skip = (page - 1) * alLimit;
      const params = {
        since_days: Number(alSinceDays || 30),
        limit: alLimit,
        skip,
        withTotal: true,
      };
      if (alDisease) params.disease = alDisease;
      if (alDistrict) params.district = alDistrict;

      const { data } = await fastClient.get('/alerts', { params });
      setAlerts(Array.isArray(data?.items) ? data.items : []);
      setAlertsTotal(Number(data?.total || 0));
      setAlPage(page);
    } catch (err) {
      console.error('Alerts load failed:', err);
      setAlertsError(err?.response?.data?.detail || 'Failed to load alerts');
    } finally {
      setAlertsLoading(false);
    }
  }

  // bootstrap: lists, metadata , alerts , init global explorer
  useEffect(() => {
    fetchPendingHospitals();
    fetchApprovedList();
    (async () => {
      try {
        const m = await fetchMetadata();
        const diseases = m?.diseases || [];
        const districts = m?.districts || [];
        setMeta({ diseases, districts });
        setGDisease(diseases[0] || '');
        setGDistrict(districts[0] || '');
      } catch {
        setMeta({ diseases: [], districts: [] });
      }
      loadAlerts(1);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // refresh alerts when filters change
  useEffect(() => {
    loadAlerts(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alDisease, alDistrict, alSinceDays, alLimit]);

  // reload forecast when hospital selectors change
  useEffect(() => {
    if (selDisease && selDistrict) {
      loadForecast(selDisease, selDistrict, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selDisease, selDistrict]);

  // reload global forecast when global selectors change
  useEffect(() => {
    if (gDisease && gDistrict) {
      loadGlobalForecast(gDisease, gDistrict, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gDisease, gDistrict]);

  const filteredHospitals = useMemo(
    () => approvedHospitals.filter(bySearch(search)),
    [approvedHospitals, search]
  );

  const alPages = Math.max(1, Math.ceil((alertsTotal || 0) / alLimit));

  return (
    <Container size="xl" mt="lg">
      {/* Header */}
      <Card shadow="md" radius="md" p="lg" withBorder>
        <Grid justify="space-between" align="center">
          <Grid.Col span={{ base: 12, sm: 6 }}>
            <Title order={2}>Admin Dashboard</Title>
            <Text c="dimmed" mt="sm">
              Approve hospitals and inspect reported diseases with live forecasts & alerts.
            </Text>
          </Grid.Col>
          <Grid.Col span={{ base: 12, sm: 6 }} style={{ textAlign: 'right' }}>
            <Button variant="outline" color="red" onClick={handleLogout}>
              Logout
            </Button>
          </Grid.Col>
        </Grid>
      </Card>

      <Divider my="lg" />

      {/* Alerts panel */}
      <Card shadow="sm" radius="md" p="lg" withBorder>
        <Group justify="space-between" mb="md">
          <Title order={4}>⚠ Alerts (last {alSinceDays} days)</Title>
          <Group>
            <Select
              placeholder="Disease (all)"
              data={meta.diseases.map((d) => ({ value: d, label: d }))}
              value={alDisease}
              onChange={setAlDisease}
              clearable
              searchable
              w={220}
            />
            <Select
              placeholder="District (all)"
              data={meta.districts.map((d) => ({ value: d, label: d }))}
              value={alDistrict}
              onChange={setAlDistrict}
              clearable
              searchable
              w={220}
            />
            <Select
              data={[
                { value: '7', label: '7 days' },
                { value: '14', label: '14 days' },
                { value: '30', label: '30 days' },
                { value: '60', label: '60 days' },
              ]}
              value={alSinceDays}
              onChange={setAlSinceDays}
              w={120}
            />
            <Select
              data={[
                { value: '10', label: '10 / page' },
                { value: '20', label: '20 / page' },
                { value: '50', label: '50 / page' },
              ]}
              value={String(alLimit)}
              onChange={(v) => setAlLimit(Number(v || 10))}
              w={130}
            />
            <Button variant="light" leftSection={<IconRefresh size={16} />} onClick={() => loadAlerts(alPage)}>
              Reload
            </Button>
          </Group>
        </Group>

        {alertsLoading ? (
          <Loader />
        ) : alertsError ? (
          <Alert color="red" icon={<IconAlertCircle size={16} />} variant="light">
            {alertsError}
          </Alert>
        ) : alerts.length === 0 ? (
          <Text size="sm" c="dimmed">No alerts in this window.</Text>
        ) : (
          <>
            <Table striped withTableBorder withColumnBorders highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Date</Table.Th>
                  <Table.Th>Disease</Table.Th>
                  <Table.Th>District</Table.Th>
                  <Table.Th ta="right">Today</Table.Th>
                  <Table.Th ta="right">Yesterday</Table.Th>
                  <Table.Th ta="right">% Change</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {alerts.map((a) => {
                  const id = a._id?.$oid || a._id || `${a.disease}-${a.district}-${a.date}`;
                  const date = a.date ? new Date(a.date).toLocaleDateString() : '—';

                  const today = Number(a.today ?? 0);
                  const yesterday = Number(a.yesterday ?? 0);
                  const pct = Number(a.pct_change ?? a.pctChange ?? 0);

                  // Friendly display: "New outbreak" when yesterday=0 and today>0
                  let displayValue;
                  let color = '#2f9e44'; // green default

                  if (yesterday === 0 && today > 0) {
                    displayValue = 'New outbreak';
                    color = '#e03131'; // red
                  } else if (yesterday === 0 && today === 0) {
                    displayValue = '—';
                  } else {
                    displayValue = `${pct.toFixed(1)}%`;
                    if (pct >= 30) color = '#e03131';      // red
                    else if (pct >= 15) color = '#d9480f'; // amber
                  }

                  return (
                    <Table.Tr key={id}>
                      <Table.Td>{date}</Table.Td>
                      <Table.Td>{a.disease}</Table.Td>
                      <Table.Td>{a.district}</Table.Td>
                      <Table.Td ta="right">{today}</Table.Td>
                      <Table.Td ta="right">{yesterday}</Table.Td>
                      <Table.Td ta="right" style={{ color }}>{displayValue}</Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>

            <Group justify="space-between" mt="md">
              <Text size="sm" c="dimmed">
                Showing {alerts.length} of {alertsTotal} alerts
              </Text>
              {alPages > 1 && (
                <Pagination value={alPage} onChange={(p) => loadAlerts(p)} total={alPages} />
              )}
            </Group>
          </>
        )}
      </Card>

      <Divider my="lg" />

      {/* Pending approvals */}
      <Card shadow="sm" radius="md" p="lg" withBorder>
        <Title order={4} mb="md">👥 Pending Hospital Approvals</Title>
        {loadingPending ? (
          <Loader />
        ) : pendingUsers.length === 0 ? (
          <Text size="sm" c="dimmed">No pending hospital accounts.</Text>
        ) : (
          pendingUsers.map((u) => (
            <Card key={u._id || u.username} withBorder shadow="xs" radius="md" p="md" mb="sm">
              <Group justify="space-between" align="center">
                <div>
                  <Group gap="xs">
                    <Text fw={600}>{u.name || u.username}</Text>
                    <Badge color="yellow" variant="light">{u.status || 'pending'}</Badge>
                  </Group>
                  <Text size="sm" c="dimmed">
                    Username: {u.username}{u.hospitalId ? ` • ID: ${u.hospitalId}` : ''}
                  </Text>
                </div>
                <Button size="xs" color="green" onClick={() => approveHospital(u.username)}>
                  Approve
                </Button>
              </Group>
            </Card>
          ))
        )}
      </Card>

      <Divider my="lg" />

      {/* Approved list + search */}
      <Card shadow="sm" radius="md" p="lg" withBorder>
        <Group justify="space-between" align="center" mb="md">
          <Title order={4}>🏥 Approved Hospitals</Title>
          <TextInput
            placeholder="Search by name, username or ID"
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            leftSection={<IconSearch size={16} />}
            w={320}
          />
        </Group>

        {loadingApproved ? (
          <Loader />
        ) : filteredHospitals.length === 0 ? (
          <Text size="sm" c="dimmed">No approved hospitals found.</Text>
        ) : (
          filteredHospitals.map((h) => (
            <Card
              key={h._id || h.hospitalId || h.username}
              withBorder
              shadow="xs"
              radius="md"
              p="md"
              mb="sm"
            >
              <Group justify="space-between" align="flex-start">
                <div>
                  <Group gap="xs">
                    <Text fw={600}>{h.name || h.username}</Text>
                    <Badge color="green" variant="light">approved</Badge>
                  </Group>
                  <Text size="sm" c="dimmed">
                    Username: {h.username} • ID: {h.hospitalId || h._id || '—'}
                  </Text>
                </div>
                <Button
                  size="xs"
                  onClick={async () => {
                    setSelectedHospital(h);
                    await loadPatients(h);        // load rows first
                    await fetchHospitalStats(h);  // then stats
                    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
                  }}
                >
                  View details
                </Button>
              </Group>
            </Card>
          ))
        )}
      </Card>

      {/* Hospital details & forecast */}
      {selectedHospital && (
        <>
          <Divider my="lg" />

          <Card shadow="md" radius="md" p="lg" withBorder>
            <Group justify="space-between" mb="xs">
              <Title order={4}>Hospital Details</Title>
              <Button variant="subtle" onClick={() => setSelectedHospital(null)}>Close</Button>
            </Group>

            <Text fw={600}>{selectedHospital.name || selectedHospital.username}</Text>
            <Text size="sm" c="dimmed" mb="md">
              Username: {selectedHospital.username} • ID: {selectedHospital.hospitalId || selectedHospital._id || '—'}
            </Text>

            {statsLoading ? (
              <Loader />
            ) : statsError ? (
              <Alert color="red" icon={<IconAlertCircle size={16} />} variant="light">
                {statsError}
              </Alert>
            ) : hospitalStats ? (
              <>
                <Group gap="md" mb="sm">
                  <Badge color="grape" variant="light">
                    Total patients: {hospitalStats.totalPatients ?? '—'}
                  </Badge>
                  <Badge color="blue" variant="light">
                    Diseases: {hospitalStats.diseaseList?.length ?? 0}
                  </Badge>
                  <Badge color="teal" variant="light">
                    Districts: {hospitalStats.districts?.length ?? 0}
                  </Badge>
                  {hospitalStats.lastReportAt && (
                    <Badge color="gray" variant="light">
                      Last report: {new Date(hospitalStats.lastReportAt).toLocaleString()}
                    </Badge>
                  )}
                </Group>

                <Grid gutter="md" mb="md">
                  <Grid.Col span={{ base: 12, sm: 6 }}>
                    <Select
                      label="Disease"
                      placeholder="Select disease"
                      searchable
                      data={(hospitalStats.diseaseList || []).map(d => ({ value: d.name, label: `${d.name} (${d.total})` }))}
                      value={selDisease}
                      onChange={setSelDisease}
                    />
                  </Grid.Col>
                  <Grid.Col span={{ base: 12, sm: 6 }}>
                    <Select
                      label="District"
                      placeholder="Select district"
                      searchable
                      data={(hospitalStats.districts || []).map(d => ({ value: d, label: d }))}
                      value={selDistrict}
                      onChange={setSelDistrict}
                    />
                  </Grid.Col>
                </Grid>

                <Group justify="space-between" align="center" mb="xs">
                  <Text fw={500}>
                    Forecast for <b>{selDisease || '—'}</b> in <b>{selDistrict || '—'}</b>
                  </Text>
                  <Button
                    size="xs"
                    leftSection={<IconRefresh size={16} />}
                    variant="light"
                    onClick={() => selDisease && selDistrict && loadForecast(selDisease, selDistrict, true)}
                    disabled={!selDisease || !selDistrict}
                  >
                    Refresh forecast
                  </Button>
                </Group>

                <Card withBorder radius="md" p="md">
                  <div style={{ minHeight: 320 }}>
                    <ForecastChart forecast={fc} loading={fcLoading} error={fcError} />
                  </div>
                </Card>

                <Divider my="md" />

                <Title order={5} mb="xs">Patient records (latest)</Title>
                {patientsLoading ? (
                  <Loader />
                ) : patientsError ? (
                  <Alert color="red" icon={<IconAlertCircle size={16} />} variant="light">
                    {patientsError}
                  </Alert>
                ) : patients.length === 0 ? (
                  <Text size="sm" c="dimmed">No patient records found for this hospital.</Text>
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <Table striped highlightOnHover withTableBorder withColumnBorders>
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>Date</Table.Th>
                          <Table.Th>Disease</Table.Th>
                          <Table.Th>District</Table.Th>
                          <Table.Th>Age</Table.Th>
                          <Table.Th>Gender</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {patients.slice(0, 50).map((p) => (
                          <Table.Tr key={p._id}>
                            <Table.Td>{p.diagnosisDate ? new Date(p.diagnosisDate).toLocaleDateString() : '—'}</Table.Td>
                            <Table.Td>{p.disease || '—'}</Table.Td>
                            <Table.Td>{p.district || '—'}</Table.Td>
                            <Table.Td>{p.age ?? '—'}</Table.Td>
                            <Table.Td>{p.gender || '—'}</Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                    {patients.length > 50 && (
                      <Text size="xs" c="dimmed" mt="xs">
                        Showing 50 of {patients.length} records (fetch limit: 1000).
                      </Text>
                    )}
                  </div>
                )}
              </>
            ) : (
              <Text size="sm" c="dimmed">No statistics available for this hospital.</Text>
            )}
          </Card>
        </>
      )}

      <Divider my="lg" />

      {/* 🌍 Global Forecast Explorer (mirrors Public dashboard) */}
      <Card shadow="sm" radius="md" p="lg" withBorder>
        <Title order={4} mb="md">🌍 Global Forecast Explorer</Title>

        <Grid gutter="md">
          <Grid.Col span={{ base: 12, sm: 6 }}>
            <Select
              label="Disease"
              placeholder="Select disease"
              searchable
              data={meta.diseases.map((d) => ({ value: d, label: d }))}
              value={gDisease}
              onChange={setGDisease}
            />
          </Grid.Col>
          <Grid.Col span={{ base: 12, sm: 6 }}>
            <Select
              label="District"
              placeholder="Select district"
              searchable
              data={meta.districts.map((d) => ({ value: d, label: d }))}
              value={gDistrict}
              onChange={setGDistrict}
            />
          </Grid.Col>
        </Grid>

        <Tabs defaultValue="map" mt="md">
          <Tabs.List grow>
            <Tabs.Tab value="map">🗺️ Map</Tabs.Tab>
            <Tabs.Tab value="forecast">Forecast</Tabs.Tab>
          </Tabs.List>

        <Tabs.Panel value="map" pt="md">
            <div style={{ height: 420 }}>
              {/* Selecting a district on map updates the selector */}
              <MapChoropleth forecast={gForecast} onSelectDistrict={setGDistrict} />
            </div>
          </Tabs.Panel>

          <Tabs.Panel value="forecast" pt="md">
            <div style={{ minHeight: 320 }}>
              <ForecastChart forecast={gForecast} loading={gLoading} error={gError} />
            </div>
          </Tabs.Panel>
        </Tabs>
      </Card>

      {/* toast */}
      {notification.message && (
        <Notification
          mt="md"
          color={notification.type === 'success' ? 'teal' : 'red'}
          icon={notification.type === 'success' ? <IconCheck size={16} /> : <IconAlertCircle size={16} />}
          onClose={() => setNotification({ type: '', message: '' })}
          withCloseButton
        >
          {notification.message}
        </Notification>
      )}

      {/* Admin gate (client-side hint; server still enforces) */}
      {!isAdmin && (
        <Alert mt="lg" color="red" icon={<IconAlertCircle size={16} />} variant="light">
          You are not logged in as an <b>admin</b>. Some actions may fail with 403 (server enforced).
        </Alert>
      )}
    </Container>
  );
}